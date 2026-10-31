//! The `pi_ipc` Tauri command: the single IPC entry the static frontend
//! calls (docs/migration/ipc-protocol.md). One request envelope in, one
//! response envelope out; stream subscriptions arrive as follow-up events
//! on the same call's channel from M2's session streams.
//!
//! Closed operation surface: the op table here is exhaustive — unknown
//! operations answer `unknown_op` without touching any session child.

use base64::Engine;
use resource_protocol::{ResourceRegistry, ResourceResponse};
use task_scheduler::TaskStore;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{Manager, State};

use management_host::{ManagementHost, ManagementSpawnConfig};
use session_host::SessionRegistry;

// Terminal output frames carry base64 inside JSON Channels today; the
// raw-bytes upgrade (protocol doc §4) lands with the M4 binary channel.

/// Protocol version (must match static-frontend/src/ipc/protocol.ts and
/// docs/migration/ipc-protocol.md).
pub const IPC_PROTOCOL_VERSION: i64 = 1;

/// The managed host state (one registry per app process). The registry and
/// version counter are Arc-backed so stream relays (the running-set stream)
/// outlive the request that opened them.
pub struct IpcHostState {
    pub registry: Arc<SessionRegistry>,
    /// The spawn base is resolved at host startup (the packaged pi
    /// executable and asset paths); identity operations answer before any
    /// child exists.
    pub spawn_base: Mutex<Option<SpawnBase>>,
    subscription_counter: AtomicU64,
    /// Live event-stream relays by subscription id (unsubscribe detaches).
    event_relays: Arc<Mutex<BTreeMap<String, EventRelayHandle>>>,
    /// Running-set relay THREADS alive right now (the thread-lifetime
    /// truth, distinct from `event_relays`, which the unsubscribe handler
    /// clears itself): a relay that ignores its stop flag would hold this
    /// count up — the leak the cancel contract (Terra P2-2) forbids, so the
    /// tests watch THIS counter, not the map, to prove the threads really
    /// end instead of merely being deregistered.
    running_relay_threads: Arc<AtomicUsize>,
    /// The terminal registry (portable-pty; crates/pty-host).
    pub terminals: Arc<pty_host::PtyHost>,
    terminal_streams: crate::terminal_host::TerminalStreams,
    terminal_management_lock: Mutex<()>,
    #[cfg(test)]
    terminal_test_shell: Mutex<Option<(PathBuf, Vec<String>)>>,
    /// The management instances (crates/management-host). The spawn config
    /// (packaged pi executable + the vendored management extension) is
    /// resolved at startup; until then the models ops answer
    /// management_unavailable rather than pretending.
    pub management: ManagementHost,
    pub management_config: Mutex<Option<ManagementSpawnConfig>>,
    /// The scheduled-task store root (the agent dir the host runs against).
    pub task_agent_dir: Mutex<Option<PathBuf>>,
    /// The preview resource registry (capability-less handles).
    pub resources: ResourceRegistry,
    /// The file access allow-list (the /api/files security boundary).
    pub file_roots: Mutex<crate::file_access::AllowedRoots>,
    /// Authorized save destinations (bound via native dialog selections).
    pub authorized_save_destinations: Mutex<HashMap<String, std::time::Instant>>,
    /// Per-cwd cache for files.index.
    pub file_index_cache: Mutex<HashMap<String, crate::file_resources::CachedFileIndex>>,
    /// Paths the HOST itself proposed (session cwds, project roots from the
    /// session index, artifact locations). resource grants only ever accept
    /// members of this set — the frontend cannot mint its own.
    proposed_paths: Mutex<BTreeSet<String>>,
    /// Git project identity with the TS resolver's TTL cache
    /// (lib/worktree.ts resolveProject).
    pub projects: crate::session_view::ProjectResolver,
    /// Private exported HTML directories, removed on eviction or host exit.
    pub(crate) session_exports: Mutex<std::collections::VecDeque<tempfile::TempDir>>,
    /// The catalogue's version counter (`invalidateSessionListCache` +
    /// `getSessionListVersion`): bumped by every host-visible mutation that
    /// changes the list a client holds (a create, a rename). Clients compare
    /// and refetch — the cross-window staleness contract.
    session_list_version: Arc<AtomicU64>,
    /// The bounded dispatch gate for the async entry
    /// ([`dispatch_envelope_gated`]); shared as an Arc so blocking tasks
    /// hold owned permits, never borrows of this state.
    dispatch_gate: Arc<tokio::sync::Semaphore>,
}

/// Handle that ends one event-stream relay thread on unsubscribe.
struct EventRelayHandle {
    stop: Arc<std::sync::atomic::AtomicBool>,
    /// The session subscriber id to detach (0 = none; snapshot-only relay).
    subscriber_id: u64,
    session_id: String,
}

impl IpcHostState {
    pub fn new() -> Self {
        let terminals = Arc::new(pty_host::PtyHost::new());
        Self {
            registry: Arc::new(SessionRegistry::new()),
            spawn_base: Mutex::new(resolve_session_spawn_base()),
            subscription_counter: AtomicU64::new(0),
            event_relays: Arc::new(Mutex::new(BTreeMap::new())),
            running_relay_threads: Arc::new(AtomicUsize::new(0)),
            terminal_streams: crate::terminal_host::TerminalStreams::new(Arc::clone(&terminals)),
            terminal_management_lock: Mutex::new(()),
            terminals,
            #[cfg(test)]
            terminal_test_shell: Mutex::new(None),
            management: ManagementHost::new(),
            management_config: Mutex::new(resolve_management_config()),
            task_agent_dir: Mutex::new(None),
            resources: ResourceRegistry::new(),
            file_roots: {
                let mut roots = crate::file_access::AllowedRoots::new();
                // The legacy default-cwd layouts stay browsable across
                // restarts (the /api/files scan behavior).
                if let Some(home) = std::env::var_os("HOME") {
                    roots.add_default_cwd_roots(Path::new(&home));
                }
                Mutex::new(roots)
            },
            authorized_save_destinations: Mutex::new(HashMap::new()),
            file_index_cache: Mutex::new(HashMap::new()),
            proposed_paths: Mutex::new(BTreeSet::new()),
            projects: crate::session_view::ProjectResolver::new(),
            session_exports: Mutex::new(std::collections::VecDeque::new()),
            session_list_version: Arc::new(AtomicU64::new(1)),
            dispatch_gate: Arc::new(tokio::sync::Semaphore::new(IPC_MAX_CONCURRENT_DISPATCH)),
        }
    }

    /// Authorize a destination for desktop.saveFile (e.g. from dialog selection).
    pub fn authorize_save_destination(&self, path: &Path, ttl: Duration) {
        let normalized = path.to_string_lossy().replace('\\', "/");
        self.authorized_save_destinations
            .lock()
            .unwrap()
            .insert(normalized, std::time::Instant::now() + ttl);
    }

    /// Whether a destination is currently authorized.
    pub fn is_authorized_save_destination(&self, path: &Path) -> bool {
        let normalized = path.to_string_lossy().replace('\\', "/");
        let mut map = self.authorized_save_destinations.lock().unwrap();
        let now = std::time::Instant::now();
        map.retain(|_, expires_at| *expires_at > now);
        map.contains_key(&normalized)
    }

    /// Consume (single-use) an authorized save destination.
    pub fn consume_authorized_save_destination(&self, path: &Path) -> bool {
        let normalized = path.to_string_lossy().replace('\\', "/");
        let mut map = self.authorized_save_destinations.lock().unwrap();
        let now = std::time::Instant::now();
        map.retain(|_, expires_at| *expires_at > now);
        map.remove(&normalized).is_some()
    }

    /// Record a path the HOST derived (a session cwd or project root from
    /// the index scan). Such paths become grantable resources and, for
    /// directories, browsable file roots — the /api/files semantics where
    /// roots derive from session data, never from a client-supplied path.
    pub fn propose_path(&self, path: &Path) {
        let text = path.to_string_lossy().into_owned();
        self.proposed_paths.lock().unwrap().insert(text.clone());
        if path.is_dir() {
            self.file_roots.lock().unwrap().add(path);
        }
    }

    /// Whether the host itself proposed this exact path.
    fn is_proposed(&self, path: &str) -> bool {
        self.proposed_paths.lock().unwrap().contains(path)
    }

    /// The agent dir this host runs against (sessions.list, the task store).
    pub fn agent_dir(&self) -> PathBuf {
        self.task_agent_dir
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(default_agent_dir)
    }

    /// The current catalogue version (the client's staleness check).
    pub fn session_list_version(&self) -> u64 {
        self.session_list_version.load(Ordering::SeqCst)
    }
}

/// Bump the catalogue version (a list-changing mutation happened).
fn bump_session_list_version(state: &IpcHostState) -> u64 {
    let version = state.session_list_version.fetch_add(1, Ordering::SeqCst) + 1;
    // The catalogue version rides the running stream's frames: wake the
    // relay so a rename (or any list change) reaches subscribers at once —
    // the stream no longer samples on a cadence that would catch it.
    state.registry.running_signal().notify();
    version
}

/// The pi executable the host spawns (lib/pi-rpc/factory.ts's resolution,
/// minus the PATH fallthrough: a Rust host must name an absolute binary —
/// an implicit PATH lookup would make the packaged app depend on the
/// machine's PATH, which the desktop bundle never does).
fn resolve_pi_executable() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PI_CLI_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let exe_name = if cfg!(windows) { "pi.exe" } else { "pi" };
    // The packaged layout: <resources>/pi/<exe> (desktop:prepare stages the
    // whole distribution there). Resolved relative to the executable.
    let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    if let Some(exe_dir) = exe_dir {
        // macOS .app layout: <app>/Contents/MacOS/<exe> → resources sit in
        // <app>/Contents/Resources/pi.
        let candidates = [
            exe_dir.join("pi").join(exe_name),
            exe_dir.join("../Resources/pi").join(exe_name),
            exe_dir.join("../../resources/pi").join(exe_name),
        ];
        for candidate in candidates {
            if let Ok(resolved) = candidate.canonicalize() {
                if resolved.is_file() {
                    return Some(resolved);
                }
            }
        }
    }
    // The dev checkout (cargo test / tauri dev from src-tauri).
    let dev = Path::new("..").join("resources").join("pi").join(exe_name);
    if let Ok(resolved) = dev.canonicalize() {
        if resolved.is_file() {
            return Some(resolved);
        }
    }
    None
}

/// The shipped bridge asset (lib/pi-rpc/factory.ts resolveAssetPath): the
/// packaged server tree first, the dev checkout second, an env override
/// always wins.
fn resolve_bridge_asset() -> Option<PathBuf> {
    resolve_asset("pi-web-bridge.mjs", "PI_WEB_BRIDGE_EXTENSION")
}

/// The artifacts guide asset (`resolveArtifactsExtensionPath`, same rules).
fn resolve_artifacts_asset() -> Option<PathBuf> {
    resolve_asset("pi-web-artifacts.mjs", "PI_WEB_ARTIFACTS_EXTENSION")
}

/// The chat policy asset (`resolveAssetPath("pi-web-chat.mjs")`).
fn resolve_chat_asset() -> Option<PathBuf> {
    resolve_asset("pi-web-chat.mjs", "PI_WEB_CHAT_EXTENSION")
}

/// The shipped chat policy asset's BYTES, embedded at build time: the
/// integrity pin the session host verifies the resolved asset file against
/// (Terra P1-1). A chat's security is the policy INSIDE this file (the
/// before_agent_start / tool_call enforcement); a swapped, corrupted or
/// truncated bundle copy that still registers the readiness marker would
/// otherwise hand the chat its tool loadout with no enforcement. Pinning
/// the digest to bytes compiled INTO this binary — never hashing the file
/// being checked — means only the exact shipped content can start a chat,
/// and the marker (which the shipped content registers LAST, after every
/// hook) implies the hooks loaded.
static SHIPPED_CHAT_ASSET_BYTES: &[u8] =
    include_bytes!("../../lib/pi-rpc/assets/pi-web-chat.mjs");

/// The pinned digest (computed once; lowercase hex).
fn shipped_chat_asset_sha256() -> &'static str {
    static PINNED: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PINNED.get_or_init(|| {
        use sha2::{Digest, Sha256};
        Sha256::digest(SHIPPED_CHAT_ASSET_BYTES)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    })
}

/// A shipped extension asset next to the server code (bridge, artifacts,
/// chat policy): env override, the packaged resources tree, the dev
/// checkout.
fn resolve_asset(file: &str, env_override: &str) -> Option<PathBuf> {
    if let Ok(path) = std::env::var(env_override) {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    if let Some(exe_dir) = exe_dir {
        let candidates = [
            exe_dir.join(format!("../Resources/server/lib/pi-rpc/assets/{file}")),
            exe_dir.join(format!("../../resources/server/lib/pi-rpc/assets/{file}")),
        ];
        for candidate in candidates {
            if let Ok(resolved) = candidate.canonicalize() {
                if resolved.is_file() {
                    return Some(resolved);
                }
            }
        }
    }
    let dev = Path::new("../lib/pi-rpc/assets").join(file);
    if let Ok(resolved) = dev.canonicalize() {
        if resolved.is_file() {
            return Some(resolved);
        }
    }
    None
}

/// The session spawn base, when a pi executable AND the bridge asset
/// resolve: the executable plus the shipped assets every session loads.
/// Without either, session ops answer not_found (never a fake child) — the
/// same honesty rule the models ops apply to management. The per-session
/// plan (kind, tools, prompts, model) is computed at spawn time by
/// [`build_spawn_plan`].
#[derive(Clone)]
pub struct SpawnBase {
    pub executable: String,
    pub bridge_asset: PathBuf,
    pub artifacts_asset: Option<PathBuf>,
    pub chat_asset: Option<PathBuf>,
}

fn resolve_session_spawn_base() -> Option<SpawnBase> {
    let executable = resolve_pi_executable()?;
    let bridge_asset = resolve_bridge_asset()?;
    Some(SpawnBase {
        executable: executable.to_string_lossy().into_owned(),
        bridge_asset,
        artifacts_asset: resolve_artifacts_asset(),
        chat_asset: resolve_chat_asset(),
    })
}

/// The managed module tree (the vendored dependency tree the management
/// extension loads by absolute path): an env override wins (tests, staged
/// layouts), then the packaged `<resources>/managed` directory, then the
/// dev checkout's `.managed-tree` (built by
/// `node scripts/migration/stage-managed-tree.mjs`). Without a tree the
/// config stays None and management ops answer management_unavailable —
/// the host never pretends a projection it cannot run.
fn resolve_managed_modules() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PI_WEB_MANAGED_MODULES") {
        let path = PathBuf::from(path);
        if path.is_dir() {
            return Some(path);
        }
    }
    let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    if let Some(exe_dir) = exe_dir {
        let candidates = [
            exe_dir.join("../Resources/managed"),
            exe_dir.join("../../resources/managed"),
            exe_dir.join("managed"),
        ];
        for candidate in candidates {
            if let Ok(resolved) = candidate.canonicalize() {
                if resolved.is_dir() {
                    return Some(resolved);
                }
            }
        }
    }
    let dev = Path::new("../.managed-tree");
    if let Ok(resolved) = dev.canonicalize() {
        if resolved.is_dir() {
            return Some(resolved);
        }
    }
    None
}

/// The management spawn config (the vendored management extension; its
/// managed module tree is wired with the M3 packaging — until then the
/// config stays None and models ops answer management_unavailable).
fn resolve_management_config() -> Option<ManagementSpawnConfig> {
    let executable = resolve_pi_executable()?;
    let dev = Path::new("../lib/pi-rpc/assets/pi-web-management.mjs");
    let extension = match dev.canonicalize() {
        Ok(resolved) if resolved.is_file() => Some(resolved),
        _ => None,
    }?;
    let managed = resolve_managed_modules()?;
    Some(ManagementSpawnConfig {
        executable: executable.to_string_lossy().into_owned(),
        agent_dir: None,
        extensions: vec![extension],
        env: vec![(
            "PI_WEB_MANAGED_MODULES".to_string(),
            managed.to_string_lossy().into_owned(),
        )],
    })
}

/// Write one file with private permissions (0600): the mirror carries the
/// user's drafts. Windows has no POSIX modes; the profile ACL covers it.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut handle = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        handle.write_all(bytes)?;
        handle.flush()
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

/// One stream frame (docs/migration/ipc-protocol.md §3).
fn stream_frame(subscription_id: &str, epoch: u64, seq: u64, kind: &str, payload: Value) -> Value {
    json!({
        "subscriptionId": subscription_id,
        "epoch": epoch,
        "seq": seq,
        "kind": kind,
        "payload": payload,
    })
}

/// Subscribe to a session's event stream on a Tauri Channel. The first
/// frame is the atomic snapshot (epoch + projected state), then raw child
/// events follow in arrival order with monotonic seq. The subscription ends
/// when the receiver unsubscribes (`agent.unsubscribeEvents`, page reload,
/// window close) or the session leaves the registry; the relay thread then
/// detaches — a dropped channel alone must not leak a thread.
#[tauri::command]
pub fn pi_ipc_subscribe_events(
    state: State<'_, Arc<IpcHostState>>,
    session: String,
    on_event: Channel<Value>,
) -> Value {
    let Some(session_handle) = state.registry.get(&session) else {
        return protocol_error("?", "not_found", &format!("no running session {session}"));
    };
    let subscription_id = format!(
        "sub-{}",
        state.subscription_counter.fetch_add(1, Ordering::Relaxed) + 1
    );
    let subscription_id_for_relay = subscription_id.clone();
    let epoch = session_handle.epoch();
    let (subscriber_id, events) = session_handle.subscribe();
    session_handle.lease();

    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_for_relay = Arc::clone(&stop);
    let relays_for_thread = Arc::clone(&state.event_relays);
    let subscription_for_cleanup = subscription_id.clone();
    state.event_relays.lock().unwrap().insert(
        subscription_id.clone(),
        EventRelayHandle {
            stop: Arc::clone(&stop),
            subscriber_id,
            session_id: session.clone(),
        },
    );

    // The relay: snapshot first, then every record in order. A closed
    // channel (send error) or the unsubscribe flag ends the loop and
    // detaches the subscriber.
    std::thread::Builder::new()
        .name(format!("ipc-events-{subscription_id}"))
        .spawn(move || {
            let subscription_id = subscription_id_for_relay;
            let detach = |subscriber_id| {
                session_handle.unsubscribe(subscriber_id);
                relays_for_thread.lock().unwrap().remove(&subscription_for_cleanup);
            };
            let mut seq: u64 = 0;
            let snapshot = json!({
                "epoch": session_handle.epoch(),
                "settledEpoch": session_handle.machine_settled_epoch(),
                "state": session_run_state_json(&session_handle),
                // The SSE `connected` contract: the client reconciles its
                // dialog queue against what the session still holds.
                "pendingExtensionUiIds": session_handle.run_state().pending_ui_request_ids,
            });
            seq += 1;
            if on_event.send(stream_frame(&subscription_id, epoch, seq, "snapshot", snapshot)).is_err() {
                detach(subscriber_id);
                return;
            }
            loop {
                if stop_for_relay.load(Ordering::SeqCst) {
                    detach(subscriber_id);
                    return;
                }
                match events.recv_timeout(Duration::from_millis(500)) {
                    Ok(record) => {
                        seq += 1;
                        if on_event
                            .send(stream_frame(&subscription_id, epoch, seq, "event", record))
                            .is_err()
                        {
                            detach(subscriber_id);
                            return;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        detach(subscriber_id);
                        return;
                    }
                }
            }
        })
        .ok();

    json!({ "subscriptionId": subscription_id, "epoch": epoch })
}

/// One observation of the RUNNING set beside the catalogue version. The
/// ids are SORTED so "the set did not change" compares equal no matter the
/// registry's hash iteration order (an unsorted Vec would re-emit an
/// identical set as a spurious change).
#[derive(Clone, Debug, PartialEq, Eq)]
struct RunningSnapshot {
    running: Vec<String>,
    version: u64,
}

/// Derive one running-set observation. Order matters for the client's
/// staleness check: the set is derived FIRST and the version read AFTER,
/// so the pair is conservative — the version beside a set can only be too
/// new (an extra refetch), never too old (a stale catalogue believed
/// fresh). This is a point-in-time observation over the live registry, not
/// a locked snapshot: a create/rename that lands mid-derivation is simply
/// the next frame.
fn derive_running_snapshot(registry: &SessionRegistry, version: &AtomicU64) -> RunningSnapshot {
    let mut running: Vec<String> = registry
        .ids()
        .into_iter()
        .filter(|id| registry.get(id).is_some_and(|session| session.run_state().is_running()))
        .collect();
    running.sort();
    RunningSnapshot { running, version: version.load(Ordering::SeqCst) }
}

/// The running stream's channel probe: how often a quiet stream re-sends
/// its (unchanged) observation so a dead Channel — a page reload that never
/// unsubscribed — is detected and the relay reaped instead of leaking
/// forever. Changes themselves arrive on the registry's running signal
/// (session-host's RunningSignal): every run-state TRANSITION (start,
/// settle, child exit, removal) wakes the relay at once AND is recorded in
/// the signal's bounded replay ring — a run that starts and settles while a
/// frame send is blocked is REPLAYED transition-by-transition once the
/// channel frees (Terra P2-1), never swallowed as "the net set did not
/// change". A burst that overflows the ring (512 unseen transitions) is
/// answered with ONE forced resync frame instead of a replay.
const RUNNING_CHANNEL_PROBE: Duration = Duration::from_secs(30);

/// Drops of this guard are the relay thread's LAST act (every exit path):
/// the alive count in `IpcHostState::running_relay_threads` therefore
/// measures the thread's real lifetime, not its registration.
struct RunningRelayAlive(Arc<AtomicUsize>);
impl Drop for RunningRelayAlive {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Subscribe to the RUNNING set's stream (the `agent.subscribeRunning` op;
/// GET /api/agent/running/events): the first frame is the observation at
/// subscribe time, then a frame whenever the set or the catalogue version
/// changes. The relay sleeps on the registry's running-change signal (every
/// run-state transition wakes it) and wakes on the probe deadline; after
/// each wake it first REPLAYS the transitions recorded while it was busy or
/// blocked (Terra P2-1 — a short run must stay observable) and only then
/// derives the current net set. Every path out of the relay detaches:
/// unsubscribe (which also WAKES the waiter — Terra P2-2 — so a quiet relay
/// ends at once instead of at the probe), a failed Channel send, or the
/// probe on a dead channel.
#[tauri::command]
pub fn pi_ipc_subscribe_running(
    state: State<'_, Arc<IpcHostState>>,
    on_frame: Channel<Value>,
) -> Value {
    subscribe_running(&state, on_frame, RUNNING_CHANNEL_PROBE)
}

fn subscribe_running(state: &IpcHostState, on_frame: Channel<Value>, probe_after: Duration) -> Value {
    let subscription_id = format!(
        "run-{}",
        state.subscription_counter.fetch_add(1, Ordering::Relaxed) + 1
    );
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state.event_relays.lock().unwrap().insert(
        subscription_id.clone(),
        EventRelayHandle {
            stop: Arc::clone(&stop),
            subscriber_id: 0,
            session_id: String::new(),
        },
    );
    let registry = Arc::clone(&state.registry);
    let version_counter = Arc::clone(&state.session_list_version);
    let relays_for_thread = Arc::clone(&state.event_relays);
    let running_signal = registry.running_signal();
    let relays_alive = Arc::clone(&state.running_relay_threads);
    let subscription_for_relay = subscription_id.clone();
    // Counted the moment the thread exists; the guard's Drop (the thread's
    // last act on every exit path) decrements it back.
    state.running_relay_threads.fetch_add(1, Ordering::SeqCst);
    let relay = std::thread::Builder::new()
        .name("ipc-running".into())
        .spawn(move || {
            let subscription_id = subscription_for_relay;
            let _alive = RunningRelayAlive(relays_alive);
            let detach = || {
                relays_for_thread.lock().unwrap().remove(&subscription_id);
            };
            let mut last_sent: Option<RunningSnapshot> = None;
            let mut last_sent_at = std::time::Instant::now();
            let mut seq: u64 = 0;
            // Two deliberately different cursors: `signal_epoch` is the WAIT
            // token (any bump — transition or wake-only — moves it, so a
            // catalogue-version change still reaches subscribers at once),
            // while `replay_seq` is the dense TRANSITION sequence (wake-only
            // bumps never consume it). Captured before the first derivation:
            // everything older is net-reflected in the baseline frame, so a
            // subscription never replays runs that predate it.
            let mut signal_epoch = running_signal.epoch();
            let mut replay_seq = running_signal.last_seq();
            loop {
                if stop.load(Ordering::SeqCst) {
                    detach();
                    return;
                }
                // Replay the transitions recorded while the relay was busy
                // or blocked in a send (a slow Channel): a run that started
                // AND settled in that window must still be observable, so
                // the intermediate sets are synthesized from the last-sent
                // set — the current net set alone would swallow the run
                // (Terra P2-1). Consecutive identical sets coalesce (a
                // no-op transition carries no observation); the ring is
                // bounded, so this is at most 512 frames per wake, never an
                // unbounded burst behind a blocked channel.
                let mut force_resync = false;
                if last_sent.is_some() {
                    let (transitions, gap) = running_signal.changes_since(replay_seq);
                    if gap {
                        // The bounded ring dropped transitions this relay had
                        // not seen: the intermediate sets are unrecoverable.
                        // Do not synthesize a partial history — advance the
                        // cursor and force ONE full re-derivation frame below
                        // (the client consumes frames as whole-set
                        // replacements, so the net truth IS the recovery).
                        replay_seq = running_signal.last_seq();
                        force_resync = true;
                    } else {
                        for transition in transitions {
                            replay_seq = transition.seq;
                            let mut running =
                                last_sent.as_ref().expect("baseline checked").running.clone();
                            if transition.running {
                                if !running.contains(&transition.session) {
                                    running.push(transition.session.clone());
                                    running.sort();
                                }
                            } else {
                                running.retain(|id| id != &transition.session);
                            }
                            if running == last_sent.as_ref().expect("baseline checked").running {
                                continue;
                            }
                            let observation = RunningSnapshot {
                                running,
                                // Read AFTER the set (derive_running_snapshot's
                                // conservative order): the version beside a set
                                // can only be too new, never too old.
                                version: version_counter.load(Ordering::SeqCst),
                            };
                            seq += 1;
                            let frame = stream_frame(
                                &subscription_id,
                                // The host process is this stream's epoch: a
                                // host restart is a new app process, hence a
                                // new subscription — never a frame on the old
                                // epoch.
                                1,
                                seq,
                                "event",
                                json!({
                                    "type": "running",
                                    "runningSessionIds": observation.running,
                                    "sessionListVersion": observation.version,
                                }),
                            );
                            last_sent = Some(observation);
                            last_sent_at = std::time::Instant::now();
                            if on_frame.send(frame).is_err() {
                                detach();
                                return;
                            }
                            // The cancel contract (Terra P2-2): at most ONE
                            // frame may leave after an unsubscribe lands —
                            // re-check the stop flag between frames so a
                            // multi-frame replay cannot outrun a cancel.
                            if stop.load(Ordering::SeqCst) {
                                detach();
                                return;
                            }
                        }
                    }
                }
                let snapshot = derive_running_snapshot(&registry, &version_counter);
                let changed = last_sent.as_ref() != Some(&snapshot);
                if changed || force_resync || last_sent_at.elapsed() >= probe_after {
                    last_sent = Some(snapshot.clone());
                    last_sent_at = std::time::Instant::now();
                    seq += 1;
                    let kind = if seq == 1 { "snapshot" } else { "event" };
                    let frame = stream_frame(
                        &subscription_id,
                        1,
                        seq,
                        kind,
                        json!({
                            "type": "running",
                            "runningSessionIds": snapshot.running,
                            "sessionListVersion": snapshot.version,
                        }),
                    );
                    if on_frame.send(frame).is_err() {
                        // The Channel died (page reload, window closed):
                        // end the relay and free its registry entry.
                        detach();
                        return;
                    }
                }
                // Event-driven: sleep until a run-state TRANSITION (start,
                // settle, exit, removal) or a wake-only bump (a catalogue
                // version change, an unsubscribe) moves the signal, or the
                // probe deadline passes (the dead-channel reaper).
                signal_epoch = running_signal.wait_for_change(signal_epoch, probe_after);
            }
        });
    match relay {
        Ok(_) => json!({ "subscriptionId": subscription_id }),
        Err(error) => {
            // No relay thread exists to clean up after itself: remove the
            // handle here, undo the alive count, and fail the subscription
            // honestly — reporting success would leave the client waiting on
            // a stream that never starts.
            state.running_relay_threads.fetch_sub(1, Ordering::SeqCst);
            state.event_relays.lock().unwrap().remove(&subscription_id);
            protocol_error(
                "?",
                "internal",
                &format!("running-stream relay failed to start: {error}"),
            )
        }
    }
}

/// Stream one terminal's output over a Channel: the first frame carries the
/// read since the caller's cursor (suffix or the reset+replay the history
/// window demands), then new output follows. A closed channel detaches.
#[tauri::command]
pub fn pi_ipc_subscribe_terminal(
    state: State<'_, Arc<IpcHostState>>,
    id: String,
    cursor: u64,
    on_output: Channel<Value>,
) -> Value {
    let subscription_id = format!("term-{}", state.subscription_counter.fetch_add(1, Ordering::Relaxed) + 1);
    match state.terminal_streams.subscribe(&id, subscription_id.clone(), cursor, move |frame| on_output.send(frame).is_ok()) {
        Ok(()) => json!({ "subscriptionId": subscription_id }),
        Err(error) => protocol_error("?", "not_found", &error),
    }
}

/// The agent dir the desktop runs against (packaged layout resolves it
/// through the app's agent-dir contract).
fn default_agent_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        return std::path::PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join(".pi/agent")
}

/// Map deny reasons to protocol codes.
fn denied_code(reason: resource_protocol::DenyReason) -> &'static str {
    match reason {
        resource_protocol::DenyReason::UnknownHandle => "not_found",
        resource_protocol::DenyReason::Expired => "not_found",
        resource_protocol::DenyReason::OutOfScope => "unauthorized_scope",
        resource_protocol::DenyReason::InvalidPath => "invalid_args",
        resource_protocol::DenyReason::NotFound => "not_found",
        resource_protocol::DenyReason::IoError => "io",
    }
}

fn session_run_state_json(session: &Arc<session_host::Session>) -> Value {
    let state = session.run_state();
    json!({
        "sessionId": state.session_id,
        "sessionName": state.session_name,
        "isStreaming": state.is_streaming,
        "isIdle": state.is_idle,
        "isCompacting": state.is_compacting,
        "autoRetryEnabled": state.auto_retry_enabled,
        "retryAttempt": state.retry_attempt,
        "messageCount": state.message_count,
        "pendingMessageCount": state.pending_message_count,
        "steeringQueue": state.steering_queue,
        "followUpQueue": state.follow_up_queue,
        "model": state.model,
        "thinkingLevel": state.thinking_level,
        "running": state.is_running(),
    })
}

impl Default for IpcHostState {
    fn default() -> Self {
        Self::new()
    }
}

/// The response envelope for a protocol-level rejection.
pub(crate) fn protocol_error(id: &str, code: &str, message: &str) -> Value {
    protocol_error_value(
        id,
        json!({ "code": code, "message": message, "retryable": false }),
    )
}

/// The response envelope for a failure with a custom error object (extra
/// fields ride along — e.g. a create failure's prompt_rejected details).
fn protocol_error_value(id: &str, error: Value) -> Value {
    json!({
        "v": IPC_PROTOCOL_VERSION,
        "id": id,
        "ok": false,
        "error": error,
    })
}

/// The response envelope for a success.
pub(crate) fn protocol_ok(id: &str, data: Value) -> Value {
    json!({ "v": IPC_PROTOCOL_VERSION, "id": id, "ok": true, "data": data })
}

/// Validate one request envelope and dispatch it. Kept pub for tests; the
/// #[tauri::command] wrapper only moves State in.
pub fn dispatch_envelope(state: &IpcHostState, raw: Value) -> Value {
    let Some(envelope) = raw.as_object() else {
        return protocol_error("?", "invalid_args", "the request must be a JSON object");
    };
    let id = envelope.get("id").and_then(Value::as_str).unwrap_or("?").to_string();
    if envelope.get("v").and_then(Value::as_i64) != Some(IPC_PROTOCOL_VERSION) {
        return protocol_error(
            &id,
            "version_mismatch",
            &format!("the host speaks protocol {IPC_PROTOCOL_VERSION}"),
        );
    }
    let Some(op) = envelope.get("op").and_then(Value::as_str) else {
        return protocol_error(&id, "invalid_args", "the request has no op");
    };
    let args = envelope.get("args").cloned().unwrap_or(json!({}));
    if !args.is_object() {
        return protocol_error(&id, "invalid_args", "args must be an object");
    }
    match op {
        // The identity probe the M1 BootPage uses: answers before any pi
        // child exists, proving the IPC bridge end to end.
        "desktop.identity" => protocol_ok(
            &id,
            json!({
                "version": env!("CARGO_PKG_VERSION"),
                "host": "tauri",
                "protocol": IPC_PROTOCOL_VERSION,
            }),
        ),
        // The transition-version state mirror (plan §七): the static app
        // READS the mirror the legacy version wrote, before React mounts.
        // The mirror lives under the host's agent dir; a missing or corrupt
        // file answers explicitly (the frontend never invents an empty one).
        "desktop.stateMirror" => {
            let agent_dir = state.agent_dir();
            let file = agent_dir.join("desktop-state-mirror.json");
            match std::fs::read_to_string(&file) {
                Ok(content) => match serde_json::from_str::<Value>(&content) {
                    Ok(payload) => protocol_ok(&id, payload),
                    Err(error) => protocol_error(
                        &id,
                        "io",
                        &format!("the state mirror is corrupt: {error}"),
                    ),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    protocol_ok(&id, json!({ "missing": true }))
                }
                Err(error) => protocol_error(&id, "io", &error.to_string()),
            }
        }
        // The static app's mirror WRITE (the same contract
        // app/api/state-mirror PUT had): schema-shape checked here, the
        // revision must strictly increase, the write is atomic + 0600 and
        // keeps a one-deep backup.
        "desktop.writeStateMirror" => {
            let Some(payload) = args.get("payload").cloned() else {
                return protocol_error(&id, "invalid_args", "payload is required");
            };
            // Structural checks (the full checksum recompute is the JS
            // module's job on both ends; here we enforce the fields the
            // atomic write needs and the strictly-increasing revision).
            let revision = payload.get("revision").and_then(Value::as_i64);
            let entries_ok = payload.get("entries").is_some_and(Value::is_object);
            if revision.is_none() || !entries_ok {
                return protocol_error(&id, "invalid_args", "the payload lacks revision or entries");
            }
            let revision = revision.unwrap_or(0);
            let agent_dir = state.agent_dir();
            let file = agent_dir.join("desktop-state-mirror.json");
            let existing_revision = match std::fs::read_to_string(&file) {
                Ok(content) => serde_json::from_str::<Value>(&content)
                    .ok()
                    .and_then(|parsed| parsed.get("revision").and_then(Value::as_i64))
                    .unwrap_or(i64::MIN),
                Err(_) => i64::MIN,
            };
            if revision <= existing_revision {
                // The stale-rejection shape (the HTTP route's 409): the client
                // adopts the host's revision and re-ships ahead of it.
                return protocol_error(
                    &id,
                    "invalid_args",
                    &format!("revision {revision} is not newer than {existing_revision}"),
                );
            }
            if let Err(error) = std::fs::create_dir_all(&agent_dir) {
                return protocol_error(&id, "io", &error.to_string());
            }
            let serialized = format!("{}\n", serde_json::to_string_pretty(&payload).unwrap_or_default());
            let tmp = agent_dir.join(format!("desktop-state-mirror.json.tmp-{}", std::process::id()));
            if let Err(error) = write_private(&tmp, serialized.as_bytes()) {
                return protocol_error(&id, "io", &error.to_string());
            }
            // Keep the previous good payload as the one-deep backup.
            if existing_revision != i64::MIN {
                let backup = agent_dir.join("desktop-state-mirror.json.bak");
                let _ = std::fs::rename(&file, &backup);
            }
            if let Err(error) = std::fs::rename(&tmp, &file) {
                return protocol_error(&id, "io", &error.to_string());
            }
            protocol_ok(&id, json!({ "revision": revision }))
        }
        // The font preferences read (GET /api/appearance/fonts contract):
        // reads stored fonts from <agent_dir>/pi-web/settings.json.
        "appearance.fontsGet" => {
            let agent_dir = state.agent_dir();
            match crate::fonts::read_font_preferences(&agent_dir) {
                Ok(fonts) => protocol_ok(&id, json!({ "fonts": fonts })),
                Err(error) => protocol_error(&id, "io", &error),
            }
        }
        // The font preferences write (PUT /api/appearance/fonts contract):
        // validates fonts schema, atomic private write preserving unknown fields.
        "appearance.fontsSet" => {
            let agent_dir = state.agent_dir();
            let Some(fonts_val) = args.get("fonts") else {
                return protocol_error(&id, "invalid_args", "missing fonts payload");
            };
            match crate::fonts::write_font_preferences(&agent_dir, fonts_val) {
                Ok(fonts) => protocol_ok(&id, json!({ "fonts": fonts })),
                Err(crate::fonts::FontError::InvalidArgs(msg)) => {
                    protocol_error(&id, "invalid_args", &msg)
                }
                Err(crate::fonts::FontError::Io(msg)) => protocol_error(&id, "io", &msg),
            }
        }
        // The native installed system fonts enumeration (GET /api/desktop/fonts contract):
        // enumerates OS trusted fonts without permanent node/server.
        "desktop.fonts" => match crate::fonts::list_system_fonts() {
            Ok(fonts) => protocol_ok(&id, json!({ "fonts": fonts })),
            Err(error) => protocol_error(&id, "io", &error),
        },
        // The session FILE INDEX (a host-diagnostic shape the boot page
        // lists projects from — NOT an HTTP method's projection): the
        // per-cwd scan with skipped-file reasons. `sessions.list` below is
        // the real GET /api/sessions (the inventory's name for it).
        "sessions.index" => {
            let agent_dir = state.agent_dir();
            let index = session_host::scan_sessions(&agent_dir);
            // The /api/files semantics: session cwds (and the chat roots)
            // become browsable roots, derived host-side.
            for (cwd, _) in index.projects.iter() {
                state.propose_path(Path::new(cwd));
            }
            let mut data = session_host::history::index_json(&index);
            if let Some(object) = data.as_object_mut() {
                object.insert("agentDir".into(), json!(agent_dir.to_string_lossy()));
            }
            protocol_ok(&id, data)
        }
        // The catalogue (GET /api/sessions): the full per-file scan (the TS
        // scanSessionFileInfo semantics, differential-tested) projected onto
        // the SessionInfo shape the sidebar consumes — workspace
        // classification, git project identity, the fork/subagent relation —
        // merged with the live registry's not-yet-flushed rows, plus the
        // payload's envelope fields (runningSessionIds,
        // completionNotificationSuppressedSessionIds, chatWorkspaceCwd,
        // sessionListVersion).
        "sessions.list" => {
            let agent_dir = state.agent_dir();
            let files = session_host::list_session_files(&agent_dir);
            // The parent-id map first (a fork's originSessionId resolves
            // from ITS header, never a filename suffix).
            let mut id_by_file: HashMap<String, String> = HashMap::new();
            let mut scans: Vec<session_host::history::ScannedSession> = Vec::new();
            for file in &files {
                if let Some(scan) = session_host::scan_session_file_info(file) {
                    if let Some(id) = session_host::history::read_header_id(file) {
                        id_by_file.insert(key_of(file), id);
                    }
                    scans.push(scan);
                }
            }
            let mut sessions: Vec<Value> = Vec::new();
            for scan in &scans {
                let parent_id = scan
                    .parent_session_path
                    .as_deref()
                    .map(Path::new)
                    .and_then(|parent| id_by_file.get(&key_of(parent)).cloned());
                // The subagent relation reads the file's bounded prefix/tail;
                // a fork falls back to the parent link alone (the origin id
                // present only when the parent file itself still resolves).
                let relation = session_host::history::read_subagent_relation(&scan.path).or_else(|| {
                    scan.parent_session_path.as_deref().map(|_| {
                        json!({
                            "kind": "fork",
                            "originSessionId": parent_id.clone().map(Value::String).unwrap_or(Value::Null),
                        })
                    })
                });
                let relation = match relation {
                    Some(value) if value.is_object() => Some(value),
                    _ => None,
                };
                sessions.push(catalogue_info(state, &agent_dir, scan, parent_id, relation));
            }
            // The running set the payload carries (the SSE stream's source).
            let running: Vec<String> = state
                .registry
                .ids()
                .into_iter()
                .filter(|id| state.registry.get(id).is_some_and(|session| session.run_state().is_running()))
                .collect();
            // Not-yet-flushed live sessions supplement the disk rows (the
            // disk scan is authoritative once the file exists — mergeSessionLists).
            let on_disk: std::collections::HashSet<String> =
                sessions.iter().filter_map(|info| info.get("id").and_then(Value::as_str).map(str::to_string)).collect();
            for id in state.registry.ids() {
                if on_disk.contains(&id) {
                    continue;
                }
                let Some(session) = state.registry.get(&id) else { continue };
                // An ensure_session-created runtime with nothing sent yet
                // stays hidden (getRpcSessionInfos' own rule: not running and
                // no first message = not listed).
                if let Some(info) = live_session_info(state, &agent_dir, &session, &id) {
                    sessions.push(info);
                }
            }
            sessions.sort_by(|a, b| {
                let modified = |info: &Value| info.get("modified").and_then(Value::as_str).unwrap_or("").to_string();
                modified(b).cmp(&modified(a))
            });
            // Host-derived roots stay in step with the catalogue's cwds.
            for value in sessions.iter() {
                if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
                    state.propose_path(Path::new(cwd));
                }
            }
            // The hidden chat root (ensureChatWorkspace; the sidebar's new-chat
            // target) and the catalogue's version counter.
            let chat_root = crate::session_view::ensure_chat_workspace(&agent_dir)
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| {
                    crate::session_view::chat_workspace_dir(&agent_dir).display().to_string()
                });
            state.propose_path(Path::new(&chat_root));
            protocol_ok(
                &id,
                json!({
                    "sessions": sessions,
                    "sessionListVersion": state.session_list_version(),
                    "runningSessionIds": running,
                    "completionNotificationSuppressedSessionIds": [],
                    "chatWorkspaceCwd": chat_root,
                }),
            )
        }
        // The session VIEW (GET /api/sessions/[id] and /context): the
        // projection runs in the management instance over the repo's own
        // lib/session-projection.ts bundle; this host owns resolution
        // (live child first, disk scan second), the live one-shot snapshot,
        // workspace classification and the git project identity.
        "sessions.autoName" => protocol_error(&id, "not_supported", "Automatic session naming is unavailable until the live provider's request semantics can be preserved."),
        "agent.command" if args.get("type").and_then(Value::as_str) == Some("abort_branch_summary") => {
            protocol_error(&id, "not_supported", "Branch summaries are unavailable in the desktop session host.")
        }
        "sessions.delete" => match crate::session_deletion::delete(state, &args) {
            Ok(data) => { bump_session_list_version(state); protocol_ok(&id, data) }
            Err((code, message)) => protocol_error(&id, &code, &message),
        },
        "sessions.export" => match crate::session_actions::export(state, &args) {
            Ok(data) => protocol_ok(&id, data),
            Err((code, message)) => protocol_error(&id, &code, &message),
        },
        "sessions.rename" => match crate::session_actions::rename(state, &args) {
            Ok(data) => { bump_session_list_version(state); protocol_ok(&id, data) }
            Err((code, message)) => protocol_error(&id, &code, &message),
        },
        "sessions.search" => match crate::session_search::search(state, &args) {
            Ok(data) => protocol_ok(&id, data),
            Err((code, message)) => protocol_error(&id, &code, &message),
        },
        "sessions.get" | "sessions.context" | "sessions.state" | "sessions.lease" => {
            match session_view_dispatch(state, op, &args) {
                Ok(data) => protocol_ok(&id, data),
                Err((code, message)) => protocol_error(&id, &code, &message),
            }
        }
        // The workspace ops (GET /api/home, GET /api/chat-workspace,
        // POST /api/default-cwd, POST /api/cwd/validate): path selection and
        // validation the shell and project picker need before any session
        // exists. All host-side (the home dir, the hidden chat root, the
        // scratch cwd, project validation) — the frontend never chooses what
        // gets proposed for browsing.
        "cwd.home" => {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string());
            protocol_ok(&id, json!({ "home": home }))
        }
        "chats.workspaceState" => {
            let agent_dir = state.agent_dir();
            match crate::session_view::ensure_chat_workspace(&agent_dir) {
                Ok(cwd) => {
                    state.propose_path(&cwd);
                    protocol_ok(&id, json!({ "cwd": cwd.display().to_string() }))
                }
                Err(error) => protocol_error(&id, "io", &error.to_string()),
            }
        }
        "cwd.createDefault" => {
            // ~/pi-cwd/<local YYYYMMDD>, created on demand (defaultCwdPath).
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string());
            let (year, month, day, _, _, _) = crate::session_view::local_now_parts_pub();
            let dir = PathBuf::from(&home)
                .join("pi-cwd")
                .join(format!("{year:04}{month:02}{day:02}"));
            match std::fs::create_dir_all(&dir) {
                Ok(()) => {
                    state.propose_path(&dir);
                    protocol_ok(&id, json!({ "cwd": dir.display().to_string() }))
                }
                Err(error) => protocol_error(&id, "io", &error.to_string()),
            }
        }
        "cwd.validate" => match validate_cwd(state, &args) {
            Ok(data) => protocol_ok(&id, data),
            Err((code, message)) => protocol_error(&id, &code, &message),
        },
        // GET /api/project-trust's status half: the trust banner's mount
        // probe (requiresTrust/trusted/decision/…). The MCP listing and the
        // POST (trusting a folder) stay on the HTTP domain until their M3
        // migration; this op covers exactly the read the UI performs on
        // every workspace switch.
        "trust.status" => {
            let Some(cwd) = args.get("cwd").and_then(Value::as_str) else {
                return protocol_error(&id, "invalid_params", "trust.status needs a cwd");
            };
            let agent_dir = state.agent_dir();
            protocol_ok(&id, crate::session_view::project_trust_status(&agent_dir, Path::new(cwd)))
        }
        // POST /api/agent/new: a brand-new session (the factory + the
        // route's contract — cwd validation, the chat folder factory, the
        // spawn plan, ensure_session vs the first command, and the honest
        // prompt_rejected error shape when a prompt-type create fails).
        "agent.create" => match create_session(state, &args) {
            Ok(data) => protocol_ok(&id, data),
            Err((code, message, details)) => {
                let mut error = json!({ "code": code, "message": message, "retryable": false });
                if let Some(details) = details {
                    error["details"] = details;
                }
                protocol_error_value(&id, error)
            }
        },
        "agent.command" if matches!(args.get("type").and_then(Value::as_str), Some("fork" | "fork_branch" | "clone" | "navigate_tree")) => {
            match crate::session_actions::branch(state, &args) {
                Ok(data) => {
                    if data.get("newSessionId").and_then(Value::as_str).is_some() {
                        bump_session_list_version(state);
                    }
                    protocol_ok(&id, data)
                }
                Err((code, message)) => protocol_error(&id, &code, &message),
            }
        }
        "sessions.runState" | "agent.interrupt" | "agent.setSessionName" | "agent.runState"
        | "agent.eventsSnapshot" | "agent.command" | "agent.getTools" | "agent.setTools" => {
            // The resume path: an op on an on-disk session may cold-start its
            // child (the POST /api/agent/[id] contract) — the plan builder
            // recomputes the session's spawn shape from its file and cwd
            // (kind, persisted pin, chat unlock, saved model), exactly what
            // startRpcSession re-derived per start on the Next server.
            match dispatch_with_resume(state, op, &args) {
                Ok(data) => protocol_ok(&id, data),
                Err((code, message)) => protocol_error(&id, &code, &message),
            }
        }
        // End one event-stream subscription (page hide, session switch):
        // detaches the session subscriber and ends the relay thread. The
        // client never re-subscribes blindly — a new subscription carries a
        // fresh snapshot.
        "agent.unsubscribeEvents" => {
            let subscription_id = args.get("subscriptionId").and_then(Value::as_str).unwrap_or_default();
            let handle = state.event_relays.lock().unwrap().remove(subscription_id);
            match handle {
                Some(handle) => {
                    handle.stop.store(true, Ordering::SeqCst);
                    if let Some(session) = state.registry.get(&handle.session_id) {
                        session.unsubscribe(handle.subscriber_id);
                    }
                    // WAKE the running-set relay's waiter (Terra P2-2): it
                    // sleeps on the registry's running signal with a 30 s
                    // probe — without this bump a quiet unsubscribe leaves
                    // the relay thread (and its liveness count) alive until
                    // the probe. The bump is wake-only: no transition is
                    // recorded, nothing replays; the relay re-checks its
                    // stop flag and detaches at once. The session-events
                    // relay is unaffected (its recv_timeout is already
                    // bounded at 500 ms).
                    state.registry.running_signal().notify();
                    protocol_ok(&id, json!({ "unsubscribed": subscription_id }))
                }
                None => protocol_error(&id, "not_found", &format!("no subscription {subscription_id}")),
            }
        }
        // Terminals (crates/pty-host): idempotent create, serialized input,
        // cursor-based reads, explicit close. Input failures surface —
        // terminal input is never auto-retried.
        "terminal.create" => {
            let terminal_id = args.get("id").and_then(Value::as_str).unwrap_or_default();
            if terminal_id.is_empty() {
                return protocol_error(&id, "invalid_args", "terminal id is required");
            }
            let Some(cwd) = args.get("cwd").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                return protocol_error(&id, "invalid_args", "terminal cwd is required");
            };
            let cwd = match crate::terminal_host::authorize_cwd(&state.file_roots.lock().unwrap(), &state.agent_dir(), cwd) {
                Ok(cwd) => cwd,
                Err(code) => return protocol_error(&id, code, "terminal cwd is not an authorized project directory"),
            };
            match state.terminal_streams.reuse(terminal_id, &cwd) {
                Ok(true) => return protocol_ok(&id, json!({ "id": terminal_id })),
                Ok(false) => {},
                Err(error) => return protocol_error(&id, "invalid_args", &error),
            }
            let cols = args.get("cols").and_then(Value::as_u64).unwrap_or(80).clamp(2, 1000) as u16;
            let rows = args.get("rows").and_then(Value::as_u64).unwrap_or(24).clamp(2, 1000) as u16;
            let shell = match terminal_shell(state) {
                Ok(shell) => shell,
                Err((code, message)) => return protocol_error(&id, &code, &message),
            };
            match state.terminal_streams.create(terminal_id, &cwd, pty_host::PtyOptions { cols, rows, shell: Some(shell), ..Default::default() }) {
                Ok(()) => protocol_ok(&id, json!({ "id": terminal_id })),
                Err(error) => protocol_error(&id, "io", &error),
            }
        }
        "terminal.ack" => {
            let subscription = args.get("subscriptionId").and_then(Value::as_str).unwrap_or_default();
            let seq = args.get("seq").and_then(Value::as_u64).unwrap_or(0);
            if state.terminal_streams.ack(subscription, seq) { protocol_ok(&id, json!({ "acknowledged": seq })) }
            else { protocol_error(&id, "not_found", "terminal subscription or sequence not found") }
        },
        "terminal.unsubscribe" => {
            let subscription = args.get("subscriptionId").and_then(Value::as_str).unwrap_or_default();
            if state.terminal_streams.unsubscribe(subscription) { protocol_ok(&id, json!({ "unsubscribed": subscription })) }
            else { protocol_error(&id, "not_found", "terminal subscription not found") }
        },
        "terminal.settingsGet" => {
            let _guard = state.terminal_management_lock.lock().unwrap();
            match management_call(state, "terminal.settingsGet", json!({})) {
                Ok(settings) => protocol_ok(&id, settings),
                Err((code, message)) => protocol_error(&id, &code, &message),
            }
        },
        "terminal.settingsSet" => {
            let Some(shell) = args.get("shell").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
                return protocol_error(&id, "invalid_args", "shell is required");
            };
            let _guard = state.terminal_management_lock.lock().unwrap();
            match management_call(state, "terminal.settingsSet", json!({ "shell": shell })) {
                Ok(settings) => protocol_ok(&id, settings),
                Err((code, message)) => protocol_error(&id, &code, &message),
            }
        },
        "terminal.write" => {
            let terminal_id = args.get("id").and_then(Value::as_str).unwrap_or_default();
            let Some(terminal) = state.terminals.get(terminal_id) else {
                return protocol_error(&id, "not_found", &format!("no terminal {terminal_id}"));
            };
            let input = args.get("input").and_then(Value::as_str)
                .filter(|encoded| encoded.len() <= 349_528)
                .and_then(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).ok())
                .filter(|bytes| bytes.len() <= 262_144);
            let Some(input) = input else {
                return protocol_error(&id, "invalid_args", "input must be bounded base64");
            };
            match terminal.write_input(&input) {
                Ok(()) => protocol_ok(&id, json!({ "written": input.len() })),
                Err(error) => protocol_error(&id, "io", &error),
            }
        }
        "terminal.resize" => {
            let terminal_id = args.get("id").and_then(Value::as_str).unwrap_or_default();
            let Some(terminal) = state.terminals.get(terminal_id) else {
                return protocol_error(&id, "not_found", &format!("no terminal {terminal_id}"));
            };
            let cols = args.get("cols").and_then(Value::as_u64).unwrap_or(80).clamp(2, 1000) as u16;
            let rows = args.get("rows").and_then(Value::as_u64).unwrap_or(24).clamp(2, 1000) as u16;
            match terminal.resize(cols, rows) {
                Ok(()) => protocol_ok(&id, json!({ "cols": cols, "rows": rows })),
                Err(error) => protocol_error(&id, "io", &error),
            }
        }
        "terminal.read" => {
            let terminal_id = args.get("id").and_then(Value::as_str).unwrap_or_default();
            let Some(terminal) = state.terminals.get(terminal_id) else {
                return protocol_error(&id, "not_found", &format!("no terminal {terminal_id}"));
            };
            let cursor = args.get("cursor").and_then(Value::as_u64).unwrap_or(0);
            match terminal.read_since(cursor) {
                pty_host::ReadOutcome::Suffix { cursor, text } => protocol_ok(&id, json!({ "kind": "suffix", "cursor": cursor, "output": text })),
                pty_host::ReadOutcome::Reset { cursor, text } => protocol_ok(&id, json!({ "kind": "reset", "cursor": cursor, "output": text })),
            }
        }
        "terminal.close" => {
            let terminal_id = args.get("id").and_then(Value::as_str).unwrap_or_default();
            if state.terminal_streams.close(terminal_id) {
                protocol_ok(&id, json!({ "closed": true }))
            } else {
                protocol_error(&id, "not_found", &format!("no terminal {terminal_id}"))
            }
        }
        // The models domain runs through a management instance
        // (crates/management-host) scoped to the cwd — the same scope split
        // the plan fixes (a trusted project's extension providers enumerate
        // only from that project's instance). The composition itself is ONE
        // implementation: the management extension's models.list op runs the
        // repo's own lib/models-service.ts (the projection bundle), the exact
        // function the Next /api/models route serves. Without the packaged
        // spawn config the answer is management_unavailable — never a
        // fallback, never a lie.
        "models.list" => {
            let Some(cwd) = args.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()) else {
                return protocol_error(&id, "invalid_args", "cwd is required");
            };
            if let Err(error) = validate_scoped_cwd(&state, cwd) {
                return protocol_error(&id, error.0.as_str(), &error.1);
            }
            let cwd = lexical_fold(cwd, cfg!(windows));
            match management_call_scoped(state, "models.list", &json!({ "cwd": cwd }), Path::new(&cwd)) {
                Ok(models) => protocol_ok(&id, models),
                Err(error) => protocol_error(&id, error.0.as_str(), &error.1),
            }
        }
        // The selectors' star: the ONLY writer of the global default
        // model / thinking level (PUT /api/models/default's contract). The
        // shared write path (same models-service projection) refuses a
        // shadowing project settings.json with `project_scope` (the route's
        // 409) and an out-of-scope model with `not_found` (the 404).
        "models.setDefault" => {
            let Some(cwd) = args.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()) else {
                return protocol_error(&id, "invalid_args", "cwd is required");
            };
            if let Err(error) = validate_scoped_cwd(&state, cwd) {
                return protocol_error(&id, error.0.as_str(), &error.1);
            }
            let cwd = lexical_fold(cwd, cfg!(windows));
            let mut payload = json!({ "cwd": cwd });
            if let Some(provider) = args.get("provider").and_then(Value::as_str) {
                payload["provider"] = Value::String(provider.to_string());
            }
            if let Some(model_id) = args.get("modelId").and_then(Value::as_str) {
                payload["modelId"] = Value::String(model_id.to_string());
            }
            if let Some(level) = args.get("thinkingLevel").and_then(Value::as_str) {
                payload["thinkingLevel"] = Value::String(level.to_string());
            }
            match management_call_scoped(state, "models.setDefault", &payload, Path::new(&cwd)) {
                Ok(result) => protocol_ok(&id, result),
                Err(error) => protocol_error(&id, error.0.as_str(), &error.1),
            }
        }
        // The Models panel's `enabledModels` switches (GET/PUT
        // /api/models/enabled's contract). The composition — the
        // minimal-edit engine, the verified provider globs, stale-entry
        // preservation, the resync repair — is ONE implementation in the
        // repo's lib/enabled-models-service.server.ts (the projection
        // bundle); the host gates the cwd and validates a CLOSED payload:
        // the op enum and every field are checked HERE and the extension
        // payload is rebuilt from the validated values only, so an unknown
        // field or a wrong-typed one never reaches a management child.
        "models.enabledGet" => {
            let Some(cwd) = args.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()) else {
                return protocol_error(&id, "invalid_args", "cwd is required");
            };
            if let Err(error) = validate_scoped_cwd(state, cwd) {
                return protocol_error(&id, error.0.as_str(), &error.1);
            }
            let cwd = lexical_fold(cwd, cfg!(windows));
            match management_call_scoped(state, "models.enabledGet", &json!({ "cwd": cwd }), Path::new(&cwd)) {
                Ok(view) => protocol_ok(&id, view),
                Err(error) => protocol_error(&id, error.0.as_str(), &error.1),
            }
        }
        "models.enabledSet" => {
            let Some(cwd) = args.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty()) else {
                return protocol_error(&id, "invalid_args", "cwd is required");
            };
            if let Err(error) = validate_scoped_cwd(state, cwd) {
                return protocol_error(&id, error.0.as_str(), &error.1);
            }
            let cwd = lexical_fold(cwd, cfg!(windows));
            let mut payload = match validated_enabled_models_payload(&args) {
                Ok(payload) => payload,
                Err(message) => return protocol_error(&id, "invalid_args", &message),
            };
            payload["cwd"] = Value::String(cwd.clone());
            match management_call_scoped(state, "models.enabledSet", &payload, Path::new(&cwd)) {
                Ok(view) => protocol_ok(&id, view),
                Err((code, message)) => {
                    // The write path's shaped refusals (the HTTP 409 reasons)
                    // ride the protocol's `reason` field: the code enum stays
                    // closed ("io" for a management refusal) and the panel's
                    // FAILURE_KEYS map the reason exactly like they mapped
                    // the HTTP body's.
                    if code == "last_model" || code == "project_scope" {
                        return protocol_error_value(&id, json!({
                            "code": "io",
                            "message": message,
                            "retryable": false,
                            "reason": code.replace('_', "-"),
                        }));
                    }
                    protocol_error(&id, &code, &message)
                }
            }
        }
        // The Models panel's models.json read (GET /api/models-config's
        // contract): the redaction lives in the ONE composition
        // (readRedactedModelsConfig), so a stored literal apiKey can never
        // reach the frontend. No cwd scope — models.json is a global file
        // read, like the route's bare GET.
        "modelsConfig.get" => match management_call(state, "modelsConfig.get", json!({})) {
            Ok(config) => protocol_ok(&id, config),
            Err(error) => protocol_error(&id, error.0.as_str(), &error.1),
        },
        // The Models panel's models.json save (PUT /api/models-config's
        // contract): ONE composition (saveModelsConfig — the stored-literal
        // apiKey merge, cost normalization, the blank-row sanitize, the
        // private atomic write, the read refusal). The host validates only
        // the closed ENVELOPE shape; the draft's own fields — including
        // unknown ones, the file's schema is the user's — pass through
        // verbatim, so no write rule is duplicated here. Global instance,
        // like the route's unscoped PUT.
        "modelsConfig.put" => {
            let config = match validated_models_config_payload(&args) {
                Ok(config) => config,
                Err(message) => return protocol_error(&id, "invalid_args", &message),
            };
            match management_call(state, "modelsConfig.put", json!({ "config": config })) {
                Ok(result) => protocol_ok(&id, result),
                Err((code, message)) => {
                    // The save's shaped refusal (the route's 409: a models.json
                    // the composition could not read must never be replaced)
                    // rides the protocol's `reason` field, exactly like the
                    // enabledModels refusals — the code enum stays closed.
                    if code == "models_config_read" {
                        return protocol_error_value(&id, json!({
                            "code": "io",
                            "message": message,
                            "retryable": false,
                            "reason": "models-config-read",
                        }));
                    }
                    protocol_error(&id, &code, &message)
                }
            }
        }
        // --- settings-extras -----------------------------------------------
        "tools.settingsGet" => {
            match crate::settings_extras::tools_settings_get(&state.agent_dir()) {
                Ok(v) => protocol_ok(&id, v),
                Err(e) => e.to_protocol_value(&id),
            }
        }
        "tools.settingsSet" => {
            match crate::settings_extras::tools_settings_set(&state.agent_dir(), &args) {
                Ok(v) => protocol_ok(&id, v),
                Err(e) => e.to_protocol_value(&id),
            }
        }
        "artifacts.settingsGet" => {
            match crate::settings_extras::artifacts_settings_get(&state.agent_dir()) {
                Ok(v) => protocol_ok(&id, v),
                Err(e) => e.to_protocol_value(&id),
            }
        }
        "artifacts.settingsSet" => {
            match crate::settings_extras::artifacts_settings_set(&state.agent_dir(), &args) {
                Ok(v) => protocol_ok(&id, v),
                Err(e) => e.to_protocol_value(&id),
            }
        }
        "chats.settingsGet" => {
            match crate::settings_extras::chats_settings_get(&state.agent_dir()) {
                Ok(v) => protocol_ok(&id, v),
                Err(e) => e.to_protocol_value(&id),
            }
        }
        "chats.settingsSet" => {
            match crate::settings_extras::chats_settings_set(&state.agent_dir(), &args) {
                Ok(v) => protocol_ok(&id, v),
                Err(e) => e.to_protocol_value(&id),
            }
        }
        "appearance.customCssGet" => {
            match crate::settings_extras::appearance_custom_css_get(&state.agent_dir()) {
                Ok(v) => protocol_ok(&id, v),
                Err(e) => e.to_protocol_value(&id),
            }
        }
        "appearance.customCssSet" => {
            match crate::settings_extras::appearance_custom_css_set(&state.agent_dir(), &args) {
                Ok(v) => protocol_ok(&id, v),
                Err(e) => e.to_protocol_value(&id),
            }
        }
        "modelsConfig.catalog" => {
            let mut payload = json!({});
            if let Some(q) = args.get("q").and_then(Value::as_str) {
                payload["q"] = Value::String(q.to_string());
            }
            if let Some(provider) = args.get("provider").and_then(Value::as_str) {
                payload["provider"] = Value::String(provider.to_string());
            }
            if let Some(base_url) = args.get("baseUrl").and_then(Value::as_str) {
                payload["baseUrl"] = Value::String(base_url.to_string());
            }
            if let Some(limit) = args.get("limit").and_then(Value::as_i64) {
                payload["limit"] = json!(limit);
            }
            match management_call(state, "modelsConfig.catalog", payload) {
                Ok(result) => protocol_ok(&id, result),
                Err(error) => protocol_error(&id, error.0.as_str(), &error.1),
            }
        }
        "modelsConfig.discover" => {
            let (provider_name, provider) = match validated_models_discover_payload(&args) {
                Ok(tuple) => tuple,
                Err(message) => return protocol_error(&id, "invalid_args", &message),
            };
            match management_call(state, "modelsConfig.discover", json!({
                "providerName": provider_name,
                "provider": provider,
            })) {
                Ok(result) => protocol_ok(&id, result),
                Err(error) => protocol_error(&id, error.0.as_str(), &error.1),
            }
        }
        "modelsConfig.test" => {
            let (provider_name, provider, model) = match validated_models_test_payload(&args) {
                Ok(tuple) => tuple,
                Err(message) => return protocol_error(&id, "invalid_args", &message),
            };
            match management_call(state, "modelsConfig.test", json!({
                "providerName": provider_name,
                "provider": provider,
                "model": model,
            })) {
                Ok(result) => protocol_ok(&id, result),
                Err(error) => protocol_error(&id, error.0.as_str(), &error.1),
            }
        }
        "models.nonchat" => match management_call(state, "models.nonchat", json!({})) {
            Ok(result) => protocol_ok(&id, result),
            Err(error) => protocol_error(&id, error.0.as_str(), &error.1),
        },
        "models.refreshCatalog" => {
            let mut payload = json!({});
            if let Some(provider) = args.get("provider").and_then(Value::as_str) {
                payload["provider"] = Value::String(provider.to_string());
            }
            match management_call(state, "models.refreshCatalog", payload) {
                Ok(result) => protocol_ok(&id, result),
                Err(error) => protocol_error(&id, error.0.as_str(), &error.1),
            }
        }
        "models.providerUsage" => {
            let Some(provider_id) = args.get("providerId").and_then(Value::as_str).filter(|p| !p.is_empty()) else {
                return protocol_error(&id, "invalid_args", "providerId is required");
            };
            match management_call(state, "models.providerUsage", json!({ "providerId": provider_id })) {
                Ok(result) => protocol_ok(&id, result),
                Err(error) => protocol_error(&id, error.0.as_str(), &error.1),
            }
        }
        // Scheduled tasks (crates/task-scheduler): list/preview read the
        // store; the tick loop itself runs on the host's 30 s timer (M4
        // wiring), never through request dispatch.
        "tasks.list" => {
            let agent_dir = state
                .task_agent_dir
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(default_agent_dir);
            let store = TaskStore::new(agent_dir);
            match store.read_tasks() {
                Ok(tasks) => protocol_ok(
                    &id,
                    json!({ "tasks": tasks.values().map(|(_, raw)| raw).collect::<Vec<_>>() }),
                ),
                Err(error) => protocol_error(&id, "io", &error),
            }
        }
        // Preview resources (crates/resource-protocol): grants are HOST-side
        // decisions (a session-reported artifact location, a path the index
        // scan proposed); the frontend can only confirm a path the host
        // itself named — it can never mint a grant for an arbitrary path.
        "resources.grantFile" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or_default();
            if path.is_empty() {
                return protocol_error(&id, "invalid_args", "path is required");
            }
            if !state.is_proposed(&path) {
                return protocol_error(
                    &id,
                    "unauthorized_scope",
                    "the host never proposed this path; resources are granted host-side only",
                );
            }
            match state.resources.grant_file(Path::new(path), Duration::from_secs(600)) {
                Ok(handle) => protocol_ok(&id, json!({ "handle": handle })),
                Err(reason) => protocol_error(&id, denied_code(reason), &format!("{reason:?}")),
            }
        }
        "resources.read" => {
            let handle = args.get("handle").and_then(Value::as_str).unwrap_or_default();
            let subpath = args.get("subpath").and_then(Value::as_str).unwrap_or_default();
            let range = match (args.get("start").and_then(Value::as_u64), args.get("end").and_then(Value::as_u64)) {
                (Some(start), Some(end)) => Some((start, end)),
                _ => None,
            };
            match state.resources.read(handle, subpath, range) {
                ResourceResponse::Ok { mime, bytes, total_len, range_applied } => protocol_ok(
                    &id,
                    json!({
                        "mime": mime,
                        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                        "totalLen": total_len,
                        "rangeApplied": range_applied,
                    }),
                ),
                ResourceResponse::Denied(reason) => {
                    protocol_error(&id, denied_code(reason), &format!("{reason:?}"))
                }
            }
        }
        "resources.revoke" => {
            let handle = args.get("handle").and_then(Value::as_str).unwrap_or_default();
            let revoked = state.resources.revoke(handle);
            protocol_ok(&id, json!({ "revoked": revoked }))
        }
        // Files (the /api/files boundary): every path is re-checked against
        // the allow-list. Roots are derived HOST-side (session cwds from the
        // index scan, default-cwd layouts, later: dialog picks and validated
        // cwds) — there is deliberately NO frontend-facing allowRoot op: the
        // WebView must not be able to widen its own file access.
        "git.status" | "git.diff" => {
            let cwd = PathBuf::from(args.get("cwd").and_then(Value::as_str).unwrap_or_default());
            let path = PathBuf::from(args.get("path").and_then(Value::as_str).unwrap_or_default());
            let roots = state.file_roots.lock().unwrap().clone();
            if !roots.is_existing_path_allowed(&cwd)
                || crate::worktrees::is_chat_area(&cwd, &state.agent_dir())
                || (op == "git.diff" && (!roots.is_path_allowed(&path) || path.components().any(|c| matches!(c, std::path::Component::ParentDir)))) {
                return protocol_error(&id, "unauthorized_scope", "Access denied");
            }
            let cwd = std::fs::canonicalize(&cwd).unwrap_or(cwd);
            let result = if op == "git.status" { crate::git_changes::status(&roots, &cwd) } else { crate::git_changes::diff(&roots, &cwd, &path) };
            match result { Ok(data) => protocol_ok(&id, data), Err(message) => protocol_error(&id, "io", &message) }
        }
        "worktrees.list" | "worktrees.create" | "worktrees.switch" | "worktrees.delete" | "worktrees.fetch" => {
            let cwd = PathBuf::from(args.get("cwd").and_then(Value::as_str).unwrap_or_default());
            let roots = state.file_roots.lock().unwrap().clone();
            let existing_allowed = roots.is_existing_path_allowed(&cwd);
            let missing_candidate = op == "worktrees.list" && !cwd.exists() && roots.is_path_allowed(&cwd);
            let target_is_chat = op == "worktrees.delete" && args.get("path").and_then(Value::as_str)
                .is_some_and(|path| crate::worktrees::is_chat_area(Path::new(path), &state.agent_dir()));
            if (!existing_allowed && !missing_candidate) || crate::worktrees::is_chat_area(&cwd, &state.agent_dir()) || target_is_chat
            {
                return protocol_error(&id, "unauthorized_scope", "Access denied");
            }
            let project = if existing_allowed {
                match crate::worktrees::project(&cwd) { Ok(project) => project, Err(message) => return protocol_error(&id, "io", &message) }
            } else { state.projects.resolve(&cwd) };
            if !existing_allowed && (!project.is_worktree || !roots.is_existing_path_allowed(&project.project_root)) {
                return protocol_error(&id, "unauthorized_scope", "Access denied");
            }
            match crate::worktrees::execute(op, &cwd, &args, &project) {
                Ok((data, grants)) => {
                    for path in grants {
                        if !crate::worktrees::is_chat_area(&path, &state.agent_dir()) { state.propose_path(&path); }
                    }
                    if matches!(op, "worktrees.create" | "worktrees.switch" | "worktrees.delete") { state.projects.invalidate(); }
                    protocol_ok(&id, data)
                }
                Err(message) => {
                    let dirty = op == "worktrees.delete" && ["contains modified or untracked files", "is dirty", "containing submodules"].iter().any(|part| message.to_lowercase().contains(part));
                    protocol_error_value(&id, json!({"code":"io", "message":message, "retryable":false, "details":{"dirty":dirty}}))
                }
            }
        }
        "files.list" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or_default();
            let directory = PathBuf::from(path);
            let listed = {
                let roots = state.file_roots.lock().unwrap();
                crate::file_access::list_directory(&roots, &directory)
            };
            match listed {
                Ok(entries) => protocol_ok(
                    &id,
                    json!({
                        "entries": entries,
                        "path": path,
                    }),
                ),
                Err(message) => {
                    let code = if message.contains("Not a directory") { "invalid_args" } else { "unauthorized_scope" };
                    protocol_error(&id, code, &message)
                }
            }
        }
        // Browsing a directory symlink's target (the /api/files allow-link
        // contract): an EXPLICIT operator action (the listing showed the
        // target); the link must sit inside the roots after resolution, be a
        // symlink to a directory, and STILL point at the target the listing
        // showed (a link re-aimed since is refused, not granted blind).
        "files.allowLink" => {
            let link = args.get("link").and_then(Value::as_str).unwrap_or_default();
            let expected_target = args.get("target").and_then(Value::as_str).unwrap_or_default();
            if link.is_empty() || expected_target.is_empty() {
                return protocol_error(&id, "invalid_args", "link and target are required");
            }
            let link_path = PathBuf::from(link);
            let approval = {
                let roots = state.file_roots.lock().unwrap();
                crate::file_access::check_linked_directory_approval(&roots, &link_path, expected_target)
            };
            match approval {
                crate::file_access::LinkApproval::Ok { target, already_allowed } => {
                    if !already_allowed {
                        // The operator explicitly chose to browse the target:
                        // a host-side root grant (propose_path records it).
                        state.propose_path(std::path::Path::new(&target));
                    }
                    protocol_ok(
                        &id,
                        json!({ "target": target, "alreadyAllowed": already_allowed }),
                    )
                }
                crate::file_access::LinkApproval::Denied { code, error } => {
                    protocol_error(&id, code, error)
                }
            }
        }
        "files.read" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or_default();
            let target = PathBuf::from(path);
            // The read twin of the hardened write: canonicalize + containment
            // authorize, then a beneath-walk (openat O_NOFOLLOW per
            // component off the ROOT's descriptor) so a final component or
            // an ancestor swapped for a symlink after the check refuses
            // instead of reading outside the roots. A symlink inside the
            // roots pointing inside the roots reads its target (canonical
            // resolution), same as /api/files.
            #[cfg(unix)]
            let outcome = {
                let roots = state.file_roots.lock().unwrap();
                crate::file_access::resolved_read_target_with_root(&roots, &target)
                    .map(|(resolved, root)| crate::file_access::read_beneath_root(&root, &resolved))
            };
            #[cfg(windows)]
            let outcome: Option<Result<Vec<u8>, std::io::Error>> = {
                // Fail-closed until the handle-based implementation ships:
                // the naive read re-opens by path and re-introduces the
                // check→open race the Unix side closed.
                let _ = &target;
                None
            };
            match outcome {
                None => protocol_error(&id, "unauthorized_scope", "the path is outside the allowed roots"),
                Some(Ok(bytes)) => protocol_ok(
                    &id,
                    json!({
                        "mime": crate::file_access::mime_for(&target),
                        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                    }),
                ),
                Some(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                    protocol_error(&id, "not_found", "no such file")
                }
                #[cfg(windows)]
                Some(Err(error)) => protocol_error(&id, "io", &error.to_string()),
                #[cfg(unix)]
                Some(Err(error)) => protocol_error(
                    &id,
                    if error.kind() == std::io::ErrorKind::NotFound { "not_found" } else { "unauthorized_scope" },
                    &error.to_string(),
                ),
            }
        }
        "files.write" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or_default();
            let data = args
                .get("data")
                .and_then(Value::as_str)
                .and_then(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).ok());
            let Some(data) = data else {
                return protocol_error(&id, "invalid_args", "path and base64 data are required");
            };
            let target = PathBuf::from(path);
            // ONE authorization+write path: the parent resolves and must sit
            // inside the roots; the final component opens O_NOFOLLOW against
            // the FIXED parent descriptor (a dangling or swapped symlink can
            // never redirect the write outside, and there is no check→open
            // window — see file_access::write_through_allowed_parent).
            let outcome = {
                let roots = state.file_roots.lock().unwrap();
                crate::file_access::write_through_allowed_parent(&roots, &target, &data)
            };
            match outcome {
                Ok(()) => protocol_ok(&id, json!({ "written": path })),
                Err(refusal) => {
                    let code = match refusal {
                        crate::file_access::WriteRefusal::Io(_) => "io",
                        _ => "unauthorized_scope",
                    };
                    protocol_error(&id, code, &refusal.to_string())
                }
            }
        }
        "files.index" => crate::file_resources::handle_files_index(state, &id, &args),
        "desktop.describePaths" => crate::file_resources::handle_desktop_describe_paths(&id, &args),
        "desktop.readImages" => crate::file_resources::handle_desktop_read_images(&id, &args),
        "desktop.saveFile" => crate::file_resources::handle_desktop_save_file(state, &id, &args),
        "chats.extractAttachmentText" => {
            crate::file_resources::handle_chats_extract_attachment_text(state, &id, &args)
        }
        "chats.revealFolder" => crate::file_resources::handle_chats_reveal_folder(state, &id, &args),
        "chats.revealDownload" => crate::file_resources::handle_chats_reveal_download(&id, &args),
        other => protocol_error(&id, "unknown_op", &format!("unknown operation {other}")),
    }
}

/// The request envelope's id, for error envelopes built after the request
/// itself has moved into the blocking task ("?" for anything not shaped
/// like an envelope — dispatch already refuses that shape).
fn envelope_id(raw: &Value) -> String {
    raw.get("id").and_then(Value::as_str).unwrap_or("?").to_string()
}

/// The concurrency cap for envelope dispatches through the async entry:
/// headroom for the page's bursts (state probes beside a slow management
/// op) while a flooding page cannot grow the blocking pool unbounded.
/// Excess requests QUEUE on the gate — backpressure the frontend already
/// handles, since every invoke is an awaited request/response.
pub const IPC_MAX_CONCURRENT_DISPATCH: usize = 16;

/// The product dispatch path the async `pi_ipc` command AND the static-UI
/// acceptance harness share — one gate, one blocking pool, the same caps.
/// The harness must never grow a dispatch path the product lacks (nor
/// serialize what the product runs concurrently).
///
/// Why not run envelopes inline: a SYNC command runs inline on the
/// WebView's IPC protocol thread — the platform UI thread (wry's
/// webkitgtk URI-scheme handler is not `Send` and runs on the GTK main
/// loop; WebView2 raises WebResourceRequested on the UI thread) — so ONE
/// slow op (a management child spawn, a big session scan) froze every
/// later invoke, asset load and the window itself. The async command moves
/// the wrapper off that thread; `spawn_blocking` keeps the blocking
/// envelope work off the async workers.
///
/// Cancellation/shutdown contract: the webview abandoning its invoke does
/// NOT cancel an in-flight envelope (Tauri has no mid-command cancel);
/// every op keeps its own timeout, and children die by their existing
/// stdin-EOF/grace-kill paths when the process exits — the gate never
/// blocks process exit.
pub async fn dispatch_envelope_gated(state: Arc<IpcHostState>, request: Value) -> Value {
    let id = envelope_id(&request);
    let gate = Arc::clone(&state.dispatch_gate);
    let permit = match gate.acquire_owned().await {
        Ok(permit) => permit,
        Err(_) => {
            return protocol_error(&id, "host_error", "the dispatch gate is closed");
        }
    };
    match tauri::async_runtime::spawn_blocking(move || {
        let _held = permit;
        dispatch_envelope(&state, request)
    })
    .await
    {
        Ok(response) => response,
        Err(error) => protocol_error(
            &id,
            "host_error",
            &format!("the dispatch task failed: {error}"),
        ),
    }
}

/// The IPC entry point. The static frontend invokes this with the request
/// envelope; the response envelope is protocol version 1.
///
/// Async BY DESIGN (see [`dispatch_envelope_gated`]): the sync variant ran
/// every envelope inline on the WebView's protocol/UI thread, where one
/// slow management op froze every other invoke and the window itself. The
/// body only hands an owned state handle to the gated entry. The state
/// comes from the `AppHandle` (not a `State<'_, _>` argument) because an
/// async command must return a `Result` to carry borrowed arguments — the
/// envelope is the reply shape, so the handle is the honest input.
#[tauri::command]
pub async fn pi_ipc(app: tauri::AppHandle, request: Value) -> Value {
    let state = app.state::<Arc<IpcHostState>>().inner().clone();
    dispatch_envelope_gated(state, request).await
}

// --- the session view (sessions.get / sessions.context / sessions.state) ---

fn terminal_shell(state: &IpcHostState) -> Result<(PathBuf, Vec<String>), (String, String)> {
    #[cfg(test)]
    if let Some(shell) = state.terminal_test_shell.lock().unwrap().clone() { return Ok(shell); }
    let _guard = state.terminal_management_lock.lock().unwrap();
    let value = management_call(state, "terminal.resolveShell", json!({}))?;
    let path = value.get("path").and_then(Value::as_str).filter(|p| !p.is_empty())
        .ok_or_else(|| ("io".to_string(), "terminal shell path missing".to_string()))?;
    let args = value.get("args").and_then(Value::as_array)
        .ok_or_else(|| ("io".to_string(), "terminal shell arguments missing".to_string()))?
        .iter().map(|arg| arg.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>().ok_or_else(|| ("io".to_string(), "invalid terminal shell arguments".to_string()))?;
    Ok((PathBuf::from(path), args))
}

/// One management-op call: the instance is per-scope on demand (60 s idle
/// recycle), and every failure is (code, message) — never a fallback that
/// would present a disk tail as a live view or an empty context as success.
pub(crate) fn management_call(
    state: &IpcHostState,
    op: &str,
    args: Value,
) -> Result<Value, (String, String)> {
    let config = state.management_config.lock().unwrap().clone();
    let Some(config) = config else {
        return Err((
            "management_unavailable".to_string(),
            "the management instance is not configured (the vendored module tree is missing)".to_string(),
        ));
    };
    let instance = state
        .management
        .instance("global", &config)
        .map_err(|error| ("management_unavailable".to_string(), error))?;
    instance
        .management_call_sync(op, args)
        .map_err(|error| management_error_code(&error))
}

/// The cwd gate every models op shares — the Next routes' 400/403 half:
/// an existing directory inside the host's allowed roots. The composition
/// and write paths live behind the seam; access control stays host-side.
fn validate_scoped_cwd(
    state: &IpcHostState,
    cwd: &str,
) -> Result<(), (String, String)> {
    let folded = lexical_fold(cwd, cfg!(windows));
    let path = Path::new(&folded);
    if !path.is_dir() {
        return Err((
            "invalid_args".to_string(),
            format!("Directory does not exist: {cwd}"),
        ));
    }
    let roots = state.file_roots.lock().unwrap();
    if !roots.is_existing_path_allowed(path) {
        return Err((
            "access_denied".to_string(),
            "Access denied".to_string(),
        ));
    }
    Ok(())
}

/// `management_call` for a cwd-scoped instance: the models domain (and any
/// future op a trusted project's resources must load for) partitions by the
/// caller's cwd — the plan's global/verified-project split. The scope key is
/// the FOLDED absolute cwd so one project shares one child across spellings.
fn management_call_scoped(
    state: &IpcHostState,
    op: &str,
    args: &Value,
    scope_cwd: &Path,
) -> Result<Value, (String, String)> {
    let config = state.management_config.lock().unwrap().clone();
    let Some(config) = config else {
        return Err((
            "management_unavailable".to_string(),
            "the management instance is not configured (the vendored module tree is missing)".to_string(),
        ));
    };
    let scope = scope_cwd.to_string_lossy().into_owned();
    let instance = state
        .management
        .instance(&scope, &config)
        .map_err(|error| ("management_unavailable".to_string(), error))?;
    instance
        .management_call_sync(op, args.clone())
        .map_err(|error| management_error_code(&error))
}

/// The extension reports failures as "[code] message"; recover the code for
/// the protocol envelope (unknown codes stay io, never success).
fn management_error_code(error: &str) -> (String, String) {
    if let Some((code, rest)) = error.strip_prefix('[').and_then(|body| body.split_once(']')) {
        let code = code.to_string();
        let known = matches!(
            code.as_str(),
            "unknown_op"
                | "invalid_args"
                | "not_found"
                | "op_failed"
                | "invalid_cron"
                | "project_scope"
                | "last_model"
                | "models_config_read"
        );
        (
            if known { code } else { "io".to_string() },
            rest.trim().to_string(),
        )
    } else {
        ("io".to_string(), error.to_string())
    }
}

/// The closed payload of `models.enabledSet`: the op enum and every field
/// the write path knows, validated host-side (the route's 400 half), with
/// the extension payload rebuilt from the validated values only — the
/// mirror of the TS seam's parseEnabledModelsMutation, so an unknown or
/// wrong-typed field never reaches a management child. The field-error
/// texts are the seam's own (one vocabulary for every client).
fn validated_enabled_models_payload(args: &Value) -> Result<Value, String> {
    let op = args.get("op").and_then(Value::as_str).unwrap_or("");
    let enabled = args.get("enabled");
    let require_enabled = || -> Result<bool, String> {
        enabled
            .and_then(Value::as_bool)
            .ok_or_else(|| "enabled must be a boolean".to_string())
    };
    let string_array = |key: &str| -> Option<Vec<String>> {
        args.get(key).and_then(Value::as_array).map(|entries| {
            entries
                .iter()
                .map(|entry| entry.as_str().map(str::to_string))
                .collect::<Option<Vec<_>>>()
        })?
    };
    let rename_pairs = |key: &str| -> Option<Vec<Value>> {
        args.get(key).and_then(Value::as_array).map(|entries| {
            entries
                .iter()
                .map(|entry| {
                    let from = entry.get("from")?.as_str()?;
                    let to = entry.get("to")?.as_str()?;
                    if from.is_empty() || to.is_empty() {
                        return None;
                    }
                    Some(json!({ "from": from, "to": to }))
                })
                .collect::<Option<Vec<_>>>()
        })?
    };
    match op {
        "clear" | "prune" => Ok(json!({ "op": op })),
        "resync" => {
            let Some(renames) = rename_pairs("renames") else {
                return Err("Invalid resync payload".to_string());
            };
            // modelRenames/fullyEnabled default to empty, like the seam's parse.
            let model_renames = match args.get("modelRenames") {
                Some(Value::Array(_)) => rename_pairs("modelRenames")
                    .ok_or_else(|| "Invalid resync payload".to_string())?,
                _ => Vec::new(),
            };
            let fully_enabled = match args.get("fullyEnabled") {
                Some(Value::Array(_)) => string_array("fullyEnabled")
                    .ok_or_else(|| "Invalid resync payload".to_string())?,
                _ => Vec::new(),
            };
            Ok(json!({
                "op": "resync",
                "renames": renames,
                "modelRenames": model_renames,
                "fullyEnabled": fully_enabled,
            }))
        }
        "provider" => {
            let enabled = require_enabled()?;
            let Some(provider) = args
                .get("provider")
                .and_then(Value::as_str)
                .filter(|provider| !provider.is_empty())
            else {
                return Err("provider is required".to_string());
            };
            Ok(json!({ "op": "provider", "provider": provider, "enabled": enabled }))
        }
        "models" => {
            let enabled = require_enabled()?;
            let Some(refs) = string_array("refs") else {
                return Err("refs must be an array of strings".to_string());
            };
            Ok(json!({ "op": "models", "refs": refs, "enabled": enabled }))
        }
        _ => Err("Invalid op".to_string()),
    }
}

/// The closed ENVELOPE of `modelsConfig.put`: the draft must be a JSON
/// object, and a `providers` field — when present — must be an object of
/// provider objects (the merge's own precondition; a non-object provider
/// value failed the old write path too). Everything inside is user
/// configuration (unknown fields are the file's own schema) and passes
/// VERBATIM to the ONE composition, whose sanitize/normalize layers are
/// the only writers of those rules — never duplicated here.
fn validated_models_config_payload(args: &Value) -> Result<Value, String> {
    let config = args
        .get("config")
        .ok_or_else(|| "config is required".to_string())?;
    let object = config
        .as_object()
        .ok_or_else(|| "config must be a JSON object".to_string())?;
    if let Some(providers) = object.get("providers") {
        let providers = providers
            .as_object()
            .ok_or_else(|| "providers must be a JSON object".to_string())?;
        for (provider_id, provider) in providers {
            if !provider.is_object() {
                return Err(format!("providers.{provider_id} must be a JSON object"));
            }
        }
    }
    Ok(config.clone())
}

fn validated_models_discover_payload(args: &Value) -> Result<(String, Value), String> {
    let provider_name = args
        .get("providerName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "providerName is required".to_string())?;
    let provider = args
        .get("provider")
        .filter(|p| p.is_object())
        .ok_or_else(|| "provider must be a JSON object".to_string())?;
    Ok((provider_name.to_string(), provider.clone()))
}

fn validated_models_test_payload(args: &Value) -> Result<(String, Value, Value), String> {
    let provider_name = args
        .get("providerName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "providerName is required".to_string())?;
    let provider = args
        .get("provider")
        .filter(|p| p.is_object())
        .ok_or_else(|| "provider must be a JSON object".to_string())?;
    let model = args
        .get("model")
        .filter(|m| m.is_object())
        .ok_or_else(|| "model must be a JSON object".to_string())?;
    let model_id = model
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Model ID is required".to_string())?;
    let _ = model_id;
    Ok((provider_name.to_string(), provider.clone(), model.clone()))
}

/// Assemble the `info` object (the SessionInfo shape the sidebar and
/// AppShell consume): the catalogue scan's per-file fields plus the host's
/// workspace classification and git project identity — exactly what
/// attachSessionProjectInfo layered on the Next server.
#[allow(clippy::too_many_arguments)]
fn session_info_json(
    state: &IpcHostState,
    agent_dir: &Path,
    scan: &session_host::history::ScannedSession,
    parent_session_id: Option<&str>,
    relation: Option<Value>,
    message_count: u64,
    live: bool,
) -> Value {
    let cwd = PathBuf::from(&scan.cwd);
    // The detail view's modified is the FILE mtime (the catalogue uses
    // last-message activity instead — different fields, both correct).
    let modified_ms = std::fs::metadata(&scan.path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(scan.modified_ms);
    let mut info = json!({
        "path": scan.path.display().to_string(),
        "id": scan.id,
        "cwd": scan.cwd,
        "created": ms_to_iso(scan.created_ms),
        "modified": ms_to_iso(modified_ms),
        "messageCount": message_count,
        "firstMessage": scan.first_message,
        "transient": false,
    });
    if let Some(name) = &scan.name {
        info["name"] = json!(name);
    }
    if scan.compaction_count > 0 {
        info["compactionCount"] = json!(scan.compaction_count);
    }
    if let Some(parent) = parent_session_id {
        info["parentSessionId"] = json!(parent);
    }
    if let Some(relation) = relation {
        info["relation"] = relation;
    }
    // Workspace classification: chats stay out of projects, worktrees and
    // project trust (the fork's chat policy boundary).
    if crate::session_view::is_chat_workspace_path(&cwd, agent_dir) {
        info["workspaceKind"] = json!("chat");
        if crate::session_view::is_chat_folder_path(&cwd, agent_dir) {
            info["chatFolder"] = json!(true);
        }
    } else {
        info["workspaceKind"] = json!("project");
        let project = state.projects.resolve(&cwd);
        info["projectRoot"] = json!(project.project_root.display().to_string());
        info["projectKey"] = json!(crate::session_view::project_identity_key(&project.project_root));
        if let Some(branch) = project.branch {
            info["branch"] = json!(branch);
        }
        if project.is_worktree {
            info["isWorktree"] = json!(true);
        }
    }
    let _ = live;
    info
}

/// sessions.get / sessions.context / sessions.state (the GET /api/sessions/[id]
/// family). Returns (code, message) failures; the caller maps them onto the
/// protocol envelope.
fn session_view_dispatch(
    state: &IpcHostState,
    op: &str,
    args: &Value,
) -> Result<Value, (String, String)> {
    let session_id = args.get("session").and_then(Value::as_str).unwrap_or_default();
    if session_id.is_empty() {
        return Err(("invalid_args".to_string(), "session is required".to_string()));
    }
    let agent_dir = state.agent_dir();

    match op {
        // The lease renewal (POST /api/agent/[id]/lease): extend the idle
        // lease and answer how many live event subscriptions hold it — the
        // hook's self-heal (renewed 0 while it thinks it is attached)
        // survives the transport swap.
        "sessions.lease" => {
            let Some(session) = state.registry.get(session_id) else {
                return Ok(json!({ "renewed": 0 }));
            };
            session.lease();
            let renewed = state
                .event_relays
                .lock()
                .unwrap()
                .values()
                .filter(|relay| relay.session_id == session_id)
                .count() as u64;
            Ok(json!({ "renewed": renewed }))
        }
        // { running, state } — the /api/agent/[id] GET and
        // /api/sessions/[id]/state contract (both identical).
        "sessions.state" => {
            if let Some(session) = state.registry.get(session_id) {
                session.lease();
                let raw = session
                    .get_state()
                    .map_err(|error| ("agent_child_error".to_string(), error.to_string()))?;
                let machine = session.run_state();
                // The context meter's source: the child's own stats command
                // (the wrapper cached it per run; the host asks now — the
                // poll cadence is the wrapper's refresh cadence).
                let stats = session
                    .command("get_session_stats", json!({}), Some(Duration::from_secs(30)))
                    .ok();
                let context_usage = stats
                    .as_ref()
                    .and_then(|stats| stats.get("contextUsage"))
                    .filter(|usage| !usage.is_null())
                    .cloned()
                    .map(|usage| json!({
                        "percent": usage.get("percent").cloned().unwrap_or(Value::Null),
                        "contextWindow": usage.get("contextWindow").cloned().unwrap_or(Value::Null),
                        "tokens": usage.get("tokens").cloned().unwrap_or(Value::Null),
                    }));
                let model = raw.get("model").cloned().unwrap_or(Value::Null);
                let (pending, pending_version) = session.composer_outbox.snapshot();
                let queued_messages = json!({
                    "steering": machine.steering_queue,
                    "followUp": machine.follow_up_queue,
                    "pending": pending,
                    "pendingVersion": pending_version,
                    // The unknown-outcome barrier's state wire (P1-5B): a
                    // reload/reconnect must still see which delivery needs
                    // the user's confirmation before any resend — without
                    // this the parked item looks like a plain pending row.
                    "frontDeliveryUnknown": session.composer_outbox.front_is_unknown(),
                });
                let state_json = json!({
                    "sessionId": raw.get("sessionId").cloned().unwrap_or(json!(session_id)),
                    "sessionFile": raw.get("sessionFile").cloned().unwrap_or(Value::Null),
                    "isStreaming": raw.get("isStreaming").and_then(Value::as_bool).unwrap_or(false),
                    "streamingMessage": session.streaming_message_value(),
                    // A prompt is "running" while its admission is unresolved
                    // (the wrapper's pendingPromptCount); the CLI child answers
                    // admission synchronously, so a dispatch that returned had
                    // already passed or failed it.
                    "isPromptRunning": false,
                    "isBashRunning": raw.get("isBashRunning").and_then(Value::as_bool),
                    "isCompacting": raw.get("isCompacting").and_then(Value::as_bool).unwrap_or(false),
                    "autoCompactionEnabled": raw.get("autoCompactionEnabled").cloned().unwrap_or(Value::Null),
                    // Unknown until the child proves it (the repo's hard rule):
                    // only set_auto_retry or an auto_retry_start event may set it.
                    "autoRetryEnabled": machine.auto_retry_enabled,
                    "steeringMode": raw.get("steeringMode").cloned().unwrap_or(Value::Null),
                    "followUpMode": raw.get("followUpMode").cloned().unwrap_or(Value::Null),
                    "model": model,
                    "thinkingLevel": raw.get("thinkingLevel").cloned().unwrap_or(Value::Null),
                    "messageCount": raw.get("messageCount").and_then(Value::as_u64).unwrap_or(0),
                    "pendingMessageCount": raw.get("pendingMessageCount").and_then(Value::as_u64).unwrap_or(0),
                    "queuedMessages": queued_messages,
                    // The context meter (null when the child cannot calculate
                    // usage — unknown is not zero).
                    "contextUsage": context_usage.unwrap_or(Value::Null),
                    // The system panel's prompt: replaying the transcript's
                    // system messages needs the SDK's own projection — served
                    // with the readView family, not yet this poll (README's
                    // unfixed list keeps it honest).
                    "systemPrompt": "",
                    "systemPromptStatus": "none",
                    "extensionStatuses": [],
                    "extensionWidgets": [],
                });
                return Ok(json!({ "running": session.run_state().is_running(), "state": state_json }));
            }
            // Not running: the on-disk existence check answers not_found
            // exactly like the route (never an invented empty state).
            if session_host::history::find_session_by_id(&agent_dir, session_id).is_none() {
                return Err(("not_found".to_string(), format!("Session not found: {session_id}")));
            }
            // The composer outbox OUTLIVES the child (the session-id store):
            // a reload after an eviction — or after a delivery whose outcome
            // went UNKNOWN and the child died — must still see the queue and
            // its unknown barrier (the HTTP route answered the same shape).
            let outbox = state.registry.composer_outbox_for(session_id);
            if outbox.has_items() {
                let (pending, pending_version) = outbox.snapshot();
                return Ok(json!({
                    "running": false,
                    "state": {
                        "queuedMessages": {
                            "steering": [],
                            "followUp": [],
                            "pending": pending,
                            "pendingVersion": pending_version,
                            "frontDeliveryUnknown": outbox.front_is_unknown(),
                        },
                    },
                }));
            }
            Ok(json!({ "running": false }))
        }

        // The /api/sessions/[id]/context contract: branch paging over the
        // append-only file (explicit leafId / before always address the disk
        // view, exactly like the route).
        "sessions.context" => {
            let summary = session_host::history::find_session_by_id(&agent_dir, session_id)
                .ok_or_else(|| ("not_found".to_string(), format!("Session not found: {session_id}")))?;
            let mut call_args = json!({ "file": summary.file.display().to_string() });
            for field in ["leafId", "before"] {
                if let Some(value) = args.get(field).and_then(Value::as_str) {
                    call_args[field] = json!(value);
                }
            }
            if let Some(tail) = args.get("tail").and_then(Value::as_u64) {
                call_args["tail"] = json!(tail);
            }
            copy_bool_arg(args, &mut call_args, "deferThinking");
            copy_bool_arg(args, &mut call_args, "deferMedia");
            copy_bool_arg(args, &mut call_args, "wholeTurns");
            management_call(state, "session.readContext", call_args)
        }

        // GET /api/sessions/[id]: the live one-shot snapshot when a child
        // owns the session (CLI-authoritative branch), else the disk view.
        "sessions.get" => {
            let summary = session_host::history::find_session_by_id(&agent_dir, session_id);
            let live = state.registry.get(session_id);
            let (file, source_id) = match (&live, &summary) {
                (Some(session), _) => (session.session_file.clone(), format!("runtime:{session_id}")),
                (None, Some(summary)) => (summary.file.clone(), "disk".to_string()),
                (None, None) => {
                    return Err(("not_found".to_string(), format!("Session not found: {session_id}")))
                }
            };
            if let Some(session) = &live {
                session.lease();
            }

            let defer_thinking = args.get("deferThinking").and_then(Value::as_bool).unwrap_or(false);
            let defer_media = args.get("deferMedia").and_then(Value::as_bool).unwrap_or(false);
            let summary_tree = args.get("summaryTree").and_then(Value::as_bool).unwrap_or(false);
            let tail = args.get("tail").and_then(Value::as_u64).unwrap_or(50);
            let whole_turns = args.get("wholeTurns").and_then(Value::as_bool).unwrap_or(false);

            // 1. The projection (live snapshot handoff or the disk view).
            let (projection, relation) = if let Some(session) = &live {
                let (entries, leaf_id, tree) = crate::session_view::live_child_snapshot(session)
                    .map_err(|message| ("agent_child_error".to_string(), message))?;
                let handoff = crate::session_view::write_snapshot_handoff(
                    &entries,
                    leaf_id.as_deref(),
                    &tree,
                )
                .map_err(|error| ("io".to_string(), error.to_string()))?;
                let call_args = json!({
                    "snapshotFile": handoff.display().to_string(),
                    "sessionId": session_id,
                    "sessionPath": file.display().to_string(),
                    "summaryTree": summary_tree,
                    "deferThinking": defer_thinking,
                    "deferMedia": defer_media,
                    "tail": tail,
                    "wholeTurns": whole_turns,
                });
                let result = management_call(state, "session.projectSnapshot", call_args);
                let _ = std::fs::remove_file(&handoff);
                let result = result?;
                let relation = result.get("relation").cloned();
                (result, relation)
            } else {
                let call_args = json!({
                    "file": file.display().to_string(),
                    "summaryTree": summary_tree,
                    "deferThinking": defer_thinking,
                    "deferMedia": defer_media,
                    "tail": tail,
                    "wholeTurns": whole_turns,
                });
                let result = management_call(state, "session.readView", call_args)?;
                let relation = result.get("relation").cloned();
                (result, relation)
            };

            // 2. The info object needs the scan + the parent id.
            let scan = session_host::history::scan_session_file_info(&file)
                .ok_or_else(|| ("not_found".to_string(), format!("the session file is unreadable: {}", file.display())))?;
            let parent_session_id = scan
                .parent_session_path
                .as_deref()
                .and_then(|parent| session_host::history::read_header_id(Path::new(parent)));
            let relation = relation.or_else(|| {
                parent_session_id.as_deref().map(|parent| {
                    json!({ "kind": "fork", "originSessionId": parent })
                })
            });
            let message_count = projection
                .get("stats")
                .and_then(|stats| stats.get("totalMessages"))
                .and_then(Value::as_u64)
                .unwrap_or(scan.message_count);
            let info = session_info_json(
                state,
                &agent_dir,
                &scan,
                parent_session_id.as_deref(),
                relation,
                message_count,
                live.is_some(),
            );

            // 3. The snapshot revision (the host owns the fingerprint half).
            let revision = crate::session_view::snapshot_revision(
                &file,
                &source_id,
                projection
                    .get("entryCount")
                    .and_then(Value::as_u64)
                    .unwrap_or_default() as usize,
                projection
                    .get("latestEntryId")
                    .and_then(Value::as_str),
                projection.get("leafId").and_then(Value::as_str),
            );

            let mut data = json!({
                "sessionId": session_id,
                "filePath": file.display().to_string(),
                "info": info,
                "leafId": projection.get("leafId").cloned().unwrap_or(Value::Null),
                "tree": projection.get("tree").cloned().unwrap_or(json!([])),
                "snapshotRevision": revision,
                "context": projection.get("context").cloned().unwrap_or(json!({})),
                "stats": projection.get("stats").cloned().unwrap_or(json!({})),
                "totalActiveMs": projection.get("totalActiveMs").cloned().unwrap_or(json!(0)),
            });
            if summary_tree {
                data["treeFormat"] = json!("summary");
            }
            if let Some(tool_names) = projection.get("toolNames") {
                data["toolNames"] = tool_names.clone();
            }
            Ok(data)
        }
        other => Err(("unknown_op".to_string(), format!("unknown operation {other}"))),
    }
}

fn copy_bool_arg(args: &Value, into: &mut Value, field: &str) {
    if let Some(value) = args.get(field).and_then(Value::as_bool) {
        into[field] = json!(value);
    }
}

// --- the spawn plan (sessions.create + the resume path) ---------------------
//
// What `startRpcSessionLocked` + `startCliRpcSessionFromManager` computed
// per session on the Next server, computed here from the same inputs: the
// cwd's workspace classification, the session file's persisted state (tool
// pin, chat unlock marker, saved model) and the request's explicit picks.

/// Pi Web's own settings block for chats (`lib/chat-settings.ts`: the model
/// and reasoning level a NEW chat starts on when the request picks none).
fn read_chat_settings(agent_dir: &Path) -> (Option<(String, String)>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(agent_dir.join("pi-web").join("settings.json")) else {
        return (None, None);
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return (None, None);
    };
    let chats = parsed.get("chats").cloned().unwrap_or(Value::Null);
    let model = chats
        .get("model")
        .and_then(|model| {
            let provider = model.get("provider").and_then(Value::as_str)?;
            let model_id = model.get("modelId").and_then(Value::as_str)?;
            (!provider.is_empty() && !model_id.is_empty()).then(|| (provider.to_string(), model_id.to_string()))
        });
    let thinking = chats
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .filter(|level| {
            matches!(*level, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
        })
        .map(str::to_string);
    (model, thinking)
}

/// Whether a session file's branch already carries a real message (a chat
/// starts applying Settings › Chats only while it is still empty).
fn file_has_messages(file: &Path) -> bool {
    let Ok(handle) = std::fs::File::open(file) else { return false };
    use std::io::BufRead;
    for line in std::io::BufReader::new(handle).lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<Value>(&line) else { continue };
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let role = entry
            .get("message")
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str);
        if role != Some("system") {
            return true;
        }
    }
    false
}

/// One request's explicit picks (POST /api/agent/new's provider/modelId/
/// toolNames/thinkingLevel).
#[derive(Default)]
struct SpawnRequest {
    tool_names: Option<Vec<String>>,
    initial_model: Option<(String, String)>,
    thinking_level: Option<String>,
}

/// Build the spawn plan for one session (create or resume). `session_file`
/// exists in both cases (create made the header first); `persist_new_pin`
/// writes a requested pin into a session that has none yet — the create
/// path only (resume never rewrites the file).
#[allow(clippy::too_many_arguments)]
fn build_spawn_plan(
    state: &IpcHostState,
    base: &SpawnBase,
    cwd: &Path,
    session_file: &Path,
    request: &SpawnRequest,
    persist_new_pin: bool,
) -> Result<session_host::SessionSpawnConfig, String> {
    let agent_dir = state.agent_dir();

    // 1. The kind (chat root never reaches here — create turns it into a
    // folder first; a resumed chat file carries its folder/legacy cwd).
    let chat_workspace = crate::session_view::is_chat_workspace_path(cwd, &agent_dir);
    let chat_folder = crate::session_view::is_chat_folder_path(cwd, &agent_dir);

    // 2. The saved model (the file's own model wins; the request's initial
    // pick only fills a session that never chose one).
    let saved_model = session_host::spawn_plan::read_saved_model(session_file).or(request.initial_model.clone());

    let config = if chat_workspace {
        // A chat: the unlock marker decides the loadout; a chat has no tool
        // preset of its own (the request's toolNames is ignored — the
        // workspace policy decides, server-side). Unlocking lets a chat use
        // the computer, so a persisted marker is honoured ONLY for a folder
        // chat (the Next factory's gate: a legacy shared-workspace session
        // file that carries the marker keeps the locked loadout; the desktop
        // host is local-only, so the network-exposure half of the old gate
        // is structural here).
        let unlocked = chat_folder
            && session_host::spawn_plan::read_chat_unlocked(session_file);
        // Chats read Settings › Chats while they are still empty.
        let (chat_model, chat_thinking) = if file_has_messages(session_file) {
            (None, None)
        } else {
            read_chat_settings(&agent_dir)
        };
        let model = saved_model.or(chat_model);
        let thinking = request.thinking_level.clone().or(chat_thinking);
        let prompt = chat_prompt(state, true, chat_folder, unlocked)?;
        let prompt_file = session_host::spawn_plan::write_prompt_file(&prompt)
            .map_err(|error| format!("the chat prompt file could not be written: {error}"))?;
        let shape = session_host::SessionSpawnShape::Chat {
            prompt_file,
            folder: chat_folder,
            unlocked,
            // A chat's file tools are a local-only capability; the desktop
            // host is never network-exposed.
            files_enabled: true,
        };
        session_host::SessionSpawnConfig {
            executable: base.executable.clone(),
            agent_dir: Some(agent_dir.clone()),
            session_dir: Some(crate::session_view::default_session_dir(&agent_dir, cwd)),
            bridge_asset: base.bridge_asset.clone(),
            artifacts_asset: base.artifacts_asset.clone(),
            chat_asset: base.chat_asset.clone(),
            // The pinned digest of the SHIPPED asset (embedded bytes) — the
            // session host fails a chat closed when the resolved file does
            // not match it. No pin without an asset: only the Chat shape
            // requires one.
            chat_asset_sha256: base.chat_asset.as_ref().map(|_| shipped_chat_asset_sha256().to_string()),
            shape,
            initial_model: model,
            thinking_level: thinking,
            extra_args: Vec::new(),
        }
    } else {
        // A project session: the persisted pin wins over the request's; a
        // new pin is persisted before the child opens the file (exactly the
        // Next factory's order).
        let persisted = session_host::spawn_plan::read_session_tool_selection(session_file);
        let requested = request.tool_names.clone();
        if persist_new_pin && persisted.is_none() {
            if let Some(names) = &requested {
                session_host::spawn_plan::append_custom_entry(
                    session_file,
                    session_host::spawn_plan::TOOL_SELECTION_TYPE,
                    json!({ "version": 1, "tools": names }),
                )
                .map_err(|error| format!("the tool pin could not be persisted: {error}"))?;
            }
        }
        let selection = persisted.or(requested);
        let (shape, model, thinking) = match selection {
            Some(names) if names.is_empty() => {
                // The chat-only pin: the exact prompt built from the cwd's
                // context files replaces pi's own.
                let prompt = chat_only_prompt(state, cwd)?;
                let prompt_file = session_host::spawn_plan::write_prompt_file(&prompt)
                    .map_err(|error| format!("the chat-only prompt file could not be written: {error}"))?;
                (
                    session_host::SessionSpawnShape::ChatOnly { prompt_file },
                    saved_model,
                    request.thinking_level.clone(),
                )
            }
            Some(names) => {
                let default_tools = session_host::spawn_plan::resolved_default_tools(
                    &agent_dir,
                    cwd,
                    crate::session_view::project_trusted(&agent_dir, cwd),
                );
                let entries = session_host::spawn_plan::build_tool_entries(&names, default_tools.as_ref());
                (
                    session_host::SessionSpawnShape::Project { tool_args: Some(entries) },
                    saved_model,
                    request.thinking_level.clone(),
                )
            }
            None => (
                session_host::SessionSpawnShape::Project { tool_args: None },
                saved_model,
                request.thinking_level.clone(),
            ),
        };
        session_host::SessionSpawnConfig {
            executable: base.executable.clone(),
            agent_dir: Some(agent_dir.clone()),
            session_dir: Some(crate::session_view::default_session_dir(&agent_dir, cwd)),
            bridge_asset: base.bridge_asset.clone(),
            artifacts_asset: base.artifacts_asset.clone(),
            chat_asset: base.chat_asset.clone(),
            // The pinned digest of the SHIPPED asset (embedded bytes) — the
            // session host fails a chat closed when the resolved file does
            // not match it. No pin without an asset: only the Chat shape
            // requires one.
            chat_asset_sha256: base.chat_asset.as_ref().map(|_| shipped_chat_asset_sha256().to_string()),
            shape,
            initial_model: model,
            thinking_level: thinking,
            extra_args: Vec::new(),
        }
    };
    Ok(config)
}

/// The chat preamble (ONE implementation: `chatWorkspacePrompt` in
/// lib/chat-workspace-policy.ts, served by the management instance from the
/// vendored bundle — never a Rust copy of the prompt text).
fn chat_prompt(state: &IpcHostState, files_enabled: bool, folder: bool, unlocked: bool) -> Result<String, String> {
    let result = management_call(
        state,
        "chat.systemPrompt",
        json!({ "filesEnabled": files_enabled, "folder": folder, "unlocked": unlocked }),
    )
    .map_err(|(code, message)| format!("the chat prompt could not be built ({code}): {message}"))?;
    result
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "the chat prompt op answered no prompt".to_string())
}

/// The chat-only pin's exact prompt: the session cwd's context files joined
/// in pi's discovery order (contextFilesSystemPrompt over the resource
/// loader — same op shape the Next server ran offline).
fn chat_only_prompt(state: &IpcHostState, cwd: &Path) -> Result<String, String> {
    let result = management_call(
        state,
        "session.chatOnlyPrompt",
        json!({
            "cwd": cwd.display().to_string(),
            // The host's agent dir, explicitly: PI_CODING_AGENT_DIR already
            // IS the complete agent dir (the SDK's convention), and without
            // this the extension would append /.pi/agent to it and read a
            // nested directory that does not exist.
            "agentDir": state.agent_dir().display().to_string(),
        }),
    )
    .map_err(|(code, message)| format!("the chat-only prompt could not be built ({code}): {message}"))?;
    result
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "the chat-only prompt op answered no prompt".to_string())
}

/// POST /api/agent/new (the `sessions.create` op): a brand-new session.
/// Most calls immediately send the first command; `type:"ensure_session"`
/// only creates the runtime so clients can query commands. Answers pi's
/// real session id plus the model/thinking state selected at startup.
///
/// The failure shape keeps the route's contract: a prompt-type create that
/// never reached the child answers `prompt_rejected` with `accepted:false`
/// (details on the protocol error object) — the composer's no-blind-retry
/// admission signal.
fn create_session(
    state: &IpcHostState,
    args: &Value,
) -> Result<Value, (String, String, Option<Value>)> {
    let invalid = |message: &str, command_type: Option<&str>| -> (String, String, Option<Value>) {
        let rejected = command_type == Some("prompt");
        (
            "invalid_args".to_string(),
            message.to_string(),
            rejected.then(|| json!({ "code": "prompt_rejected", "accepted": false })),
        )
    };

    // 1. The cwd (the body's `cwd`; everything else is the first command).
    let Some(cwd_text) = args.get("cwd").and_then(Value::as_str) else {
        return Err(invalid("cwd is required", command_type(args).as_deref()));
    };
    if cwd_text.is_empty() {
        return Err(invalid("cwd is required", command_type(args).as_deref()));
    }
    let command_type = command_type(args);
    let agent_dir = state.agent_dir();
    // The cwd is resolved to ONE absolute lexical identity BEFORE any
    // classification or probe (Terra P1-4 + round-4): an absolute path
    // carrying `..` that POINTS at a chat folder must classify as a chat
    // (and the session header carry the folded identity), and a RELATIVE
    // path is anchored at the host's working directory — the same place the
    // Next server's raw-string cwd effectively landed (its existsSync and
    // its spawn resolved relatives against the server process cwd). Keeping
    // relatives raw here would let a relative form that points at a chat
    // folder classify as a PROJECT and spawn with project policy.
    // `~` is NOT expanded at this entry: the Next route never did (a literal
    // `~` failed its existsSync), and the UI only ever sends the absolute
    // identity the cwd picker already resolved.
    let requested_cwd = resolve_cwd_identity(
        cwd_text,
        false,
        &user_home_dir(),
        &std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        cfg!(windows),
    )
    .map_err(|message| invalid(&message, command_type.as_deref()))?;

    let chat_root = crate::session_view::is_chat_root_path(&requested_cwd, &agent_dir);
    let chat_workspace = crate::session_view::is_chat_workspace_path(&requested_cwd, &agent_dir);
    if chat_workspace {
        // ensureChatWorkspace runs before the folder factory (both private).
        crate::session_view::ensure_chat_workspace(&agent_dir)
            .map_err(|error| ("io".to_string(), error.to_string(), None))?;
    }
    if !requested_cwd.is_dir() {
        return Err(invalid(
            &format!("Directory does not exist: {cwd_text}"),
            command_type.as_deref(),
        ));
    }

    // 2. The request's explicit picks (provider/modelId pair, toolNames,
    // thinkingLevel — the fields the route extracts from the command).
    let provider = args.get("provider").and_then(Value::as_str).map(str::to_string);
    let model_id = args.get("modelId").and_then(Value::as_str).map(str::to_string);
    if provider.is_some() != model_id.is_some() {
        return Err((
            "invalid_args".to_string(),
            "provider and modelId must be provided together".to_string(),
            None,
        ));
    }
    let initial_model = provider.zip(model_id);
    let thinking_level = args
        .get("thinkingLevel")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|level| {
            matches!(level.as_str(), "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max")
        });
    if args.get("thinkingLevel").is_some() && thinking_level.is_none() {
        return Err(invalid(
            &format!("Invalid thinking level: {}", args.get("thinkingLevel").unwrap()),
            command_type.as_deref(),
        ));
    }
    // A chat has no tool preset: a stale or hand-crafted client selection is
    // ignored — the workspace policy decides, server-side.
    let tool_names = if chat_workspace {
        None
    } else {
        match args.get("toolNames").and_then(Value::as_array) {
            Some(tools) => Some(
                session_host::spawn_plan::validate_tool_selection(tools).ok_or_else(|| {
                    invalid("toolNames must contain only built-in tool names", command_type.as_deref())
                })?,
            ),
            None => None,
        }
    };

    // 3. The session file: a chat requested with the ROOT gets a folder of
    // its own; every session's header is the host's (create_session_file).
    let session_cwd = if chat_root {
        crate::session_view::create_chat_folder(&agent_dir)
            .map_err(|error| ("io".to_string(), error.to_string(), None))?
    } else if chat_workspace {
        crate::session_view::ensure_chat_cwd(&requested_cwd)
            .map_err(|error| ("io".to_string(), error.to_string(), None))?;
        requested_cwd.clone()
    } else {
        requested_cwd.clone()
    };
    let session_dir = crate::session_view::default_session_dir(&agent_dir, &session_cwd);
    let (session_file, session_id) = session_host::create_session_file(&session_dir, &session_cwd)
        .map_err(|error| ("io".to_string(), error.to_string(), None))?;
    // A brand-new cwd is immediately browsable (allowFileRoot's contract).
    state.propose_path(&session_cwd);

    // 4. Spawn through the shared plan (kind, pin, prompts, model).
    let base = state
        .spawn_base
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| ("not_found".to_string(), "no pi executable resolved".to_string(), None))?;
    let request = SpawnRequest { tool_names, initial_model, thinking_level };
    let config = build_spawn_plan(state, &base, &session_cwd, &session_file, &request, true)
        .map_err(|message| ("op_failed".to_string(), message, None))?;
    let session = state
        .registry
        .start(&session_id, &session_file, &session_id, &session_cwd, &config)
        .map_err(|error| {
            let rejected = command_type.as_deref() == Some("prompt");
            (
                "agent_spawn_failed".to_string(),
                error.to_string(),
                rejected.then(|| json!({ "code": "prompt_rejected", "accepted": false })),
            )
        })?;
    // A new session in the list invalidates the client's catalogue cache.
    bump_session_list_version(state);

    // 5. The startup state the route answered (pi's real session id plus the
    // model/thinking state selected at startup).
    let child_state = session
        .get_state()
        .map_err(|error| ("agent_child_error".to_string(), error.to_string(), None))?;
    let model = child_state.get("model").and_then(|model| {
        let provider = model.get("provider").and_then(Value::as_str)?;
        let id = model.get("id").and_then(Value::as_str)?;
        Some(json!({ "provider": provider, "modelId": id }))
    });
    let thinking_level = child_state.get("thinkingLevel").cloned().unwrap_or(Value::Null);

    if command_type.as_deref() == Some("ensure_session") {
        return Ok(json!({
            "success": true,
            "sessionId": session_id,
            "data": null,
            "model": model.unwrap_or(Value::Null),
            "thinkingLevel": thinking_level,
        }));
    }

    // 6. The first command rides the same closed surface the composer uses
    // (the payload is rebuilt from the validated fields only).
    let command_type = command_type.ok_or_else(|| {
        invalid("the first command has no type", None)
    })?;
    let payload = session_host::build_agent_command(&command_type, args)
        .map_err(|error| ("invalid_args".to_string(), error.to_string(), None))?;
    let data = session
        .command(&command_type, payload, Some(std::time::Duration::from_secs(120)))
        .map_err(|error| {
            // The admission trichotomy (the plan's no-blind-retry rule):
            // only a child that ANSWERED its refusal is `prompt_rejected`
            // with `accepted:false` — the one signal the composer treats as
            // "definitely not executed, safe to restore the draft". A
            // timeout, a broken transport or an exited child leaves the
            // result UNKNOWN: the prompt may already be running, so the
            // error must not invite a resend. It carries the session
            // identity instead, for a state query.
            if command_type != "prompt" {
                return ("op_failed".to_string(), error.to_string(), None);
            }
            classify_first_prompt_error(&error, &session_id)
        })?;
    Ok(json!({
        "success": true,
        "sessionId": session_id,
        "data": data,
        "model": model.unwrap_or(Value::Null),
        "thinkingLevel": thinking_level,
    }))
}

/// The first prompt's error trichotomy (the plan's no-blind-retry rule):
/// - the child ANSWERED its refusal → `prompt_rejected` + `accepted:false`,
///   the only signal the composer treats as "definitely not executed";
/// - the child never came up → nothing was sent (also safe to restore);
/// - anything else (timeout, broken transport, exit) → the outcome is
///   UNKNOWN: the prompt may already be running. The error then carries the
///   session identity and NEVER `accepted:false`, so no caller resends.
fn classify_first_prompt_error(
    error: &pi_host::PiRpcError,
    session_id: &str,
) -> (String, String, Option<Value>) {
    match error.kind {
        pi_host::ErrorKind::Command => (
            "op_failed".to_string(),
            error.to_string(),
            Some(json!({ "code": "prompt_rejected", "accepted": false })),
        ),
        pi_host::ErrorKind::Spawn => (
            "agent_spawn_failed".to_string(),
            error.to_string(),
            Some(json!({ "code": "prompt_rejected", "accepted": false })),
        ),
        _ => (
            "prompt_unknown".to_string(),
            format!(
                "the prompt's outcome is unknown ({error}); the session may still be running it — query its state before resending"
            ),
            Some(json!({
                "code": "prompt_unknown",
                "accepted": null,
                "sessionId": session_id,
            })),
        ),
    }
}

/// The command type the create body carries (the route's `command.type`).
fn command_type(args: &Value) -> Option<String> {
    args.get("type")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The user's home directory (lib/user-home.ts's rule: PI_AGENT_HOME
/// overrides, the OS home otherwise).
fn user_home_dir() -> PathBuf {
    if let Ok(home) = std::env::var("PI_AGENT_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    #[cfg(unix)]
    {
        std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
    }
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
    #[cfg(not(any(unix, windows)))]
    {
        PathBuf::from(".")
    }
}

/// The HTTP route's `normalizeCwd` (app/api/cwd/validate/route.ts), ported
/// so the static host answers `~`, `~/foo` and relative paths exactly like
/// the server did — with the ORIGINAL's `path.resolve` semantics: the
/// joined path is LEXICALLY FOLDED (`.` dropped, `..` pops its parent)
/// BEFORE classification, so a `~/.pi/agent/chats/../chats/<folder>` the
/// user (or a crafted client) sends is classified against the FOLDED path
/// and cannot slip a chat folder past `is_chat_workspace_path` as a
/// project (Terra P1-4). Lexical only — never `canonicalize`: symlink
/// targets keep their meaning.
fn normalize_cwd(raw: &str) -> Result<PathBuf, String> {
    normalize_cwd_with_home(raw, user_home_dir())
}

/// `normalize_cwd` against an explicit home (the pure core, testable
/// without the process-global env). `~`/`~/…` expand against `home`.
fn normalize_cwd_with_home(raw: &str, home: PathBuf) -> Result<PathBuf, String> {
    resolve_cwd_identity(
        raw,
        true,
        &home,
        &std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        cfg!(windows),
    )
}

/// Resolve one accepted cwd string to its single ABSOLUTE lexical identity
/// (Terra round-4: both cwd entries — `agent.create` and
/// `workspace.validateCwd` — classify and probe against ONE resolved form,
/// so no accepted spelling can bypass the chat classification):
///
/// - `~` / `~/rest` expand against `home` (only where the old contract did:
///   the validate route's normalizeCwd; the create route kept raw strings);
/// - absolute paths fold lexically (`.` dropped, `..` pops, prefixes kept);
/// - plain relative paths anchor at `current_dir` — the same place the Next
///   server's process cwd anchored them (its existsSync and its spawn
///   resolved relatives there), never a guessed parent;
/// - Windows root-relative (`\work`) anchors at the current directory's
///   drive — the anchor `path.resolve` used — instead of being STRING-JOINED
///   onto the current directory (the old join produced `C:\current\work`,
///   touching the wrong directory);
/// - Windows drive-relative (`C:work`) resolves against `current_dir` when
///   the drive matches; a DIFFERENT drive's working directory is per-drive
///   OS state the host cannot see, so it is REFUSED honestly (the old join
///   silently produced `C:\current\work` for `D:work` — a mis-resolve);
/// - UNC/verbatim forms fold with their prefix intact.
///
/// Lexical only — never `canonicalize`: symlink targets keep their meaning.
pub(crate) fn resolve_cwd_identity(
    raw: &str,
    expand_home: bool,
    home: &Path,
    current_dir: &Path,
    windows: bool,
) -> Result<PathBuf, String> {
    let home_text = lexical_fold(&home.to_string_lossy(), windows);
    if expand_home {
        if raw == "~" {
            return Ok(PathBuf::from(home_text));
        }
        if let Some(rest) = raw.strip_prefix("~/") {
            return Ok(PathBuf::from(lexical_fold(&format!("{home_text}/{rest}"), windows)));
        }
    }
    if !windows {
        return if raw.starts_with('/') {
            Ok(PathBuf::from(lexical_fold(raw, false)))
        } else {
            let anchor = lexical_fold(&current_dir.to_string_lossy(), false);
            Ok(PathBuf::from(lexical_fold(&format!("{anchor}/{raw}"), false)))
        };
    }
    // Windows: classify by PREFIX (the string carries anchors
    // `Path::is_absolute` cannot see — it calls `\work` and `C:work`
    // relative, and the old code then STRING-JOINED both onto the current
    // directory, which is only correct for the plain-relative form).
    let normalized = raw.replace('\\', "/");
    let is_verbatim_or_unc = normalized.starts_with("//?/") || normalized.starts_with("//");
    let is_drive_absolute = normalized.len() >= 3
        && normalized.as_bytes()[1] == b':'
        && normalized.as_bytes()[2] == b'/';
    let is_drive_relative = normalized.len() >= 2
        && normalized.as_bytes()[1] == b':'
        && !is_drive_absolute;
    if is_verbatim_or_unc || is_drive_absolute {
        return Ok(PathBuf::from(lexical_fold(raw, true)));
    }
    if is_drive_relative {
        let drive = normalized[..2].to_ascii_uppercase();
        let rest = &normalized[2..];
        let anchor = lexical_fold(&current_dir.to_string_lossy(), true);
        if anchor.len() >= 2 && anchor.as_bytes()[1] == b':' && anchor[..2].to_ascii_uppercase() == drive {
            // The SAME drive as the working directory: anchor there.
            let rest = rest.trim_start_matches('/');
            return Ok(PathBuf::from(lexical_fold(&format!("{anchor}/{rest}"), true)));
        }
        return Err(format!(
            "cannot resolve the drive-relative path {raw:?}: drive {}'s working directory is per-drive OS state this host cannot see — use an absolute path",
            &drive[..1]
        ));
    }
    // Root-relative (`\work` / `/work`): anchor at the working directory's
    // own root — the drive prefix (`C:`) for a drive cwd, the share root
    // (`\\\\server\\share\\`) for a UNC cwd.
    if normalized.starts_with('/') {
        let anchor = lexical_fold(&current_dir.to_string_lossy(), true);
        if anchor.len() >= 2 && anchor.as_bytes()[1] == b':' {
            return Ok(PathBuf::from(lexical_fold(
                &format!("{}/{}", &anchor[..2], normalized.trim_start_matches('/')),
                true,
            )));
        }
        if let Some(tail) = anchor.strip_prefix("\\\\?\\UNC\\") {
            let mut parts = tail.splitn(3, '\\');
            let server = parts.next().unwrap_or("");
            let share = parts.next().unwrap_or("");
            if !server.is_empty() && !share.is_empty() {
                return Ok(PathBuf::from(lexical_fold(
                    &format!("\\\\{server}\\{share}\\{}", normalized.trim_start_matches('/')),
                    true,
                )));
            }
        }
        if let Some(tail) = anchor.strip_prefix("\\\\") {
            // A regular UNC working directory (\\\\server\\share\\…): its
            // share root is the anchor a root-relative path resolves
            // against.
            let mut parts = tail.splitn(2, '\\');
            let server = parts.next().unwrap_or("");
            let after = parts.next().unwrap_or("");
            let share = after.split('\\').next().unwrap_or("");
            if !server.is_empty() && !share.is_empty() {
                return Ok(PathBuf::from(lexical_fold(
                    &format!("\\\\{server}\\{share}\\{}", normalized.trim_start_matches('/')),
                    true,
                )));
            }
        }
        return Err(format!(
            "cannot resolve the root-relative path {raw:?}: the working directory {} has no drive or share anchor to resolve it against — use an absolute path",
            current_dir.display()
        ));
    }
    // Plain relative: anchor at the working directory.
    let anchor = lexical_fold(&current_dir.to_string_lossy(), true);
    Ok(PathBuf::from(lexical_fold(&format!("{anchor}/{raw}"), true)))
}

/// Lexically fold `.` and `..` out of a path string — Node `path.resolve`'s
/// component semantics, with no filesystem access and no symlink changes.
/// `windows` selects the flavor (separator handling and the drive/UNC
/// prefixes) so both platforms' rules are testable anywhere; a drive-only
/// prefix (`C:` with no following separator — a drive-RELATIVE path whose
/// anchor only the OS knows) is returned unfolded rather than guessed.
fn lexical_fold(raw: &str, windows: bool) -> String {
    let text = if windows { raw.replace('\\', "/") } else { raw.to_string() };
    // The prefix (what carries the "absolute" meaning and survives `..`).
    let (prefix, rest, anchored): (String, &str, bool) = if windows {
        if let Some(tail) = text.strip_prefix("//?/UNC/") {
            let mut parts = tail.splitn(2, '/');
            let server = parts.next().unwrap_or("");
            let after = parts.next().unwrap_or("");
            let share = after.split('/').next().unwrap_or("");
            let body = after.split_once('/').map(|(_, rest)| rest).unwrap_or("");
            (format!("\\\\?\\UNC\\{server}\\{share}\\"), body, true)
        } else if let Some(tail) = text.strip_prefix("//?/") {
            let mut parts = tail.splitn(2, '/');
            let drive = parts.next().unwrap_or("");
            let body = parts.next().unwrap_or("");
            (format!("\\\\?\\{drive}\\"), body, true)
        } else if text.starts_with("//") {
            let tail = &text[2..];
            let mut parts = tail.splitn(2, '/');
            let server = parts.next().unwrap_or("");
            let after = parts.next().unwrap_or("");
            let share = after.split('/').next().unwrap_or("");
            let body = after.split_once('/').map(|(_, rest)| rest).unwrap_or("");
            (format!("\\\\{server}\\{share}\\"), body, true)
        } else if text.len() >= 2 && text.as_bytes()[1] == b':' && text[2..].starts_with('/') {
            let drive = &text[..2];
            (format!("{drive}\\"), &text[3..], true)
        } else if text.len() >= 2
            && text.as_bytes()[1] == b':'
            && !text[2..].starts_with('/')
            && text.len() > 2
        {
            // A drive-RELATIVE path (`C:foo`): its anchor is per-drive OS
            // state the host cannot see — return it untouched rather than
            // guess a parent.
            return raw.to_string();
        } else {
            (String::new(), text.as_str(), false)
        }
    } else {
        match text.strip_prefix('/') {
            Some(tail) => ("/".to_string(), tail, true),
            None => (String::new(), text.as_str(), false),
        }
    };
    // Fold the components: `..` pops (never past the prefix), `.` and empty
    // components drop, everything else pushes.
    let mut components: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            other => components.push(other),
        }
    }
    let separator = if windows { '\\' } else { '/' };
    let body = components.join(&separator.to_string());
    if !anchored {
        return body;
    }
    if body.is_empty() {
        // The prefix alone (`/`, `\\\\srv\\share\\`, or a bare `C:`)
        // — resolve's form for a root.
        return prefix;
    }
    if !prefix.ends_with('/') && !prefix.ends_with('\\') {
        // A `C:` drive anchor: re-attach the separator the prefix omitted.
        return format!("{prefix}{separator}{body}");
    }
    format!("{prefix}{body}")
}

/// POST /api/cwd/validate (the `workspace.validateCwd` op): validate (and
/// select) a cwd. A chat root maps onto the hidden chat cwd; a real
/// directory is probed for readability (a permission-denied folder is
/// rejected at selection time, not later) and answers its project identity.
fn validate_cwd(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let agent_dir = state.agent_dir();
    let Some(raw) = args.get("cwd").and_then(Value::as_str) else {
        return Err(("invalid_args".to_string(), "Path is required".to_string()));
    };
    let cwd_text = raw.trim();
    if cwd_text.is_empty() {
        return Err(("invalid_args".to_string(), "Path is required".to_string()));
    }
    let cwd = normalize_cwd(cwd_text).map_err(|message| ("invalid_args".to_string(), message))?;

    if crate::session_view::is_chat_workspace_path(&cwd, &agent_dir) {
        // A chat's own folder (or the legacy shared cwd) stays what it is;
        // only the root maps onto the hidden chat cwd.
        let chat_cwd = if crate::session_view::is_chat_root_path(&cwd, &agent_dir) {
            crate::session_view::ensure_chat_workspace(&agent_dir)
                .map_err(|error| ("io".to_string(), error.to_string()))?
        } else {
            crate::session_view::ensure_chat_cwd(&cwd)
                .map_err(|error| ("io".to_string(), error.to_string()))?;
            cwd.clone()
        };
        state.propose_path(&chat_cwd);
        return Ok(json!({
            "success": true,
            "cwd": chat_cwd.display().to_string(),
            "projectRoot": Value::Null,
            "projectKey": Value::Null,
            "workspaceKind": "chat",
        }));
    }

    // A real directory (stat first: missing and not-a-directory answer
    // differently; a permission error at selection time, not later).
    let meta = std::fs::metadata(&cwd).map_err(|error| {
        (
            "invalid_args".to_string(),
            format!("Directory does not exist: {cwd_text}")
                .replace("does not exist", if error.kind() == std::io::ErrorKind::PermissionDenied { "is not readable" } else { "does not exist" }),
        )
    })?;
    if !meta.is_dir() {
        return Err(("invalid_args".to_string(), format!("Path is not a directory: {cwd_text}")));
    }
    // The read probe (the route's readdirSync: mode bits are not enough).
    if std::fs::read_dir(&cwd).is_err() {
        return Err((
            "invalid_args".to_string(),
            format!("Directory cannot be read: {cwd_text}"),
        ));
    }
    state.propose_path(&cwd);
    let project = state.projects.resolve(&cwd);
    Ok(json!({
        "success": true,
        "cwd": cwd.display().to_string(),
        "projectRoot": project.project_root.display().to_string(),
        "projectKey": crate::session_view::project_identity_key(&project.project_root),
    }))
}

/// The catalogue's SessionInfo (`mapScannedSession` +
/// `attachSessionProjectInfo`): the scan fields with the activity-based
/// modified time, the resolved parent id, the relation and the workspace
/// classification. `session_info_json` (the detail view) differs only in
/// its modified source (the file mtime there).
pub(crate) fn catalogue_info(
    state: &IpcHostState,
    agent_dir: &Path,
    scan: &session_host::history::ScannedSession,
    parent_session_id: Option<String>,
    relation: Option<Value>,
) -> Value {
    let cwd = PathBuf::from(&scan.cwd);
    let mut info = json!({
        "path": scan.path.display().to_string(),
        "id": scan.id,
        "cwd": scan.cwd,
        "created": ms_to_iso(scan.created_ms),
        "modified": ms_to_iso(scan.modified_ms),
        "messageCount": scan.message_count,
        "firstMessage": scan.first_message,
        "transient": false,
    });
    if let Some(name) = &scan.name {
        info["name"] = json!(name);
    }
    if scan.compaction_count > 0 {
        info["compactionCount"] = json!(scan.compaction_count);
    }
    if let Some(parent) = parent_session_id {
        info["parentSessionId"] = json!(parent);
    }
    if let Some(relation) = relation {
        // The fork relation's originSessionId rides only when it resolved.
        if relation.get("kind").and_then(Value::as_str) == Some("fork")
            && relation.get("originSessionId") == Some(&Value::Null)
        {
            let mut trimmed = relation;
            trimmed.as_object_mut().expect("relation object").remove("originSessionId");
            info["relation"] = trimmed;
        } else {
            info["relation"] = relation;
        }
    }
    attach_workspace_identity(state, agent_dir, &mut info, &cwd);
    info
}

/// The workspace half of the SessionInfo (`attachSessionProjectInfo`):
/// chats stay out of projects; a project row carries its git identity.
fn attach_workspace_identity(state: &IpcHostState, agent_dir: &Path, info: &mut Value, cwd: &Path) {
    if crate::session_view::is_chat_workspace_path(cwd, agent_dir) {
        info["workspaceKind"] = json!("chat");
        if crate::session_view::is_chat_folder_path(cwd, agent_dir) {
            info["chatFolder"] = json!(true);
        }
        return;
    }
    info["workspaceKind"] = json!("project");
    let project = state.projects.resolve(cwd);
    info["projectRoot"] = json!(project.project_root.display().to_string());
    info["projectKey"] = json!(crate::session_view::project_identity_key(&project.project_root));
    if let Some(branch) = project.branch {
        info["branch"] = json!(branch);
    }
    if project.is_worktree {
        info["isWorktree"] = json!(true);
    }
}

/// A live registry session not yet on disk (`getRpcSessionInfos` + the
/// merge rule): a transient row shown while the child has not flushed its
/// file. Hidden when it neither runs nor has a first message.
fn live_session_info(
    state: &IpcHostState,
    agent_dir: &Path,
    session: &std::sync::Arc<session_host::Session>,
    id: &str,
) -> Option<Value> {
    let snapshot = session
        .command("get_entries", json!({}), Some(std::time::Duration::from_secs(30)))
        .ok()?;
    let entries = snapshot.get("entries").and_then(Value::as_array)?;
    let mut message_count = 0u64;
    let mut first_message: Option<String> = None;
    let mut last_activity_ms: i64 = 0;
    for entry in entries {
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = entry.get("message") else { continue };
        message_count += 1;
        if message.get("role").and_then(Value::as_str) == Some("user") && first_message.is_none() {
            first_message = message
                .get("content")
                .and_then(|content| content.as_str().map(str::to_string).or_else(|| {
                    content.as_array().and_then(|blocks| {
                        blocks
                            .iter()
                            .find_map(|block| block.get("text").and_then(Value::as_str))
                            .map(str::to_string)
                    })
                }));
        }
        if let Some(timestamp) = entry.get("timestamp").and_then(Value::as_str) {
            if let Some(parsed) = chrono_parse_iso(timestamp) {
                last_activity_ms = last_activity_ms.max(parsed);
            }
        }
    }
    let running = session.run_state().is_running();
    if !running && first_message.is_none() {
        return None;
    }
    let created = entries
        .first()
        .and_then(|entry| entry.get("timestamp"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default();
    let created_ms = chrono_parse_iso(&created).unwrap_or(0);
    let modified_ms = if last_activity_ms > 0 { last_activity_ms } else { created_ms };
    let mut info = json!({
        "path": session.session_file.display().to_string(),
        "id": id,
        "cwd": session.cwd.display().to_string(),
        "created": ms_to_iso(created_ms),
        "modified": ms_to_iso(modified_ms),
        "messageCount": message_count,
        "firstMessage": first_message.unwrap_or_else(|| "(no messages)".to_string()),
        "transient": true,
    });
    attach_workspace_identity(state, agent_dir, &mut info, &session.cwd);
    Some(info)
}

/// Parse an ISO-8601 timestamp to epoch ms (Date.parse's happy path).
fn chrono_parse_iso(timestamp: &str) -> Option<i64> {
    // The entries pi writes are `YYYY-MM-DDTHH:MM:SS.sssZ`; accept an offset too.
    let bytes = timestamp.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    let year: i64 = timestamp.get(0..4)?.parse().ok()?;
    let month: i64 = timestamp.get(5..7)?.parse().ok()?;
    let day: i64 = timestamp.get(8..10)?.parse().ok()?;
    let hour: i64 = timestamp.get(11..13)?.parse().ok()?;
    let minute: i64 = timestamp.get(14..16)?.parse().ok()?;
    let second: i64 = timestamp.get(17..19)?.parse().ok()?;
    let millis: i64 = if timestamp.len() > 20 && &timestamp[19..20] == "." {
        let fraction: String = timestamp[20..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let padded = format!("{fraction:0<3}");
        padded.get(0..3)?.parse().unwrap_or(0)
    } else {
        0
    };
    // Days from civil (Howard Hinnant) then straight to epoch ms.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let mut epoch_ms = ((days * 86_400) + hour * 3_600 + minute * 60 + second) * 1000 + millis;
    // An explicit UTC offset shifts the epoch the other way.
    if let Some(offset) = timestamp.rfind(['+', '-']) {
        if offset > 19 {
            let sign: i64 = if &timestamp[offset..offset + 1] == "+" { 1 } else { -1 };
            let oh: i64 = timestamp.get(offset + 1..offset + 3).and_then(|v| v.parse().ok()).unwrap_or(0);
            let om: i64 = timestamp.get(offset + 4..offset + 6).and_then(|v| v.parse().ok()).unwrap_or(0);
            epoch_ms -= sign * (oh * 3_600 + om * 60) * 1000;
        }
    }
    Some(epoch_ms)
}

/// The map key for parent-id resolution (the file's absolute path).
pub(crate) fn key_of(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Dispatch a session op with the resume plan wired in.
pub(crate) fn dispatch_with_resume(
    state: &IpcHostState,
    op: &str,
    args: &Value,
) -> Result<Value, (String, String)> {
    let base = state.spawn_base.lock().unwrap().clone();
    let agent_dir = state.agent_dir();
    let Some(base) = base else {
        // No pi executable: not_found stays honest (never a fake child).
        let error = session_host::dispatch_session_op(&state.registry, op, args, None)
            .map_err(|error| (error.code().to_string(), error.to_string()))?;
        return Ok(error);
    };
    let plan = |summary: &session_host::SessionSummary| {
        build_spawn_plan(
            state,
            &base,
            Path::new(&summary.cwd),
            &summary.file,
            &SpawnRequest::default(),
            false,
        )
    };
    let resume = session_host::ResumeContext { agent_dir: agent_dir.as_path(), plan: &plan };
    let result = session_host::dispatch_session_op(&state.registry, op, args, Some(&resume))
        .map_err(|error| (error.code().to_string(), error.to_string()))?;
    // A rename changes the list every catalogue holder displays: bump the
    // version so other windows' staleness check refetches (the SSE stream
    // carried the same bump through getSessionListVersion).
    if op == "agent.setSessionName" {
        bump_session_list_version(state);
    }
    Ok(result)
}


/// Epoch ms → ISO-8601 Zulu (the catalogue's created/modified strings).
pub(crate) fn ms_to_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400) as u32;
    let (y, m, d) = civil_from_days_local(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, rest / 3600, (rest % 3600) / 60, rest % 60, millis
    )
}

/// civil_from_days for the catalogue timestamps (Hinnant's algorithm).
fn civil_from_days_local(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> IpcHostState {
        let state = IpcHostState::new();
        #[cfg(unix)]
        if let Some(shell) = std::env::var_os("SHELL") {
            *state.terminal_test_shell.lock().unwrap() = Some((PathBuf::from(shell), vec!["-i".into()]));
        }
        #[cfg(windows)]
        if let Some(shell) = std::env::var_os("COMSPEC") {
            *state.terminal_test_shell.lock().unwrap() = Some((PathBuf::from(shell), Vec::new()));
        }
        state
    }

    /// A spawn base for tests: the real executable the caller resolved plus
    /// the checkout's assets (artifacts + chat alongside the bridge).
    fn spawn_base(executable: &str, bridge: std::path::PathBuf) -> SpawnBase {
        SpawnBase {
            executable: executable.to_string(),
            bridge_asset: bridge,
            artifacts_asset: std::path::Path::new("../lib/pi-rpc/assets/pi-web-artifacts.mjs")
                .canonicalize()
                .ok(),
            chat_asset: std::path::Path::new("../lib/pi-rpc/assets/pi-web-chat.mjs")
                .canonicalize()
                .ok(),
        }
    }

    fn send(state: &IpcHostState, request: Value) -> Value {
        dispatch_envelope(state, request)
    }

    #[test]
    fn git_and_worktrees_refuse_ungranted_and_chat_paths() {
        let state = state();
        let temp = tempfile::tempdir().unwrap();
        *state.task_agent_dir.lock().unwrap() = Some(temp.path().join("agent"));
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let chat = temp.path().join("agent/chats/chat/subdir");
        std::fs::create_dir_all(&chat).unwrap();
        for op in ["git.status", "worktrees.list", "worktrees.fetch"] {
            let result = send(&state, json!({"v":1,"id":"denied","op":op,"args":{"cwd":outside}}));
            assert_eq!(result["error"]["code"], "unauthorized_scope", "{result}");
        }
        state.propose_path(&chat);
        for op in ["git.status", "worktrees.list", "worktrees.fetch"] {
            let result = send(&state, json!({"v":1,"id":"chat","op":op,"args":{"cwd":chat}}));
            assert_eq!(result["error"]["code"], "unauthorized_scope", "{result}");
        }
    }

    #[test]
    fn cwd_validation_normalizes_like_the_http_route() {
        // The HTTP route's normalizeCwd (app/api/cwd/validate/route.ts):
        // `~` and `~/foo` expand against the user home, relative paths
        // resolve against the process cwd, absolute paths stay — all with
        // path.resolve's LEXICAL fold. The static host must answer the same
        // directory the server did — a `~/project` the user types must not
        // become a missing relative path.
        let home = PathBuf::from("/home/fixture-user");
        assert_eq!(normalize_cwd_with_home("~", home.clone()).unwrap(), home);
        assert_eq!(
            normalize_cwd_with_home("~/work", home.clone()).unwrap(),
            PathBuf::from("/home/fixture-user/work")
        );
        let absolute = normalize_cwd_with_home("/opt/projects", home.clone()).unwrap();
        assert_eq!(absolute, PathBuf::from("/opt/projects"));
        let cwd = std::env::current_dir().expect("the test process has a cwd");
        let relative = normalize_cwd_with_home("some/relative", home).unwrap();
        assert_eq!(relative, cwd.join("some/relative"));
    }

    #[test]
    fn cwd_identity_handles_the_windows_prefixes_the_join_never_saw() {
        // Terra round-4: `normalize_cwd_with_home` used to STRING-JOIN every
        // non-absolute input onto the working directory first, so the
        // Windows anchored forms were mis-resolved BEFORE `lexical_fold`
        // ever saw them: `\work` became `C:\current\work` (root-relative
        // means the DRIVE root) and `D:work` on a C: cwd silently became
        // `C:\current\work` (a different drive's directory entirely). The
        // resolver classifies by prefix and anchors each form where
        // `path.resolve` anchored it — or refuses honestly.
        let home = PathBuf::from(r"C:\Users\fixture");
        let current = PathBuf::from(r"C:\Users\fixture\app");

        // Root-relative: the current directory's DRIVE root, not its folder.
        assert_eq!(
            resolve_cwd_identity(r"\work", false, &home, &current, true).unwrap(),
            PathBuf::from(r"C:\work")
        );
        assert_eq!(
            resolve_cwd_identity("/work/sub/../x", false, &home, &current, true).unwrap(),
            PathBuf::from(r"C:\work\x")
        );
        // Drive-relative on the SAME drive as the working directory:
        // anchored there, lexically folded.
        assert_eq!(
            resolve_cwd_identity(r"C:work", false, &home, &current, true).unwrap(),
            PathBuf::from(r"C:\Users\fixture\app\work")
        );
        assert_eq!(
            resolve_cwd_identity(r"c:..\shared", false, &home, &current, true).unwrap(),
            PathBuf::from(r"C:\Users\fixture\shared"),
            "the drive letter matches case-insensitively and `..` still folds"
        );
        // Drive-relative on ANOTHER drive: per-drive OS state the host
        // cannot see — refused, never guessed (the old join answered
        // C:\Users\fixture\app\work for this input).
        let refused = resolve_cwd_identity(r"D:work", false, &home, &current, true).unwrap_err();
        assert!(refused.contains("drive-relative"), "the honest refusal: {refused}");
        assert!(refused.contains('D'), "names the drive: {refused}");
        // Plain relative still anchors at the working directory.
        assert_eq!(
            resolve_cwd_identity(r"sub\..\x", false, &home, &current, true).unwrap(),
            PathBuf::from(r"C:\Users\fixture\app\x")
        );
        // The absolute forms are untouched (folding only).
        assert_eq!(
            resolve_cwd_identity(r"D:\work", false, &home, &current, true).unwrap(),
            PathBuf::from(r"D:\work")
        );
        assert_eq!(
            resolve_cwd_identity(r"\\srv\share\a\..\b", false, &home, &current, true).unwrap(),
            PathBuf::from(r"\\srv\share\b")
        );
        // A UNC working directory anchors root-relative paths at its share
        // root.
        let unc_cwd = PathBuf::from(r"\\srv\share\deep\cwd");
        assert_eq!(
            resolve_cwd_identity(r"\work", false, &home, &unc_cwd, true).unwrap(),
            PathBuf::from(r"\\srv\share\work")
        );
        // A working directory with NO drive/share anchor cannot anchor a
        // root-relative path — refused honestly rather than joined.
        let anchorless = PathBuf::from(r"\\\\?\\UNC\\onlyserver");
        assert!(resolve_cwd_identity(r"\work", false, &home, &anchorless, true).is_err());

        // `~` expands only where the old contract did (validate's
        // normalizeCwd) — the create entry passes expand_home=false and a
        // `~` reaches its directory probe as the literal it is.
        assert_eq!(
            resolve_cwd_identity("~", true, &home, &current, true).unwrap(),
            home
        );
        let unix_home = PathBuf::from("/home/fixture-user");
        let unix_current = PathBuf::from("/home/fixture-user/app");
        assert_eq!(
            resolve_cwd_identity("~/work", true, &unix_home, &unix_current, false).unwrap(),
            PathBuf::from("/home/fixture-user/work")
        );
        assert_eq!(
            resolve_cwd_identity("~", false, &unix_home, &unix_current, false).unwrap(),
            PathBuf::from("/home/fixture-user/app/~"),
            "the create entry keeps `~` a literal"
        );
    }

    #[test]
    fn a_windows_flavored_relative_chat_path_classifies_through_the_resolver() {
        // The reviewer's chain requirement for round-4: the Windows prefix
        // handling must hold through the RESOLUTION→CLASSIFICATION call
        // chain, not only in `lexical_fold`'s pure string tests. The pure
        // core is exercised with windows=true (this host runs Unix; the
        // on-Windows op path shares this exact resolver, only the flavor
        // flag comes from cfg!(windows)).
        let home = PathBuf::from(r"C:\Users\fixture");
        let agent = PathBuf::from(r"C:\Users\fixture\.pi\agent");
        let current = PathBuf::from(r"C:\Users\fixture\app");

        // A drive-relative form of the chat ROOT (same drive as the cwd):
        // resolves to the absolute chat root, which classifies as one.
        let rel_root = resolve_cwd_identity(
            r"C:..\.pi\agent\chats",
            false,
            &home,
            &current,
            true,
        )
        .unwrap();
        let chat_root = agent.join("chats");
        assert!(crate::session_view::is_chat_root_path(&rel_root, &agent), "{} vs {}", rel_root.display(), chat_root.display());

        // A root-relative form of a chat FOLDER (\Users\fixture\.pi\agent\chats\<id>):
        // anchored at the drive root, folded, classified as a chat folder.
        let rel_folder = resolve_cwd_identity(
            r"\Users\fixture\.pi\agent\chats\20260101-120000-abcd",
            false,
            &home,
            &current,
            true,
        )
        .unwrap();
        let rel_folder_posix = PathBuf::from(rel_folder.to_string_lossy().replace('\\', "/"));
        assert!(crate::session_view::is_chat_folder_path(&rel_folder_posix, &agent), "{}", rel_folder.display());
        assert!(crate::session_view::is_chat_workspace_path(&rel_folder_posix, &agent));

        // The legacy shared cwd through the same drive-relative form stays
        // the legacy workspace.
        let rel_legacy = resolve_cwd_identity(
            r"C:..\.pi\agent\chat-workspace",
            false,
            &home,
            &current,
            true,
        )
        .unwrap();
        assert!(crate::session_view::is_legacy_chat_workspace_path(&rel_legacy, &agent));

        // An ordinary project through the same form is NOT a chat.
        let rel_project = resolve_cwd_identity(r"C:..\work\proj", false, &home, &current, true).unwrap();
        assert!(!crate::session_view::is_chat_workspace_path(&rel_project, &agent));
    }

    #[test]
    fn lexical_fold_collapses_dots_like_path_resolve() {
        // Unix flavor (the flavor this host runs under).
        assert_eq!(lexical_fold("/a/b/../c", false), "/a/c");
        assert_eq!(lexical_fold("/a/./b/", false), "/a/b", "trailing separators drop");
        assert_eq!(lexical_fold("/../x", false), "/x", "`..` at the root stops at the root");
        assert_eq!(lexical_fold("/a/b/../../..", false), "/");
        assert_eq!(lexical_fold("a/b/../c", false), "a/c", "a relative input folds without inventing an anchor");
        // Windows flavor: backslash separators, drive anchors, UNC and
        // verbatim forms.
        assert_eq!(lexical_fold(r"C:\a\b\..\c", true), r"C:\a\c");
        assert_eq!(lexical_fold(r"C:\..\x", true), r"C:\x");
        assert_eq!(lexical_fold(r"C:\", true), r"C:\");
        assert_eq!(lexical_fold("C:/a/../b", true), r"C:\b", "a forward-slash drive path folds to backslashes");
        assert_eq!(lexical_fold("\\\\server\\share\\a\\..\\b", true), "\\\\server\\share\\b");
        assert_eq!(lexical_fold("//server/share/a/../b", true), "\\\\server\\share\\b", "forward slashes fold too");
        assert_eq!(lexical_fold("\\\\?\\C:\\a\\..\\b", true), "\\\\?\\C:\\b");
        assert_eq!(lexical_fold("\\\\?\\UNC\\srv\\share\\a\\..\\b", true), "\\\\?\\UNC\\srv\\share\\b");
        // A drive-RELATIVE path (`C:` with no separator — its anchor is
        // per-drive OS state) is returned untouched rather than guessed.
        assert_eq!(lexical_fold("C:foo/../bar", true), "C:foo/../bar");
        // Unix flavor keeps backslashes as ordinary name characters — they
        // never split components, but `..` still folds lexically (Node's
        // posix resolve does exactly this).
        assert_eq!(lexical_fold("/a\\b/../c", false), "/c");
    }

    #[test]
    fn chat_paths_with_dots_classify_as_chats_after_the_fold() {
        // Terra P1-4: a cwd that lexically POINTS at the chat root or a
        // chat folder must classify as one — the unfolded form kept `..`
        // and slipped past the parent-path identity checks as a project.
        let home = PathBuf::from("/home/fixture-user");
        let agent = home.join(".pi").join("agent");
        let folder = agent.join("chats").join("20260101-120000-abcd");

        // The `~/` form the HTTP route folded via resolve().
        let through_dots = normalize_cwd_with_home(
            "~/.pi/agent/chats/../chats/20260101-120000-abcd",
            home.clone(),
        )
        .expect("resolves");
        assert_eq!(through_dots, folder, "the folded path equals the plain folder path");
        assert!(crate::session_view::is_chat_folder_path(&through_dots, &agent));

        // A relative form folding onto the chat root.
        let root_through_dots =
            normalize_cwd_with_home("~/.pi/agent/x/../chats", home.clone()).expect("resolves");
        assert!(crate::session_view::is_chat_root_path(&root_through_dots, &agent));

        // The legacy shared cwd through dots stays the legacy workspace.
        let legacy =
            normalize_cwd_with_home("~/.pi/agent/chats/../chat-workspace", home.clone())
                .expect("resolves");
        assert!(crate::session_view::is_legacy_chat_workspace_path(&legacy, &agent));

        // An ordinary project through the SAME dots machinery is untouched
        // in identity (still a project, still its own folder).
        let project = normalize_cwd_with_home("~/work/../work/proj", home).expect("resolves");
        assert_eq!(project, PathBuf::from("/home/fixture-user/work/proj"));
        assert!(!crate::session_view::is_chat_workspace_path(&project, &agent));
    }

    #[test]
    fn validate_cwd_folds_an_absolute_chat_path_with_dots_into_the_chat_workspace() {
        // The op path (validate_cwd shares normalize_cwd): a real chat
        // folder addressed through `..` must answer workspaceKind "chat",
        // not create a project identity for it.
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let folder = crate::session_view::chat_workspace_dir(&agent_dir).join("20260101-120000-abcd");
        std::fs::create_dir_all(&folder).expect("folder");
        std::fs::create_dir_all(dir.path().join("elsewhere")).expect("elsewhere");
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());

        let dotted = format!(
            "{}/../chats/20260101-120000-abcd",
            dir.path().join("agent").join("chats").display()
        );
        let answer = send(
            &state,
            json!({ "v": 1, "id": "cwd-fold", "op": "cwd.validate", "args": { "cwd": dotted } }),
        );
        assert_eq!(answer["ok"], true, "{answer}");
        assert_eq!(answer["data"]["workspaceKind"], "chat", "{answer}");
        assert_eq!(answer["data"]["cwd"], folder.display().to_string(), "the FOLDED path answers");
        assert_eq!(answer["data"]["projectRoot"], Value::Null, "{answer}");
    }

    #[test]
    fn cwd_validate_op_answers_the_normalized_directory() {
        // End to end through the dispatch table: an absolute temp directory
        // validates and answers itself (the `~` expansion is covered by the
        // unit test above — the op path shares normalize_cwd).
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("project");
        std::fs::create_dir_all(&target).expect("target");
        let response = send(
            &state,
            json!({ "v": 1, "id": "cv1", "op": "cwd.validate", "args": { "cwd": target.to_string_lossy() } }),
        );
        assert_eq!(response["ok"], true, "{response}");
        let data = &response["data"];
        assert_eq!(data["success"], true);
        assert_eq!(
            data["cwd"].as_str().map(str::to_string),
            Some(target.to_string_lossy().into_owned()),
            "the answered cwd is the validated directory itself"
        );

        // A `~/…` path under a home that does not exist must fail as a
        // MISSING directory (not a protocol error): the message shape the
        // ProjectPicker surfaces is the route's.
        let response = send(
            &state,
            json!({ "v": 1, "id": "cv2", "op": "cwd.validate", "args": { "cwd": "~/definitely-not-here-918273" } }),
        );
        assert_eq!(response["ok"], false, "{response}");
        assert_eq!(response["error"]["code"], "invalid_args");
        assert!(
            response["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("does not exist")),
            "the honest missing-directory message: {}",
            response["error"]["message"]
        );
    }

    #[test]
    fn identity_answers_before_any_child_exists() {
        let state = state();
        let response = send(
            &state,
            json!({ "v": 1, "id": "r1", "op": "desktop.identity" }),
        );
        assert_eq!(response["ok"], true);
        assert_eq!(response["id"], "r1");
        assert_eq!(response["v"], 1);
        assert_eq!(response["data"]["host"], "tauri");
        assert_eq!(response["data"]["protocol"], 1);
        assert_eq!(response["data"]["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn version_mismatches_and_malformed_envelopes_are_refused() {
        let state = state();
        let response = send(&state, json!({ "v": 2, "id": "r2", "op": "desktop.identity" }));
        assert_eq!(response["error"]["code"], "version_mismatch");
        let response = send(&state, json!({ "v": 1, "id": "r3" }));
        assert_eq!(response["error"]["code"], "invalid_args");
        let response = send(&state, json!({ "v": 1, "id": "r4", "op": "desktop.identity", "args": [] }));
        assert_eq!(response["error"]["code"], "invalid_args");
        let response = send(&state, json!("not an object"));
        assert_eq!(response["error"]["code"], "invalid_args");
    }

    #[test]
    fn unknown_operations_never_execute() {
        let state = state();
        let response = send(
            &state,
            json!({ "v": 1, "id": "r5", "op": "os.shell", "args": { "command": "rm -rf /" } }),
        );
        assert_eq!(response["ok"], false);
        assert_eq!(response["error"]["code"], "unknown_op");
    }

    #[test]
    fn sessions_catalogue_lists_flat_newest_first_with_the_scan_fields() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let sessions = dir.path().join("sessions").join("encoded");
        std::fs::create_dir_all(&sessions).expect("sessions");

        let older = sessions.join("older.jsonl");
        std::fs::write(
            &older,
            concat!(
                r#"{"type":"session","version":3,"id":"s-old","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/proj"}"#,
                "\n",
                r#"{"type":"message","id":"e1","parentId":null,"message":{"role":"user","content":"older question"}}"#,
                "\n",
            ),
        )
        .expect("older");
        // Give the newer file a later mtime (the catalogue sorts on it).
        // A rename lives in a session_info entry (pi's real shape); the
        // header never carries the display name.
        let newer = sessions.join("newer.jsonl");
        std::fs::write(
            &newer,
            concat!(
                r#"{"type":"session","version":3,"id":"s-new","timestamp":"2026-02-01T00:00:00.000Z","cwd":"/proj"}"#,
                "\n",
                r#"{"type":"session_info","id":"i1","parentId":null,"name":"Renamed"}"#,
                "\n",
            ),
        )
        .expect("newer");
        // Same instant: bump mtime deterministically via a copied temp file.
        let bumped = dir.path().join("bumped.jsonl");
        std::fs::copy(&newer, &bumped).expect("copy");
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&bumped).and_then(|handle| handle.set_modified(later)).expect("mtime");
        std::fs::copy(&bumped, &newer).expect("copy back");
        std::fs::remove_file(&bumped).expect("cleanup");

        let catalogue = send(
            &state,
            json!({ "v": 1, "id": "cat1", "op": "sessions.list" }),
        );
        assert_eq!(catalogue["ok"], true, "{catalogue}");
        let sessions = catalogue["data"]["sessions"].as_array().expect("array");
        assert_eq!(sessions.len(), 2, "{sessions:?}");
        // Newest (by mtime) first.
        assert_eq!(sessions[0]["id"], "s-new", "sorted newest first: {sessions:?}");
        assert_eq!(sessions[0]["name"], "Renamed", "the session_info rename, not a header name");
        assert_eq!(sessions[0]["messageCount"], 0);
        assert_eq!(sessions[1]["firstMessage"], "older question");
        assert_eq!(sessions[1]["messageCount"], 1);
        assert_eq!(sessions[1]["id"], "s-old");
        // The catalogue carries created/modified as ISO strings and paths.
        assert!(sessions[0]["created"].as_str().unwrap_or_default().starts_with("2026-02-01T"));
        assert!(sessions[0]["modified"].as_str().unwrap_or_default().ends_with('Z'));
        assert!(sessions[0]["path"].as_str().unwrap_or_default().ends_with("newer.jsonl"));
        // The scan-derived roots still get proposed (browsability in step).
        assert!(state.is_proposed("/proj"));
    }

    #[test]
    fn sessions_catalogue_serves_the_sidebar_payload() {
        // The FULL GET /api/sessions contract: SessionInfo rows (workspace
        // classification, fork relation with the parent's real id, the
        // transient: false disk rows) plus the envelope fields the sidebar's
        // running/unread/chat-root wiring consumes.
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        let sessions = agent_dir.join("sessions").join("--home-hao-work--");
        std::fs::create_dir_all(&sessions).expect("sessions");

        // A parent and its fork (the fork records the parent's PATH; the
        // catalogue resolves the parent's ID from ITS header).
        let parent = sessions.join("parent.jsonl");
        std::fs::write(
            &parent,
            concat!(
                r#"{"type":"session","version":3,"id":"p1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/hao/work"}"#,
                "\n",
                r#"{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"parent question"}}"#,
                "\n",
            ),
        )
        .expect("parent");
        let fork = sessions.join("fork.jsonl");
        std::fs::write(
            &fork,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"f1\",\"timestamp\":\"2026-02-01T00:00:00.000Z\",\"cwd\":\"/home/hao/work\",\"parentSession\":\"{}\"}}\n",
                parent.display().to_string().replace('\\', "\\\\"),
            ),
        )
        .expect("fork");

        let catalogue = send(&state, json!({ "v": 1, "id": "cat2", "op": "sessions.list" }));
        assert_eq!(catalogue["ok"], true, "{catalogue}");
        let payload = &catalogue["data"];
        // The envelope fields (the sidebar's whole payload contract).
        assert!(payload["sessionListVersion"].is_u64(), "the version counter: {}", payload["sessionListVersion"]);
        assert_eq!(payload["runningSessionIds"], json!([]));
        assert_eq!(payload["completionNotificationSuppressedSessionIds"], json!([]));
        let chat_root = payload["chatWorkspaceCwd"].as_str().expect("chat root");
        assert!(chat_root.ends_with("/chats"), "the hidden chat root: {chat_root}");
        assert!(state.is_proposed(chat_root));

        let rows = payload["sessions"].as_array().expect("rows");
        let fork_row = rows.iter().find(|row| row["id"] == "f1").expect("the fork row");
        // The fork relation resolves the parent's REAL id from its header.
        assert_eq!(fork_row["parentSessionId"], "p1");
        assert_eq!(fork_row["relation"]["kind"], "fork");
        assert_eq!(fork_row["relation"]["originSessionId"], "p1");
        assert_eq!(fork_row["transient"], false);
        // The project identity (non-git cwd: the cwd itself).
        assert_eq!(fork_row["workspaceKind"], "project");
        assert!(fork_row["projectKey"].is_string(), "the grouping key");

        // A chat session classifies as the chat workspace (no project row).
        let chat_sessions = agent_dir.join("sessions").join("--agent-chats-20260201-100000-abcd--");
        std::fs::create_dir_all(&chat_sessions).expect("chat sessions");
        let chat_dir = agent_dir.join("chats").join("20260201-100000-abcd");
        std::fs::create_dir_all(&chat_dir).expect("chat folder");
        std::fs::write(
            chat_sessions.join("chat.jsonl"),
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"c1\",\"timestamp\":\"2026-03-01T00:00:00.000Z\",\"cwd\":\"{}\"}}\n",
                chat_dir.display().to_string().replace('\\', "\\\\"),
            ),
        )
        .expect("chat");
        let catalogue = send(&state, json!({ "v": 1, "id": "cat3", "op": "sessions.list" }));
        let rows = catalogue["data"]["sessions"].as_array().expect("rows");
        let chat_row = rows.iter().find(|row| row["id"] == "c1").expect("the chat row");
        assert_eq!(chat_row["workspaceKind"], "chat");
        assert_eq!(chat_row["chatFolder"], true);
        assert!(chat_row.get("projectKey").is_none(), "a chat carries no project identity");
    }

    #[test]
    fn sessions_catalogue_lists_a_subagent_relation_from_the_bounded_reads() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let sessions = dir.path().join("sessions").join("--home-hao-work--");
        std::fs::create_dir_all(&sessions).expect("sessions");
        let subagent = sessions.join("sub.jsonl");
        std::fs::write(
            &subagent,
            concat!(
                r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/hao/work","parentSession":"/gone.jsonl"}"#,
                "\n",
                r#"{"type":"custom","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","customType":"pi-web:subagent","data":{"version":1,"parentSessionId":"p1","parentSessionPath":"/gone.jsonl","profile":"researcher","description":"Digging"}}"#,
                "\n",
                r#"{"type":"custom","id":"m2","parentId":"m1","timestamp":"2026-01-01T00:00:02.000Z","customType":"pi-web:subagent-result","data":{"version":1,"status":"completed","result":"done"}}"#,
                "\n",
            ),
        )
        .expect("subagent");

        let catalogue = send(&state, json!({ "v": 1, "id": "cat4", "op": "sessions.list" }));
        let rows = catalogue["data"]["sessions"].as_array().expect("rows");
        let row = rows.iter().find(|row| row["id"] == "s1").expect("the subagent row");
        // The subagent relation (the parent id from the marker, not the
        // missing parent file; the completed status from the tail entry).
        assert_eq!(row["relation"]["kind"], "subagent");
        assert_eq!(row["relation"]["parentSessionId"], "p1");
        assert_eq!(row["relation"]["profile"], "researcher");
        assert_eq!(row["relation"]["description"], "Digging");
        assert_eq!(row["relation"]["status"], "completed");
        // A subagent whose parent file is gone still carries the parent link
        // from the marker (never a fork relation).
        assert!(row.get("parentSessionId").is_none());
    }

    #[test]
    fn tasks_list_reads_the_store_and_reports_corruption() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());

        // Empty store: an empty list, not an error.
        let response = send(&state, json!({ "v": 1, "id": "k1", "op": "tasks.list" }));
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["data"]["tasks"].as_array().unwrap().len(), 0);

        // One task roundtrips its raw shape.
        std::fs::write(
            dir.path().join("scheduled-tasks.json"),
            serde_json::json!({ "tasks": [{
                "id": "t1", "name": "T", "prompt": "go", "cwd": "/w",
                "schedule": { "kind": "cron", "expr": "*/10 * * * *", "timezone": "UTC" },
                "enabled": true,
            }]})
            .to_string(),
        )
        .expect("write");
        let response = send(&state, json!({ "v": 1, "id": "k2", "op": "tasks.list" }));
        assert_eq!(response["data"]["tasks"][0]["id"], "t1");

        // A corrupt store is an io error, never an empty success.
        std::fs::write(dir.path().join("scheduled-tasks.json"), "{ broken").expect("write");
        let response = send(&state, json!({ "v": 1, "id": "k3", "op": "tasks.list" }));
        assert_eq!(response["error"]["code"], "io");
    }

    #[test]
    fn preview_resources_grant_read_revoke_roundtrip() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let png = dir.path().join("shot.png");
        std::fs::write(&png, vec![1u8; 300]).expect("write");

        // Grant by host-side path decision; the handle is opaque.
        state.propose_path(&png);
        let grant = send(
            &state,
            json!({ "v": 1, "id": "g1", "op": "resources.grantFile", "args": { "path": png.display().to_string() } }),
        );
        assert_eq!(grant["ok"], true, "{grant}");
        let handle = grant["data"]["handle"].as_str().expect("handle").to_string();
        assert_eq!(handle.len(), 32);

        // Read whole and ranged; MIME by extension.
        let read = send(
            &state,
            json!({ "v": 1, "id": "g2", "op": "resources.read", "args": { "handle": handle } }),
        );
        assert_eq!(read["data"]["mime"], "image/png");
        assert_eq!(read["data"]["totalLen"], 300);
        let ranged = send(
            &state,
            json!({ "v": 1, "id": "g3", "op": "resources.read", "args": { "handle": handle, "start": 10, "end": 19 } }),
        );
        assert_eq!(ranged["data"]["rangeApplied"], true);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(ranged["data"]["data"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded.len(), 10);

        // A file grant refuses subpaths; ghosts and revoked handles fail.
        let subpath = send(
            &state,
            json!({ "v": 1, "id": "g4", "op": "resources.read", "args": { "handle": handle, "subpath": "x" } }),
        );
        assert_eq!(subpath["error"]["code"], "invalid_args");
        let missing = send(
            &state,
            json!({ "v": 1, "id": "g5", "op": "resources.grantFile", "args": { "path": dir.path().join("nope.png").display().to_string() } }),
        );
        assert_eq!(missing["error"]["code"], "unauthorized_scope", "never proposed: {missing}");
        let revoke = send(
            &state,
            json!({ "v": 1, "id": "g6", "op": "resources.revoke", "args": { "handle": handle } }),
        );
        assert_eq!(revoke["data"]["revoked"], true);
        let after = send(
            &state,
            json!({ "v": 1, "id": "g7", "op": "resources.read", "args": { "handle": handle } }),
        );
        assert_eq!(after["error"]["code"], "not_found");
    }

    #[test]
    fn files_roundtrip_through_the_allow_list() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).expect("proj");
        std::fs::write(project.join("a.txt"), b"hello").expect("a");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        std::fs::write(outside.join("secret"), b"no").expect("secret");

        // Without a host-side grant everything is out of scope.
        let refused = send(
            &state,
            json!({ "v": 1, "id": "f1", "op": "files.read", "args": { "path": project.join("a.txt").display().to_string() } }),
        );
        assert_eq!(refused["error"]["code"], "unauthorized_scope");

        // There is NO frontend-facing allowRoot: the WebView cannot widen
        // its own file access.
        let widen = send(
            &state,
            json!({ "v": 1, "id": "f1b", "op": "files.allowRoot", "args": { "path": project.display().to_string() } }),
        );
        assert_eq!(widen["error"]["code"], "unknown_op", "no allowRoot op exists");

        // The HOST grants the project root (the sessions.list path); reads
        // inside pass, outside stays refused even with traversal tricks.
        state.propose_path(&project);
        let read = send(
            &state,
            json!({ "v": 1, "id": "f3", "op": "files.read", "args": { "path": project.join("a.txt").display().to_string() } }),
        );
        assert_eq!(read["data"]["mime"], "text/plain; charset=utf-8");
        let escaped = send(
            &state,
            json!({ "v": 1, "id": "f4", "op": "files.read", "args": { "path": project.join("../outside/secret").display().to_string() } }),
        );
        assert_eq!(escaped["error"]["code"], "unauthorized_scope");

        // Writes: a new file inside passes (authorized through the resolved
        // parent); outside is refused before any IO.
        let write = send(
            &state,
            json!({
                "v": 1, "id": "f5", "op": "files.write",
                "args": {
                    "path": project.join("b.txt").display().to_string(),
                    "data": base64::engine::general_purpose::STANDARD.encode("written by host"),
                },
            }),
        );
        assert_eq!(write["ok"], true, "{write}");
        assert_eq!(std::fs::read_to_string(project.join("b.txt")).unwrap(), "written by host");
        let evil = send(
            &state,
            json!({
                "v": 1, "id": "f6", "op": "files.write",
                "args": {
                    "path": outside.join("evil.txt").display().to_string(),
                    "data": base64::engine::general_purpose::STANDARD.encode("x"),
                },
            }),
        );
        assert_eq!(evil["error"]["code"], "unauthorized_scope");
        assert!(!outside.join("evil.txt").exists());
    }

    #[test]
    #[cfg(unix)]
    fn writes_refuse_a_dangling_symlink_final_component() {
        // THE attack the old exists()-based check missed: a symlink INSIDE
        // an allowed root pointing at a NOT-YET-EXISTING file OUTSIDE it.
        // target.exists() FOLLOWS the link → false → the old code took the
        // new-file branch (parent-only authorization) and fs::write then
        // FOLLOWED the link, creating the file outside the roots.
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).expect("proj");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        let victim = outside.join("created-by-attack.txt");
        assert!(!victim.exists());
        // project/leak → outside/created-by-attack.txt (dangling: the victim
        // does not exist yet).
        std::os::unix::fs::symlink(&victim, project.join("leak")).expect("leak");
        state.propose_path(&project);

        let evil = send(
            &state,
            json!({
                "v": 1, "id": "d1", "op": "files.write",
                "args": {
                    "path": project.join("leak").display().to_string(),
                    "data": base64::engine::general_purpose::STANDARD.encode("escaped"),
                },
            }),
        );
        assert_eq!(evil["error"]["code"], "unauthorized_scope", "{evil}");
        assert!(evil["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("symbolic link"), "the refusal names the cause: {evil}");
        assert!(!victim.exists(), "NOTHING was created outside the roots");
        // The symlink itself is untouched (no write-through).
        assert!(std::fs::symlink_metadata(project.join("leak")).is_ok());
    }

    #[test]
    #[cfg(unix)]
    fn writes_refuse_a_symlink_final_component_switched_in_flight() {
        // The check→open race: authorize a PLAIN new file, swap the final
        // component for a symlink before the open. The O_NOFOLLOW openat
        // against the FIXED parent descriptor refuses atomically — there is
        // no window in which the swapped link is followed.
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).expect("proj");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        state.propose_path(&project);

        let roots = state.file_roots.lock().unwrap();
        let target = project.join("swapme.txt");
        // The parent authorizes (plain directory inside the root)...
        let parent = roots
            .resolved_write_parent(&target)
            .expect("the plain parent authorizes");
        // ...then the attacker swaps the final component for a symlink out.
        std::os::unix::fs::symlink(outside.join("hijacked.txt"), &target).expect("swap");
        // The write primitive re-resolves through openat + O_NOFOLLOW on the
        // FIXED parent: the swapped link refuses, nothing lands outside.
        let refusal = crate::file_access::write_through_allowed_parent(&roots, &target, b"x")
            .expect_err("the swapped symlink refuses");
        assert!(matches!(refusal, crate::file_access::WriteRefusal::FinalComponentSymlink));
        assert_eq!(parent, project.canonicalize().unwrap());
        assert!(!outside.join("hijacked.txt").exists(), "nothing escaped");
    }

    #[test]
    #[cfg(unix)]
    fn writes_refuse_a_parent_swapped_to_a_symlink_after_authorization() {
        // The parent-side race: the parent authorized as a real directory,
        // then a path component above is replaced by a symlink pointing out.
        // The directory descriptor opens O_NOFOLLOW|O_DIRECTORY on the
        // CANONICALIZED spelling — a component that no longer resolves as
        // that directory fails the open instead of following the swap.
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        let sub = project.join("sub");
        std::fs::create_dir_all(&sub).expect("sub");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        state.propose_path(&project);

        let roots = state.file_roots.lock().unwrap();
        let target = sub.join("file.txt");
        assert!(roots.resolved_write_parent(&target).is_some(), "authorizes before the swap");
        // Swap the intermediate directory for a symlink to outside.
        std::fs::remove_dir(&sub).expect("remove sub");
        std::os::unix::fs::symlink(&outside, &sub).expect("swap sub");
        // Now the parent resolves to OUTSIDE: authorization refuses before
        // any open (the canonicalized parent left the roots).
        assert!(
            roots.resolved_write_parent(&target).is_none(),
            "the swapped parent no longer authorizes"
        );
        let refusal = crate::file_access::write_through_allowed_parent(&roots, &target, b"x")
            .expect_err("refuses after the swap");
        assert!(matches!(refusal, crate::file_access::WriteRefusal::OutsideRoots));
        assert!(!outside.join("file.txt").exists(), "nothing escaped");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn listing_refuses_a_directory_swapped_to_a_symlink_after_authorization() {
        // The listing twin: authorization passes on an honest subdirectory,
        // then the directory's name is replaced by a symlink pointing at a
        // directory OUTSIDE. The listing walks from the root's descriptor
        // (openat O_NOFOLLOW per component) and lists THROUGH the walked fd
        // (/proc/self/fd) — the swapped component refuses instead of
        // enumerating the outside directory.
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        let sub = project.join("sub");
        std::fs::create_dir_all(&sub).expect("sub");
        std::fs::write(sub.join("inside.txt"), b"x").expect("inside");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        std::fs::write(outside.join("secret.txt"), b"s").expect("secret");
        state.propose_path(&project);
        let roots = state.file_roots.lock().unwrap();
        let (resolved, root) = crate::file_access::resolved_read_target_with_root(&roots, &sub)
            .expect("the honest directory authorizes");
        // The ATTACK: swap `sub` for a symlink to the outside directory.
        std::fs::remove_dir_all(&sub).expect("remove");
        std::os::unix::fs::symlink(&outside, &sub).expect("swap");
        // The stale pair + the walk: the open refuses the swapped component.
        let outcome = crate::file_access::open_directory_beneath_root(&root, &resolved);
        assert!(outcome.is_err(), "the swapped directory refuses: {outcome:?}");
        // Fresh authorization through IPC also refuses (canonicalize now
        // resolves through the link to outside → containment fails).
        drop(roots);
        let listed = send(
            &state,
            json!({ "v": 1, "id": "lsr1", "op": "files.list", "args": { "path": sub.display().to_string() } }),
        );
        assert_eq!(listed["error"]["code"], "unauthorized_scope", "{listed}");
    }

    #[test]
    #[cfg(unix)]
    fn reads_refuse_a_final_component_swapped_to_a_symlink_after_authorization() {
        // The read twin of the write race: authorization passes on a real
        // file INSIDE the roots, then the file's name is replaced by a
        // symlink pointing at a secret OUTSIDE. The beneath-walk opens the
        // final component O_NOFOLLOW off the walked parent descriptor — the
        // swap refuses instead of reading the secret.
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).expect("proj");
        std::fs::write(project.join("doc.txt"), b"inside").expect("doc");
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, b"TOP SECRET").expect("secret");
        state.propose_path(&project);
        let roots = state.file_roots.lock().unwrap();
        let (resolved, root) = crate::file_access::resolved_read_target_with_root(
            &roots,
            &project.join("doc.txt"),
        )
        .expect("the honest file authorizes");
        // The ATTACK: swap the final component for a symlink to the secret.
        std::fs::remove_file(project.join("doc.txt")).expect("remove");
        std::os::unix::fs::symlink(&secret, project.join("doc.txt")).expect("swap");
        // The stale authorized pair + the walk: refuses, never reads out.
        let outcome = crate::file_access::read_beneath_root(&root, &resolved);
        assert!(outcome.is_err(), "the swapped final component refuses: {outcome:?}");
        // And through the IPC surface (fresh authorization) it also refuses:
        // canonicalize now resolves through the link to the secret — outside.
        drop(roots);
        let read = send(
            &state,
            json!({ "v": 1, "id": "rr1", "op": "files.read", "args": { "path": project.join("doc.txt").display().to_string() } }),
        );
        assert_eq!(read["error"]["code"], "unauthorized_scope", "{read}");
    }

    #[test]
    #[cfg(unix)]
    fn writes_refuse_an_ancestor_directory_swapped_to_a_symlink() {
        // THE ancestor race the open(parent, O_NOFOLLOW) shape missed:
        // O_NOFOLLOW only guards the parent path's FINAL component, so an
        // ANCESTOR (root/a when writing root/a/b/file) swapped for a symlink
        // was followed to wherever it pointed. The beneath-walk refuses it:
        // every component below the authorized root opens
        // openat(O_DIRECTORY|O_NOFOLLOW) off the ROOT's descriptor.
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        let a = project.join("a");
        let b = a.join("b");
        std::fs::create_dir_all(&b).expect("b");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        state.propose_path(&project);
        let roots = state.file_roots.lock().unwrap();

        // Authorization passes on the honest layout — and SNAPSHOT the
        // authorized (root, parent) pair, exactly what production holds
        // between its check and its open.
        let (authorized_parent, authorized_root) = roots
            .resolved_write_parent_with_root(&b.join("file.txt"))
            .expect("the honest path authorizes");
        // ...then the ATTACK: `a` is replaced by a symlink pointing out.
        std::fs::remove_dir_all(&a).expect("remove a");
        std::os::unix::fs::symlink(&outside, &a).expect("swap a");

        // THE race window: the authorization above already PASSED (it ran on
        // the honest layout, exactly like production where the check and the
        // open are separate steps). Now the write walks with the STALE
        // authorized pair — the walk must refuse the swapped ancestor
        // instead of following it (the old open(parent, O_NOFOLLOW) shape
        // followed `a` and landed in outside/b).
        let refusal = match crate::file_access::write_beneath_root_for_tests(
            &authorized_root,
            &authorized_parent,
            "file.txt",
            b"escaped",
        ) {
            Err(refusal) => refusal,
            Ok(()) => panic!("the swapped ancestor must refuse the write"),
        };
        assert!(
            matches!(refusal, crate::file_access::WriteRefusal::FinalComponentSymlink),
            "refused as a symlink component: {refusal:?}"
        );
        assert!(
            !outside.join("b").join("file.txt").exists(),
            "NOTHING was created through the swapped ancestor"
        );
        drop(roots);

        // Sanity: the refusal is not an accident of ordering — the same
        // request through the IPC surface answers unauthorized_scope.
        let evil = send(
            &state,
            json!({
                "v": 1, "id": "anc1", "op": "files.write",
                "args": {
                    "path": b.join("file.txt").display().to_string(),
                    "data": base64::engine::general_purpose::STANDARD.encode("x"),
                },
            }),
        );
        assert_eq!(evil["error"]["code"], "unauthorized_scope", "{evil}");
        assert!(!outside.join("b").join("file.txt").exists());
    }

    #[test]
    #[cfg(unix)]
    fn writes_through_a_real_file_still_work_and_keep_modes() {
        // The hardening must not break the honest paths: a new plain file,
        // an overwrite of a plain file (content replaced), and an existing
        // mode is preserved (O_CREAT is a no-op on an existing file).
        use std::os::unix::fs::PermissionsExt;
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).expect("proj");
        state.propose_path(&project);
        let write = |name: &str, data: &str| {
            send(
                &state,
                json!({
                    "v": 1, "id": format!("w-{name}"), "op": "files.write",
                    "args": {
                        "path": project.join(name).display().to_string(),
                        "data": base64::engine::general_purpose::STANDARD.encode(data),
                    },
                }),
            )
        };
        assert_eq!(write("new.txt", "first")["ok"], true);
        assert_eq!(std::fs::read_to_string(project.join("new.txt")).unwrap(), "first");
        assert_eq!(write("new.txt", "second")["ok"], true);
        assert_eq!(std::fs::read_to_string(project.join("new.txt")).unwrap(), "second");
        std::fs::set_permissions(project.join("new.txt"), std::fs::Permissions::from_mode(0o600))
            .expect("mode");
        assert_eq!(write("new.txt", "third")["ok"], true);
        assert_eq!(
            std::fs::metadata(project.join("new.txt")).unwrap().permissions().mode() & 0o777,
            0o600,
            "the existing file's mode survives the overwrite"
        );
    }

    #[test]
    #[cfg(unix)]
    fn writes_refuse_a_symlinked_final_component() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).expect("proj");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        // A symlink INSIDE the project pointing OUT: lexically the write is
        // inside the root, but following the link would land outside. The
        // new-path rule authorizes through the resolved parent, so the
        // resolved link target's parent (outside) fails containment.
        std::os::unix::fs::symlink(&outside, project.join("leak")).expect("leak");
        state.propose_path(&project);

        let evil = send(
            &state,
            json!({
                "v": 1, "id": "s1", "op": "files.write",
                "args": {
                    "path": project.join("leak/evil.txt").display().to_string(),
                    "data": base64::engine::general_purpose::STANDARD.encode("x"),
                },
            }),
        );
        assert_eq!(evil["error"]["code"], "unauthorized_scope", "{evil}");
        assert!(!outside.join("evil.txt").exists(), "nothing escaped");

        // Reading through the link is refused as well (resolved target).
        std::fs::write(outside.join("secret"), b"s").expect("secret");
        let read = send(
            &state,
            json!({ "v": 1, "id": "s2", "op": "files.read", "args": { "path": project.join("leak/secret").display().to_string() } }),
        );
        assert_eq!(read["error"]["code"], "unauthorized_scope");
    }

    #[test]
    fn resource_grants_only_accept_host_proposed_paths() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let png = dir.path().join("shot.png");
        std::fs::write(&png, vec![1u8; 8]).expect("write");

        // An arbitrary frontend path — even an existing file — is refused.
        let denied = send(
            &state,
            json!({ "v": 1, "id": "g0", "op": "resources.grantFile", "args": { "path": png.display().to_string() } }),
        );
        assert_eq!(denied["error"]["code"], "unauthorized_scope", "{denied}");

        // Once the HOST proposed the path (the session index shape), the
        // grant is a pure confirmation.
        state.propose_path(&png);
        let grant = send(
            &state,
            json!({ "v": 1, "id": "g1", "op": "resources.grantFile", "args": { "path": png.display().to_string() } }),
        );
        assert_eq!(grant["ok"], true, "{grant}");
        let handle = grant["data"]["handle"].as_str().expect("handle").to_string();
        let read = send(
            &state,
            json!({ "v": 1, "id": "g2", "op": "resources.read", "args": { "handle": handle } }),
        );
        assert_eq!(read["data"]["totalLen"], 8);
    }

    #[test]
    fn terminal_cwd_must_be_inside_the_allowed_roots() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).expect("proj");
        // A missing cwd cannot inherit the host process cwd.
        let bare = send(
            &state,
            json!({ "v": 1, "id": "tc1", "op": "terminal.create", "args": { "id": "t-a" } }),
        );
        assert_eq!(bare["error"]["code"], "invalid_args", "{bare}");
        // An allowed cwd: fine.
        state.propose_path(&project);
        let inside = send(
            &state,
            json!({ "v": 1, "id": "tc2", "op": "terminal.create", "args": { "id": "t-b", "cwd": project.display().to_string() } }),
        );
        assert_eq!(inside["ok"], true, "{inside}");
        // An arbitrary cwd: refused before any PTY exists.
        let refused = send(
            &state,
            json!({ "v": 1, "id": "tc3", "op": "terminal.create", "args": { "id": "t-c", "cwd": "/etc" } }),
        );
        assert_eq!(refused["error"]["code"], "unauthorized_scope", "{refused}");
        let agent = dir.path().join("agent");
        *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
        let chat = agent.join("chats/folder/nested");
        let legacy = agent.join("chat-workspace/nested");
        std::fs::create_dir_all(&chat).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        state.propose_path(dir.path());
        for (i, path) in [agent.join("chats"), chat, legacy].iter().enumerate() {
            let result = send(&state, json!({ "v": 1, "id": format!("chat-{i}"), "op": "terminal.create", "args": { "id": format!("chat-{i}"), "cwd": path } }));
            assert_eq!(result["error"]["code"], "unauthorized_scope", "{result}");
            assert!(state.terminals.get(&format!("chat-{i}")).is_none());
        }
        state.terminals.close("t-b");
    }

    #[test]
    fn agent_commands_refuse_unknown_types_and_bad_shapes() {
        let state = state();
        let dir = tempfile::tempdir().expect("isolated agent dir");
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        // Shape validation runs BEFORE the session lookup: a malformed
        // command never reaches a child (or spawns one).
        let ghost = send(
            &state,
            json!({ "v": 1, "id": "c1", "op": "agent.command", "args": { "session": "ghost", "type": "get_state" } }),
        );
        assert_eq!(ghost["error"]["code"], "not_found", "a valid shape on a ghost session: {ghost}");
        let no_type = send(
            &state,
            json!({ "v": 1, "id": "c2", "op": "agent.command", "args": { "session": "ghost" } }),
        );
        assert_eq!(no_type["error"]["code"], "invalid_args", "the enum check precedes the lookup: {no_type}");
        let unknown = send(
            &state,
            json!({ "v": 1, "id": "c2b", "op": "agent.command", "args": { "session": "ghost", "type": "shell.exec" } }),
        );
        assert_eq!(unknown["error"]["code"], "invalid_args");
        // Branch actions validate before resolving or spawning a session.
        let host_level = send(
            &state,
            json!({ "v": 1, "id": "c2c", "op": "agent.command", "args": { "session": "ghost", "type": "fork" } }),
        );
        assert_eq!(host_level["error"]["code"], "invalid_args", "{host_level}");
        let summary = send(
            &state,
            json!({ "v": 1, "id": "c2d", "op": "agent.command", "args": { "session": "ghost", "type": "navigate_tree", "targetId": "entry", "summarize": true } }),
        );
        assert_eq!(summary["error"]["code"], "not_supported", "{summary}");
    }

    #[test]
    fn models_ops_answer_management_unavailable_until_configured() {
        let state = state();
        // Deterministic: never depend on whether this machine's resources/pi
        // happened to be staged (release CI stages it). The cwd is allowed
        // (the gate must pass) so the refusal proves the CONFIG half.
        *state.management_config.lock().unwrap() = None;
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path()).expect("dir");
        state.propose_path(dir.path());
        let response = send(
            &state,
            json!({ "v": 1, "id": "m1", "op": "models.list", "args": { "cwd": dir.path().to_string_lossy() } }),
        );
        assert_eq!(response["ok"], false, "{response}");
        assert_eq!(response["error"]["code"], "management_unavailable");
        assert_eq!(response["error"]["retryable"], false);
    }

    #[test]
    fn models_ops_gate_the_cwd_before_any_management_instance() {
        // The routes' 400/403 half stays HOST-side: the cwd must exist and
        // sit inside the allowed roots BEFORE a management child spawns (a
        // refused request must never pay for an instance, and an arbitrary
        // directory must never scope a management child).
        let state = state();
        *state.management_config.lock().unwrap() = None;
        // A missing cwd argument.
        let missing = send(&state, json!({ "v": 1, "id": "m2", "op": "models.list", "args": {} }));
        assert_eq!(missing["ok"], false, "{missing}");
        assert_eq!(missing["error"]["code"], "invalid_args");
        // A directory that does not exist (the route's 400 text).
        let absent = send(
            &state,
            json!({ "v": 1, "id": "m3", "op": "models.list", "args": { "cwd": "/nonexistent-pi-web-models-gate" } }),
        );
        assert_eq!(absent["ok"], false, "{absent}");
        assert_eq!(absent["error"]["code"], "invalid_args");
        assert!(absent["error"]["message"].as_str().unwrap().starts_with("Directory does not exist"));
        // An existing directory OUTSIDE the allowed roots (the route's 403).
        let outside = std::env::temp_dir().join("pi-web-models-gate-outside-root");
        std::fs::create_dir_all(&outside).expect("gate dir");
        let denied = send(
            &state,
            json!({ "v": 1, "id": "m4", "op": "models.setDefault", "args": {
                "cwd": outside.to_string_lossy(), "thinkingLevel": "high",
            }}),
        );
        assert_eq!(denied["ok"], false, "{denied}");
        assert_eq!(denied["error"]["code"], "access_denied");
        std::fs::remove_dir(&outside).ok();
    }

    /// The gated entry the async `pi_ipc` command delegates to: while a
    /// slow management op (a real child that takes seconds before its pipe
    /// closes) holds a dispatch slot, other envelopes through the SAME
    /// entry must answer. The SYNC command variant ran every envelope
    /// inline on the WebView's protocol/UI thread, where one slow
    /// management spawn froze every later invoke and the window itself —
    /// this is that product regression, kept deterministic with a stub
    /// child (sleep, then exit: stdin EOF fails the pending prompt, so the
    /// slow op always resolves; the test never hangs nor leaks a slot).
    #[test]
    #[cfg(unix)]
    fn slow_models_dispatch_does_not_block_other_envelopes() {
        let state = Arc::new(state());
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let project = dir.path().join("work");
        std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
        std::fs::create_dir_all(&project).expect("project dir");
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        let stub = dir.path().join("slow-mgmt-pi.sh");
        std::fs::write(&stub, "#!/bin/sh\nsleep 3\n").expect("the stub script writes");
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755))
                .expect("the stub script is executable");
        }
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable: stub.to_string_lossy().into_owned(),
            agent_dir: Some(agent_dir),
            extensions: vec![],
            env: vec![],
        });
        state.propose_path(&project);

        let slow = tauri::async_runtime::spawn(dispatch_envelope_gated(
            Arc::clone(&state),
            json!({ "v": 1, "id": "slow", "op": "models.list", "args": { "cwd": project.to_string_lossy() } }),
        ));
        // Settle onto the slow call's child wait (spawn + prompt write); the
        // settle is a small fraction of the 3 s window, so the probe runs
        // while the slot is held — whenever the wait actually starts.
        std::thread::sleep(Duration::from_millis(400));
        let start = std::time::Instant::now();
        let probe = tauri::async_runtime::block_on(dispatch_envelope_gated(
            Arc::clone(&state),
            json!({ "v": 1, "id": "probe", "op": "desktop.identity" }),
        ));
        assert_eq!(probe["ok"], true, "{probe}");
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "the identity probe waited {} ms — a slow models op is blocking dispatch",
            start.elapsed().as_millis()
        );
        // The slow envelope itself always resolves (the stub's exit fails
        // its prompt): no leaked slot, and the real failure proves the probe
        // really ran beside the blocked management wait.
        let slow = tauri::async_runtime::block_on(slow).expect("the slow dispatch joins");
        assert_eq!(slow["ok"], false, "the stub child exits: models.list answers its real failure");
        assert_eq!(slow["error"]["code"], "io", "{slow}");
    }

    /// The async `pi_ipc` command is the product boundary. This pins the
    /// delegation (a cheap tripwire, NOT the only evidence — the behavioral
    /// test above and the static-UI acceptance run are): a revert to a sync
    /// command would put envelopes back on the WebView's UI thread, the
    /// freeze this dispatch layer exists to prevent.
    #[test]
    fn pi_ipc_command_stays_the_async_gated_entry() {
        let source = include_str!("pi_ipc.rs");
        assert!(
            source.contains("pub async fn pi_ipc(app: tauri::AppHandle, request: Value) -> Value"),
            "pi_ipc must stay an async command (a sync command runs envelopes on the WebView's UI thread)"
        );
        assert!(
            source.contains("app.state::<Arc<IpcHostState>>().inner().clone()"),
            "pi_ipc must run over the shared Arc state"
        );
        assert!(
            source.contains("dispatch_envelope_gated(state, request).await"),
            "pi_ipc must delegate to dispatch_envelope_gated (the harness's dispatch path)"
        );
    }

    /// The models domain over the REAL pi management instance (PI_CLI_BIN,
    /// sandboxed agent dir + a staged managed tree): models.list answers the
    /// full /api/models contract through the host's cwd gate and the
    /// cwd-SCOPED instance, and models.setDefault writes the real global
    /// default (the differential-vs-repo half lives in
    /// scripts/migration/management-extension.test.mjs; this is the host's
    /// dispatch + scope wiring).
    #[test]
    fn real_pi_models_ops_answer_the_contract_through_a_scoped_instance() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let project = dir.path().join("work");
        std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
        std::fs::create_dir_all(&project).expect("project dir");
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        let managed = stage_managed_tree(dir.path());
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable: executable.clone(),
            agent_dir: Some(agent_dir.clone()),
            extensions: vec![
                std::path::Path::new("../lib/pi-rpc/assets/pi-web-management.mjs")
                    .canonicalize()
                    .expect("management asset"),
            ],
            env: vec![
                ("PI_WEB_MANAGED_MODULES".to_string(), managed.display().to_string()),
            ],
        });
        // A fixture provider (never a real credential, never a real network).
        std::fs::write(
            agent_dir.join("models.json"),
            r#"{"providers":{"fixture-provider":{"name":"Fixture Provider","baseUrl":"http://127.0.0.1:9/v1","apiKey":"fixture-key","api":"openai-completions","models":[{"id":"fixture-model","name":"Fixture Model"}]}}}"#,
        )
        .expect("models.json");
        // The project must sit inside the allowed roots (the cwd gate).
        state.propose_path(&project);

        // 1. models.list: the /api/models contract for the project cwd.
        let listed = send(
            &state,
            json!({ "v": 1, "id": "ml1", "op": "models.list", "args": { "cwd": project.to_string_lossy() } }),
        );
        assert_eq!(listed["ok"], true, "{listed}");
        assert_eq!(listed["data"]["models"]["fixture-provider:fixture-model"], "Fixture Model", "{listed}");
        assert_eq!(listed["data"]["modelList"][0]["provider"], "fixture-provider", "{listed}");
        assert_eq!(listed["data"]["modelList"][0]["input"][0], "text", "{listed}");
        assert!(listed["data"]["thinkingLevels"]["fixture-provider:fixture-model"].is_array(), "{listed}");

        // 2. The scoped instance exists for the project cwd (one scope key).
        let scopes = state.management.scopes();
        assert_eq!(scopes.len(), 1, "one cwd-scoped instance: {scopes:?}");
        assert!(scopes[0].contains("work"), "the scope is the project cwd: {scopes:?}");

        // 3. models.setDefault: the star writes the global default.
        let saved = send(
            &state,
            json!({ "v": 1, "id": "md1", "op": "models.setDefault", "args": {
                "cwd": project.to_string_lossy(), "thinkingLevel": "medium",
            }}),
        );
        assert_eq!(saved["ok"], true, "{saved}");
        let settings = std::fs::read_to_string(agent_dir.join("settings.json")).expect("settings.json");
        assert!(settings.contains("\"defaultThinkingLevel\": \"medium\""), "{settings}");

        // 4. The refreshed list carries the saved default (cache invalidated).
        let refreshed = send(
            &state,
            json!({ "v": 1, "id": "ml2", "op": "models.list", "args": { "cwd": project.to_string_lossy() } }),
        );
        assert_eq!(refreshed["ok"], true, "{refreshed}");
        assert_eq!(refreshed["data"]["defaultThinkingLevel"], "medium", "{refreshed}");

        // 5. An out-of-scope model refuses with the route's 404 shape.
        let refused = send(
            &state,
            json!({ "v": 1, "id": "md2", "op": "models.setDefault", "args": {
                "cwd": project.to_string_lossy(), "provider": "nope", "modelId": "nope",
            }}),
        );
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(refused["error"]["code"], "not_found", "{refused}");

        state.management.shutdown_all(std::time::Duration::from_secs(5));
    }

    /// The enabledModels ops' HOST-side half: the cwd gate (the route's
    /// 400/403) and the CLOSED payload (the route's 400 field validation)
    /// both answer BEFORE a management child is ever asked — an allowed cwd
    /// with no configured instance proves the ordering by answering
    /// management_unavailable, never a spawned child nor a silent pass.
    #[test]
    fn models_enabled_ops_gate_the_cwd_and_closed_payload_before_any_instance() {
        let state = state();
        *state.management_config.lock().unwrap() = None;
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path()).expect("dir");
        state.propose_path(dir.path());
        let cwd = dir.path().to_string_lossy().into_owned();

        // The op enum is closed: an unknown value never reaches an instance.
        for (label, args) in [
            ("unknown op", json!({ "cwd": cwd, "op": "nonsense" })),
            (
                "enabled missing",
                json!({ "cwd": cwd, "op": "models", "refs": ["p/m"] }),
            ),
            (
                "enabled wrong type",
                json!({ "cwd": cwd, "op": "provider", "provider": "p", "enabled": "yes" }),
            ),
            (
                "refs not strings",
                json!({ "cwd": cwd, "op": "models", "refs": [1, 2], "enabled": true }),
            ),
            ("provider empty", json!({ "cwd": cwd, "op": "provider", "provider": "", "enabled": true })),
            (
                "resync without renames",
                json!({ "cwd": cwd, "op": "resync" }),
            ),
            (
                "resync pair missing to",
                json!({ "cwd": cwd, "op": "resync", "renames": [{ "from": "a" }] }),
            ),
        ] {
            let response = send(
                &state,
                json!({ "v": 1, "id": "me", "op": "models.enabledSet", "args": args }),
            );
            assert_eq!(response["ok"], false, "{label}: {response}");
            assert_eq!(response["error"]["code"], "invalid_args", "{label}: {response}");
        }
        // The seam's own field-error texts (one vocabulary with the route).
        let bad_op = send(
            &state,
            json!({ "v": 1, "id": "me2", "op": "models.enabledSet", "args": { "cwd": cwd, "op": 7 } }),
        );
        assert_eq!(bad_op["error"]["message"], "Invalid op", "{bad_op}");
        let bad_refs = send(
            &state,
            json!({ "v": 1, "id": "me3", "op": "models.enabledSet", "args": {
                "cwd": cwd, "op": "models", "refs": "x", "enabled": false,
            }}),
        );
        assert_eq!(bad_refs["error"]["message"], "refs must be an array of strings", "{bad_refs}");

        // The cwd gate answers before any instance: a missing cwd, a
        // nonexistent directory and an out-of-roots directory all refuse
        // (models.en enabledGet shares the gate).
        let missing = send(
            &state,
            json!({ "v": 1, "id": "me4", "op": "models.enabledGet", "args": {} }),
        );
        assert_eq!(missing["error"]["code"], "invalid_args", "{missing}");
        let absent = send(
            &state,
            json!({ "v": 1, "id": "me5", "op": "models.enabledGet", "args": {
                "cwd": "/nonexistent-pi-web-enabled-gate",
            }}),
        );
        assert_eq!(absent["error"]["code"], "invalid_args", "{absent}");
        assert!(absent["error"]["message"].as_str().unwrap().starts_with("Directory does not exist"));
        let outside = std::env::temp_dir().join("pi-web-enabled-gate-outside-root");
        std::fs::create_dir_all(&outside).expect("gate dir");
        let denied = send(
            &state,
            json!({ "v": 1, "id": "me6", "op": "models.enabledSet", "args": {
                "cwd": outside.to_string_lossy(), "op": "clear",
            }}),
        );
        assert_eq!(denied["error"]["code"], "access_denied", "{denied}");
        std::fs::remove_dir(&outside).ok();

        // A VALID request on an allowed cwd answers the config half
        // (management_unavailable — never a fallback, never a lie).
        let unconfigured = send(
            &state,
            json!({ "v": 1, "id": "me7", "op": "models.enabledGet", "args": { "cwd": cwd } }),
        );
        assert_eq!(unconfigured["ok"], false, "{unconfigured}");
        assert_eq!(unconfigured["error"]["code"], "management_unavailable");
    }

    /// `modelsConfig.put` gates its closed envelope (the draft must be a
    /// JSON object; a present `providers` must be an object of provider
    /// objects) before any management instance is spawned. Note the one
    /// deliberate boundary difference: a NULL `providers` is refused here
    /// while the old route's `?? {}` collapsed it to an empty map — a
    /// degenerate payload no real client sends, and a silent wipe of every
    /// provider is exactly what a closed boundary should stop.
    #[test]
    fn models_config_put_gates_the_envelope_before_any_instance() {
        let state = state();
        *state.management_config.lock().unwrap() = None;

        for (label, args, message) in [
            (
                "config missing",
                json!({}),
                "config is required",
            ),
            (
                "config a string",
                json!({ "config": "x" }),
                "config must be a JSON object",
            ),
            (
                "config an array",
                json!({ "config": [1, 2] }),
                "config must be a JSON object",
            ),
            (
                "providers a string",
                json!({ "config": { "providers": "x" } }),
                "providers must be a JSON object",
            ),
            (
                "providers null",
                json!({ "config": { "providers": null } }),
                "providers must be a JSON object",
            ),
            (
                "provider value a number",
                json!({ "config": { "providers": { "p": 7 } } }),
                "providers.p must be a JSON object",
            ),
            (
                "provider value an array",
                json!({ "config": { "providers": { "p": [1] } } }),
                "providers.p must be a JSON object",
            ),
        ] {
            let response = send(
                &state,
                json!({ "v": 1, "id": "mc1", "op": "modelsConfig.put", "args": args }),
            );
            assert_eq!(response["ok"], false, "{label}: {response}");
            assert_eq!(response["error"]["code"], "invalid_args", "{label}: {response}");
            assert_eq!(response["error"]["message"], message, "{label}: {response}");
        }

        // A VALID envelope (unknown fields inside are the file's own
        // schema — they pass verbatim) reaches the instance half
        // (management_unavailable — never a fallback, never a lie).
        let unconfigured = send(
            &state,
            json!({ "v": 1, "id": "mc2", "op": "modelsConfig.put", "args": {
                "config": { "x-future-field": { "nested": true }, "providers": {} }
            }}),
        );
        assert_eq!(unconfigured["ok"], false, "{unconfigured}");
        assert_eq!(unconfigured["error"]["code"], "management_unavailable");
    }

    #[test]
    fn models_extras_gates_envelopes_before_any_instance() {
        let state = state();
        *state.management_config.lock().unwrap() = None;

        // modelsConfig.discover validations
        for (label, args, message) in [
            ("discover missing providerName", json!({}), "providerName is required"),
            ("discover empty providerName", json!({ "providerName": "  " }), "providerName is required"),
            ("discover missing provider", json!({ "providerName": "p" }), "provider must be a JSON object"),
            ("discover non-object provider", json!({ "providerName": "p", "provider": "x" }), "provider must be a JSON object"),
        ] {
            let response = send(
                &state,
                json!({ "v": 1, "id": "mdisc", "op": "modelsConfig.discover", "args": args }),
            );
            assert_eq!(response["ok"], false, "{label}: {response}");
            assert_eq!(response["error"]["code"], "invalid_args", "{label}: {response}");
            assert_eq!(response["error"]["message"], message, "{label}: {response}");
        }

        // modelsConfig.test validations
        for (label, args, message) in [
            ("test missing providerName", json!({}), "providerName is required"),
            ("test missing provider", json!({ "providerName": "p" }), "provider must be a JSON object"),
            ("test missing model", json!({ "providerName": "p", "provider": {} }), "model must be a JSON object"),
            ("test missing model.id", json!({ "providerName": "p", "provider": {}, "model": {} }), "Model ID is required"),
        ] {
            let response = send(
                &state,
                json!({ "v": 1, "id": "mtest", "op": "modelsConfig.test", "args": args }),
            );
            assert_eq!(response["ok"], false, "{label}: {response}");
            assert_eq!(response["error"]["code"], "invalid_args", "{label}: {response}");
            assert_eq!(response["error"]["message"], message, "{label}: {response}");
        }

        // models.providerUsage validations
        let no_provider_id = send(
            &state,
            json!({ "v": 1, "id": "musage", "op": "models.providerUsage", "args": {} }),
        );
        assert_eq!(no_provider_id["ok"], false, "{no_provider_id}");
        assert_eq!(no_provider_id["error"]["code"], "invalid_args", "{no_provider_id}");
        assert_eq!(no_provider_id["error"]["message"], "providerId is required", "{no_provider_id}");

        // Valid requests reach the unconfigured management instance:
        for (op, args) in [
            ("modelsConfig.catalog", json!({})),
            ("modelsConfig.discover", json!({ "providerName": "p", "provider": {} })),
            ("modelsConfig.test", json!({ "providerName": "p", "provider": {}, "model": { "id": "m" } })),
            ("models.nonchat", json!({})),
            ("models.refreshCatalog", json!({})),
            ("models.providerUsage", json!({ "providerId": "deepseek" })),
        ] {
            let res = send(&state, json!({ "v": 1, "id": "mext", "op": op, "args": args }));
            assert_eq!(res["ok"], false, "{op}: {res}");
            assert_eq!(res["error"]["code"], "management_unavailable", "{op}: {res}");
        }
    }

    /// The models.json save over the REAL pi management instance
    /// (PI_CLI_BIN, sandboxed agent dir + a staged managed tree): the
    /// stored-literal merge, the redaction on the read, and the shaped
    /// read refusal with the protocol's preserved `reason` field (the full
    /// byte-level differential against the repo composition lives in
    /// scripts/migration/management-extension.test.mjs; this pins the
    /// host's dispatch and the global-instance wiring).
    #[test]
    fn real_pi_models_config_put_saves_through_the_global_instance() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        let managed = stage_managed_tree(dir.path());
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable: executable.clone(),
            agent_dir: Some(agent_dir.clone()),
            extensions: vec![
                std::path::Path::new("../lib/pi-rpc/assets/pi-web-management.mjs")
                    .canonicalize()
                    .expect("management asset"),
            ],
            env: vec![
                ("PI_WEB_MANAGED_MODULES".to_string(), managed.display().to_string()),
            ],
        });
        // A fixture with literal apiKeys (never a real credential), an
        // unknown top-level field and a partial cost group: the save must
        // keep the file's own schema and run the store's normalization.
        std::fs::write(
            agent_dir.join("models.json"),
            r#"{"x-future-field":{"nested":true},"providers":{
                "fixture-provider":{"name":"Fixture Provider","baseUrl":"http://127.0.0.1:9/v1","apiKey":"fixture-key","api":"openai-completions","models":[{"id":"fixture-model"}]},
                "fixture-second":{"name":"Fixture Second","baseUrl":"http://127.0.0.1:9/v1","apiKey":"fixture-second-key","api":"openai-completions","models":[{"id":"fixture-second-model"}]}}}"#,
        )
        .expect("models.json");

        // 1. The read the panel starts from: literal keys redacted, the
        //    unknown field visible.
        let read = send(
            &state,
            json!({ "v": 1, "id": "mcr1", "op": "modelsConfig.get" }),
        );
        assert_eq!(read["ok"], true, "{read}");
        assert_eq!(read["data"]["providers"]["fixture-provider"]["apiKey"], Value::Null, "{read}");
        assert_eq!(read["data"]["x-future-field"]["nested"], true, "{read}");
        // The global instance (no cwd scope — the route's unscoped PUT).
        let scopes = state.management.scopes();
        assert!(scopes.iter().all(|scope| scope == "global"), "no cwd scope was created: {scopes:?}");

        // 2. The save: the panel's draft after the redacted load — the
        //    renamed provider has no apiKey, the untouched one keeps its
        //    place with the literal merged back server-side.
        let saved = send(
            &state,
            json!({ "v": 1, "id": "mcp1", "op": "modelsConfig.put", "args": { "config": {
                "x-future-field": { "nested": true },
                "providers": {
                    "fixture-renamed": { "name": "Fixture Provider", "baseUrl": "http://127.0.0.1:9/v1", "api": "openai-completions",
                                          "models": [{ "id": "fixture-model" }, { "id": "" }] },
                    "fixture-second": { "name": "Fixture Second", "baseUrl": "http://127.0.0.1:10/v1", "api": "openai-completions",
                                         "models": [{ "id": "fixture-second-model", "cost": { "input": 1 } }] }
                }
            }}}),
        );
        assert_eq!(saved["ok"], true, "{saved}");
        let disk: Value = serde_json::from_str(
            &std::fs::read_to_string(agent_dir.join("models.json")).expect("models.json"),
        )
        .expect("models.json JSON");
        assert_eq!(disk["x-future-field"]["nested"], true, "unknown field kept: {disk}");
        assert_eq!(disk["providers"]["fixture-renamed"]["apiKey"], Value::Null, "a rename does not carry the literal: {disk}");
        assert_eq!(disk["providers"]["fixture-second"]["apiKey"], "fixture-second-key", "the untouched literal merged back: {disk}");
        assert_eq!(disk["providers"]["fixture-second"]["baseUrl"], "http://127.0.0.1:10/v1", "the edit landed: {disk}");
        assert_eq!(
            disk["providers"]["fixture-second"]["models"][0]["cost"],
            json!({ "input": 1, "output": 0, "cacheRead": 0, "cacheWrite": 0 }),
            "the store's cost normalization ran: {disk}"
        );
        assert_eq!(disk["providers"]["fixture-renamed"]["models"].as_array().unwrap().len(), 1, "blank row dropped: {disk}");

        // 3. The redaction still holds after the save.
        let reread = send(
            &state,
            json!({ "v": 1, "id": "mcr2", "op": "modelsConfig.get" }),
        );
        assert_eq!(reread["ok"], true, "{reread}");
        assert_eq!(reread["data"]["providers"]["fixture-second"]["apiKey"], Value::Null, "{reread}");
        assert_eq!(reread["data"]["providers"]["fixture-renamed"]["name"], "Fixture Provider", "{reread}");

        // 4. A models.json the composition cannot read refuses the save —
        //    never a replacement — with the route's 409 reason preserved.
        let broken = "{ \"providers\": [ broken";
        std::fs::write(agent_dir.join("models.json"), broken).expect("broken models.json");
        let refused = send(
            &state,
            json!({ "v": 1, "id": "mcp2", "op": "modelsConfig.put", "args": { "config": { "providers": {} } }}),
        );
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(refused["error"]["reason"], "models-config-read", "{refused}");
        assert!(refused["error"]["message"].as_str().unwrap().starts_with("Failed to read"), "{refused}");
        assert_eq!(std::fs::read_to_string(agent_dir.join("models.json")).unwrap(), broken);

        state.management.shutdown_all(std::time::Duration::from_secs(5));
    }

    /// The enabledModels domain over the REAL pi management instance
    /// (PI_CLI_BIN, sandboxed agent dir + a staged managed tree): the view,
    /// a minimal-edit write into the real settings.json, and the shaped
    /// refusals with the protocol's preserved `reason` field (the full
    /// composition differential lives in
    /// scripts/migration/management-extension.test.mjs; this pins the host's
    /// dispatch, scope wiring and refusal envelope).
    #[test]
    fn real_pi_enabled_models_ops_write_settings_through_a_scoped_instance() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let project = dir.path().join("work");
        std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
        std::fs::create_dir_all(&project).expect("project dir");
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        let managed = stage_managed_tree(dir.path());
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable: executable.clone(),
            agent_dir: Some(agent_dir.clone()),
            extensions: vec![
                std::path::Path::new("../lib/pi-rpc/assets/pi-web-management.mjs")
                    .canonicalize()
                    .expect("management asset"),
            ],
            env: vec![
                ("PI_WEB_MANAGED_MODULES".to_string(), managed.display().to_string()),
            ],
        });
        // A fixture provider with TWO models (never a real credential, never
        // a real network) + one unknown stored entry every edit must keep.
        std::fs::write(
            agent_dir.join("models.json"),
            r#"{"providers":{"fixture-provider":{"name":"Fixture Provider","baseUrl":"http://127.0.0.1:9/v1","apiKey":"fixture-key","api":"openai-completions","models":[{"id":"fixture-a"},{"id":"fixture-b"}]}}}"#,
        )
        .expect("models.json");
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"enabledModels":["ghost-provider/ghost-model"]}"#,
        )
        .expect("settings.json");
        state.propose_path(&project);

        // 1. The read: the exact EnabledModelsView through the cwd gate and
        //    the cwd-SCOPED instance.
        let read = send(
            &state,
            json!({ "v": 1, "id": "eg1", "op": "models.enabledGet", "args": { "cwd": project.to_string_lossy() } }),
        );
        assert_eq!(read["ok"], true, "{read}");
        assert_eq!(read["data"]["scope"], "global", "{read}");
        assert_eq!(read["data"]["editable"], true, "{read}");
        assert_eq!(read["data"]["availableTotal"], 2, "{read}");
        assert_eq!(read["data"]["stalePatterns"].as_array().unwrap().len(), 1, "{read}");
        let scopes = state.management.scopes();
        assert_eq!(scopes.len(), 1, "one cwd-scoped instance: {scopes:?}");

        // 2. The write: a single-model toggle is the minimal edit, and the
        //    unknown entry survives verbatim.
        let off = send(
            &state,
            json!({ "v": 1, "id": "es1", "op": "models.enabledSet", "args": {
                "cwd": project.to_string_lossy(), "op": "models",
                "refs": ["fixture-provider/fixture-a"], "enabled": false,
            }}),
        );
        assert_eq!(off["ok"], true, "{off}");
        assert_eq!(off["data"]["enabledTotal"], 1, "{off}");
        let stored = std::fs::read_to_string(agent_dir.join("settings.json")).expect("settings.json");
        assert!(stored.contains("ghost-provider/ghost-model"), "stale kept: {stored}");
        assert!(stored.contains("fixture-provider/fixture-b"), "the survivor is explicit: {stored}");
        assert!(!stored.contains("fixture-a"), "the disabled model is gone: {stored}");

        // 3. The last-model refusal: code io + the preserved HTTP reason.
        let last = send(
            &state,
            json!({ "v": 1, "id": "es2", "op": "models.enabledSet", "args": {
                "cwd": project.to_string_lossy(), "op": "models",
                "refs": ["fixture-provider/fixture-b"], "enabled": false,
            }}),
        );
        assert_eq!(last["ok"], false, "{last}");
        assert_eq!(last["error"]["reason"], "last-model", "{last}");
        assert_eq!(last["error"]["message"], "At least one model must stay enabled", "{last}");

        // 4. A project settings.json shadows the global value: read-only
        //    view, refused write with the preserved reason.
        std::fs::create_dir_all(project.join(".pi")).expect(".pi");
        std::fs::write(
            project.join(".pi").join("settings.json"),
            r#"{"enabledModels":["fixture-provider/*"]}"#,
        )
        .expect("project settings");
        let shadowed = send(
            &state,
            json!({ "v": 1, "id": "es3", "op": "models.enabledSet", "args": {
                "cwd": project.to_string_lossy(), "op": "clear",
            }}),
        );
        assert_eq!(shadowed["ok"], false, "{shadowed}");
        assert_eq!(shadowed["error"]["reason"], "project-scope", "{shadowed}");
        let scoped = send(
            &state,
            json!({ "v": 1, "id": "eg2", "op": "models.enabledGet", "args": { "cwd": project.to_string_lossy() } }),
        );
        assert_eq!(scoped["data"]["scope"], "project", "{scoped}");
        assert_eq!(scoped["data"]["editable"], false, "{scoped}");

        state.management.shutdown_all(std::time::Duration::from_secs(5));
    }

    #[test]
    fn terminal_roundtrip_over_the_dispatch_table() {
        let state = state();
        let dir = tempfile::tempdir().unwrap();
        state.propose_path(dir.path());
        let cwd = dir.path().to_str().unwrap();
        let create = send(
            &state,
            json!({ "v": 1, "id": "t1", "op": "terminal.create", "args": { "id": "term-1", "cwd": cwd, "cols": 80, "rows": 24 } }),
        );
        assert_eq!(create["ok"], true, "{create}");
        // Idempotent create: the same id answers again (the running PTY).
        let again = send(
            &state,
            json!({ "v": 1, "id": "t2", "op": "terminal.create", "args": { "id": "term-1", "cwd": cwd } }),
        );
        assert_eq!(again["ok"], true);

        // Input must be base64; a closed terminal refuses input explicitly.
        let write = send(
            &state,
            json!({ "v": 1, "id": "t3", "op": "terminal.write", "args": { "id": "term-1", "input": "ZWNobyBwaV9pcGMK" } }),
        );
        assert_eq!(write["ok"], true, "{write}");
        let bad = send(
            &state,
            json!({ "v": 1, "id": "t4", "op": "terminal.write", "args": { "id": "term-1", "input": "not base64!!" } }),
        );
        assert_eq!(bad["error"]["code"], "invalid_args");
        let missing = send(
            &state,
            json!({ "v": 1, "id": "t5", "op": "terminal.write", "args": { "id": "ghost", "input": "eA==" } }),
        );
        assert_eq!(missing["error"]["code"], "not_found");

        // The read surface answers (the shell echoed our line).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let read = loop {
            let read = send(
                &state,
                json!({ "v": 1, "id": "t6", "op": "terminal.read", "args": { "id": "term-1", "cursor": 0 } }),
            );
            let output = read["data"]["output"].as_str().unwrap_or("");
            if output.contains("pi_ipc") || std::time::Instant::now() > deadline {
                break read;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        assert_eq!(read["ok"], true);
        assert!(
            read["data"]["output"].as_str().unwrap_or("").contains("pi_ipc"),
            "the terminal echoed: {read}"
        );

        // Missing ids and unknown terminal ops stay refused.
        let close = send(
            &state,
            json!({ "v": 1, "id": "t7", "op": "terminal.close", "args": { "id": "term-1" } }),
        );
        assert_eq!(close["ok"], true);
        let closed = send(
            &state,
            json!({ "v": 1, "id": "t8", "op": "terminal.read", "args": { "id": "term-1", "cursor": 0 } }),
        );
        assert_eq!(closed["error"]["code"], "not_found", "a closed terminal is gone: {closed}");
    }

    #[test]
    fn session_ops_on_missing_sessions_are_not_found() {
        let state = state();
        // Deterministic without a staged pi: no spawn config, no children.
        *state.spawn_base.lock().unwrap() = None;
        let response = send(
            &state,
            json!({ "v": 1, "id": "r6", "op": "agent.interrupt", "args": { "session": "ghost" } }),
        );
        assert_eq!(response["error"]["code"], "not_found");
        let response = send(
            &state,
            json!({ "v": 1, "id": "r7", "op": "sessions.runState", "args": { "session": "ghost" } }),
        );
        assert_eq!(response["ok"], true, "runState answers not-running for ghosts");
        assert_eq!(response["data"]["running"], false);
    }

    #[test]
    fn state_mirror_reads_writes_backups_and_rejects_stale_revisions() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());

        // Missing mirror: an explicit missing report, never an invented one.
        let read = send(&state, json!({ "v": 1, "id": "sm1", "op": "desktop.stateMirror" }));
        assert_eq!(read["data"]["missing"], true, "{read}");

        // A write lands under the agent dir with the revision echoed.
        let write = send(
            &state,
            json!({ "v": 1, "id": "sm2", "op": "desktop.writeStateMirror", "args": { "payload": {
                "schemaVersion": 1, "revision": 4, "exportedAt": "2026-01-01T00:00:00.000Z",
                "source": "t", "checksum": "x", "entries": { "pi-theme": "dark" }
            } } }),
        );
        assert_eq!(write["data"]["revision"], 4, "{write}");
        let file = dir.path().join("desktop-state-mirror.json");
        assert!(file.is_file(), "under the agent dir directly");

        // The read returns the written payload.
        let read = send(&state, json!({ "v": 1, "id": "sm3", "op": "desktop.stateMirror" }));
        assert_eq!(read["data"]["revision"], 4);
        assert_eq!(read["data"]["entries"]["pi-theme"], "dark");

        // A stale revision is refused (the 409 shape).
        let stale = send(
            &state,
            json!({ "v": 1, "id": "sm4", "op": "desktop.writeStateMirror", "args": { "payload": {
                "schemaVersion": 1, "revision": 4, "exportedAt": "2026-01-01T00:00:00.000Z",
                "source": "t", "checksum": "x", "entries": {}
            } } }),
        );
        assert_eq!(stale["error"]["code"], "invalid_args");

        // A newer write keeps the previous payload as the backup.
        let write = send(
            &state,
            json!({ "v": 1, "id": "sm5", "op": "desktop.writeStateMirror", "args": { "payload": {
                "schemaVersion": 1, "revision": 5, "exportedAt": "2026-01-02T00:00:00.000Z",
                "source": "t", "checksum": "y", "entries": { "pi-theme": "light" }
            } } }),
        );
        assert_eq!(write["data"]["revision"], 5);
        let backup: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("desktop-state-mirror.json.bak")).expect("backup"),
        )
        .expect("backup JSON");
        assert_eq!(backup["revision"], 4, "the backup holds the previous payload");
        // The mirror file itself is private on POSIX.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "private");
        }
        // A malformed payload is refused.
        let malformed = send(
            &state,
            json!({ "v": 1, "id": "sm6", "op": "desktop.writeStateMirror", "args": { "payload": { "revision": 9 } } }),
        );
        assert_eq!(malformed["error"]["code"], "invalid_args");
    }

    #[test]
    fn test_font_ops_ipc() {
        let state = IpcHostState::new();
        let dir = tempfile::tempdir().expect("tempdir");
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());

        // 1. Initial read when settings file doesn't exist returns null
        let read1 = send(
            &state,
            json!({ "v": 1, "id": "f1", "op": "appearance.fontsGet" }),
        );
        assert_eq!(read1["ok"], true);
        assert_eq!(read1["data"]["fonts"], Value::Null);

        // 2. Setting invalid fonts fails with invalid_args
        let bad = send(
            &state,
            json!({ "v": 1, "id": "f2", "op": "appearance.fontsSet", "args": { "fonts": { "ui": "bad; color:red", "mono": "Consolas" } } }),
        );
        assert_eq!(bad["ok"], false);
        assert_eq!(bad["error"]["code"], "invalid_args");

        // 3. Setting missing fonts payload fails with invalid_args
        let missing = send(
            &state,
            json!({ "v": 1, "id": "f3", "op": "appearance.fontsSet", "args": {} }),
        );
        assert_eq!(missing["ok"], false);
        assert_eq!(missing["error"]["code"], "invalid_args");

        // 4. Setting valid fonts succeeds and echoes
        let set = send(
            &state,
            json!({ "v": 1, "id": "f4", "op": "appearance.fontsSet", "args": { "fonts": { "ui": "Microsoft YaHei", "mono": "Consolas" } } }),
        );
        assert_eq!(set["ok"], true);
        assert_eq!(set["data"]["fonts"]["ui"], "Microsoft YaHei");
        assert_eq!(set["data"]["fonts"]["mono"], "Consolas");

        // 5. Subsequent read returns the saved fonts
        let read2 = send(
            &state,
            json!({ "v": 1, "id": "f5", "op": "appearance.fontsGet" }),
        );
        assert_eq!(read2["ok"], true);
        assert_eq!(read2["data"]["fonts"]["ui"], "Microsoft YaHei");
        assert_eq!(read2["data"]["fonts"]["mono"], "Consolas");

        // 6. desktop.fonts returns array of fonts on supported platform
        #[cfg(target_os = "linux")]
        {
            let fonts = send(
                &state,
                json!({ "v": 1, "id": "f6", "op": "desktop.fonts" }),
            );
            if fonts["ok"] == true {
                assert!(fonts["data"]["fonts"].as_array().is_some());
            }
        }
    }

    #[test]
    fn the_first_prompt_error_trichotomy_never_marks_an_unknown_outcome_rejected() {
        // Only a child that ANSWERED its refusal (or never spawned) is
        // `prompt_rejected accepted:false` — the composer's restore-draft
        // signal. A timeout, a lost transport or an exit leaves the outcome
        // UNKNOWN: no accepted:false, and the session identity rides along.
        let refused = classify_first_prompt_error(
            &pi_host::PiRpcError::command("message is empty"),
            "s-1",
        );
        assert_eq!(refused.0, "op_failed");
        assert_eq!(refused.2.as_ref().unwrap()["code"], "prompt_rejected");
        assert_eq!(refused.2.as_ref().unwrap()["accepted"], false);

        let never_spawned = classify_first_prompt_error(
            &pi_host::PiRpcError::spawn("ENOENT"),
            "s-1",
        );
        assert_eq!(never_spawned.0, "agent_spawn_failed");
        assert_eq!(never_spawned.2.as_ref().unwrap()["accepted"], false);

        for unknown in [
            pi_host::PiRpcError::timeout("timed out after 120000 ms"),
            pi_host::PiRpcError::exit("pi process exited"),
            pi_host::PiRpcError::closing("shutdown began"),
        ] {
            let (code, message, details) = classify_first_prompt_error(&unknown, "s-42");
            assert_eq!(code, "prompt_unknown", "an unknown outcome is never a rejection");
            assert!(message.contains("unknown"), "the message states the ambiguity: {message}");
            let details = details.expect("the unknown case carries details");
            assert_eq!(details["code"], "prompt_unknown");
            assert_ne!(details["accepted"], false, "accepted:false would invite a resend");
            assert_eq!(details["sessionId"], "s-42", "the session identity for a state query");
        }
    }

    #[test]
    fn a_persisted_unlock_marker_is_honoured_only_for_a_folder_chat() {
        // The Next factory's gate (rpc-manager): chatFolder && marker. A
        // LEGACY shared-workspace session file that carries the marker keeps
        // the locked loadout — a persisted input must not widen its rights.
        // Gated like the other plan tests: the chat prompt rides the
        // management instance (a real pi child on the staged managed tree).
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        let managed = stage_managed_tree(dir.path());
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable: executable.clone(),
            agent_dir: Some(agent_dir.clone()),
            extensions: vec![
                std::path::Path::new("../lib/pi-rpc/assets/pi-web-management.mjs")
                    .canonicalize()
                    .expect("management asset"),
            ],
            env: vec![(
                "PI_WEB_MANAGED_MODULES".to_string(),
                managed.display().to_string(),
            )],
        });
        let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
            .canonicalize()
            .expect("bridge asset");
        *state.spawn_base.lock().unwrap() = Some(spawn_base(&executable, bridge));

        // The unlock marker in pi's custom-entry shape (both files below).
        let marker = format!(
            "{}\n{}\n",
            r#"{"type":"session","version":3,"id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}"#,
            r#"{"type":"custom","customType":"pi-web:chat-unlock","id":"u1","parentId":null,"data":{"version":1,"unlocked":true}}"#,
        );

        let request = SpawnRequest::default();
        let base = state.spawn_base.lock().unwrap().clone().expect("base");

        // 1. A FOLDER chat (a child of <agent_dir>/chats) with the marker: unlocked.
        let folder_cwd = agent_dir.join("chats").join("20260101_120000_abcd");
        std::fs::create_dir_all(&folder_cwd).expect("folder");
        let folder_file = dir.path().join("folder.jsonl");
        std::fs::write(&folder_file, &marker).expect("write");
        let plan = build_spawn_plan(&state, &base, &folder_cwd, &folder_file, &request, false)
            .expect("the folder chat plan");
        match plan.shape {
            session_host::SessionSpawnShape::Chat { unlocked, .. } => {
                assert!(unlocked, "a folder chat's persisted unlock is honoured");
            }
            _ => panic!("a chat shape, not another kind"),
        }

        // 2. The LEGACY shared workspace with the same marker: still locked.
        let legacy_cwd = agent_dir.join("chat-workspace");
        std::fs::create_dir_all(&legacy_cwd).expect("legacy cwd");
        let legacy_file = dir.path().join("legacy.jsonl");
        std::fs::write(&legacy_file, &marker).expect("write");
        let plan = build_spawn_plan(&state, &base, &legacy_cwd, &legacy_file, &request, false)
            .expect("the legacy chat plan");
        match plan.shape {
            session_host::SessionSpawnShape::Chat { unlocked, folder, .. } => {
                assert!(!folder, "the legacy cwd is not a folder chat");
                assert!(!unlocked, "a legacy chat's persisted unlock marker is IGNORED (the locked loadout stays)");
            }
            _ => panic!("a chat shape, not another kind"),
        }
    }
    /// A Channel that records every frame it is sent (the relay's own
    /// serialization path: InvokeResponseBody::Json).
    fn recording_channel() -> (Channel<Value>, Arc<Mutex<Vec<Value>>>) {
        let frames: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&frames);
        let channel = Channel::new(move |message| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = message {
                if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                    sink.lock().unwrap().push(frame);
                }
            }
            Ok(())
        });
        (channel, frames)
    }

    /// Poll until the recorder holds at least `count` frames (bounded).
    fn wait_for_frames(frames: &Arc<Mutex<Vec<Value>>>, count: usize, limit: Duration) -> bool {
        let deadline = std::time::Instant::now() + limit;
        while std::time::Instant::now() < deadline {
            if frames.lock().unwrap().len() >= count {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        frames.lock().unwrap().len() >= count
    }

    fn unsubscribe_running(state: &IpcHostState, subscription_id: &str) -> Value {
        send(
            state,
            json!({ "v": 1, "id": format!("u-{subscription_id}"), "op": "agent.unsubscribeEvents", "args": { "subscriptionId": subscription_id } }),
        )
    }

    #[test]
    fn subscribe_running_first_frame_is_the_observation_at_subscribe_time() {
        let state = state();
        let (channel, frames) = recording_channel();
        let ack = subscribe_running(&state, channel, Duration::from_secs(60));
        let subscription_id = ack["subscriptionId"].as_str().expect("subscriptionId").to_string();
        assert!(
            wait_for_frames(&frames, 1, Duration::from_secs(5)),
            "the first frame arrives immediately: {:?}",
            frames.lock().unwrap()
        );
        let frame = frames.lock().unwrap()[0].clone();
        assert_eq!(frame["subscriptionId"], json!(subscription_id));
        assert_eq!(frame["kind"], "snapshot");
        assert_eq!(frame["seq"], 1);
        assert_eq!(frame["epoch"], 1);
        assert_eq!(frame["payload"]["type"], "running");
        assert_eq!(frame["payload"]["runningSessionIds"], json!([]));
        assert_eq!(
            frame["payload"]["sessionListVersion"],
            json!(state.session_list_version()),
            "the version beside the (empty) set"
        );
        let done = unsubscribe_running(&state, &subscription_id);
        assert_eq!(done["ok"], true, "{done}");
    }

    #[test]
    fn subscribe_running_emits_one_frame_per_change_and_nothing_between() {
        let state = state();
        let (channel, frames) = recording_channel();
        let ack = subscribe_running(&state, channel, Duration::from_secs(60));
        let subscription_id = ack["subscriptionId"].as_str().expect("subscriptionId").to_string();
        assert!(wait_for_frames(&frames, 1, Duration::from_secs(5)));
        // A quiet observation sends NOTHING: two full derive cadences pass
        // without a second frame.
        std::thread::sleep(Duration::from_millis(2_400));
        assert_eq!(
            frames.lock().unwrap().len(),
            1,
            "an unchanged observation is not re-emitted: {:?}",
            frames.lock().unwrap()
        );
        // A catalogue-version change alone IS a change (the sidebar's
        // cross-window staleness contract).
        bump_session_list_version(&state);
        assert!(
            wait_for_frames(&frames, 2, Duration::from_secs(5)),
            "the version change lands within the cadence: {:?}",
            frames.lock().unwrap()
        );
        let frames_now = frames.lock().unwrap();
        let second = frames_now[1].clone();
        assert_eq!(second["kind"], "event");
        assert_eq!(second["seq"], 2);
        assert_eq!(second["payload"]["runningSessionIds"], json!([]));
        assert_eq!(second["payload"]["sessionListVersion"], json!(state.session_list_version()));
        drop(frames_now);
        let done = unsubscribe_running(&state, &subscription_id);
        assert_eq!(done["ok"], true, "{done}");
    }

    #[test]
    fn subscribe_running_probe_resends_a_quiet_observation() {
        // The probe is how a DEAD channel gets detected on a quiet stream
        // (a page reload never unsubscribes): without it the relay would
        // sleep forever holding its registry entry.
        let state = state();
        let (channel, frames) = recording_channel();
        let ack = subscribe_running(&state, channel, Duration::from_millis(1_200));
        let subscription_id = ack["subscriptionId"].as_str().expect("subscriptionId").to_string();
        assert!(wait_for_frames(&frames, 1, Duration::from_secs(5)));
        assert!(
            wait_for_frames(&frames, 2, Duration::from_secs(5)),
            "the probe re-sends the quiet observation: {:?}",
            frames.lock().unwrap()
        );
        let frames_now = frames.lock().unwrap();
        assert_eq!(frames_now[1]["payload"], frames_now[0]["payload"], "identical observation re-sent");
        assert_eq!(frames_now[1]["seq"], 2);
        assert_eq!(frames_now[1]["kind"], "event");
        drop(frames_now);
        let done = unsubscribe_running(&state, &subscription_id);
        assert_eq!(done["ok"], true, "{done}");
    }

    #[test]
    fn subscribe_running_channel_death_detaches_the_relay() {
        let state = state();
        // The channel accepts the FIRST send and fails every later one
        // (the WebView went away between two frames).
        let sends = Arc::new(Mutex::new(0usize));
        let counter = Arc::clone(&sends);
        let channel = Channel::new(move |_| {
            let mut count = counter.lock().unwrap();
            *count += 1;
            if *count == 1 {
                Ok(())
            } else {
                Err(tauri::Error::Io(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "channel closed",
                )))
            }
        });
        // A short probe forces the second send without touching the state.
        let ack = subscribe_running(&state, channel, Duration::from_millis(1_200));
        let subscription_id = ack["subscriptionId"].as_str().expect("subscriptionId").to_string();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while state.event_relays.lock().unwrap().contains_key(&subscription_id)
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !state.event_relays.lock().unwrap().contains_key(&subscription_id),
            "the dead channel's relay detached (no leaked entry)"
        );
        // The entry is gone: a late unsubscribe answers not_found instead of
        // leaking a second handle.
        let late = unsubscribe_running(&state, &subscription_id);
        assert_eq!(late["error"]["code"], "not_found", "{late}");
    }

    #[test]
    fn subscribe_running_unsubscribe_ends_the_relay_and_frees_the_entry() {
        let state = state();
        let (channel, frames) = recording_channel();
        let ack = subscribe_running(&state, channel, Duration::from_secs(60));
        let subscription_id = ack["subscriptionId"].as_str().expect("subscriptionId").to_string();
        assert!(wait_for_frames(&frames, 1, Duration::from_secs(5)));
        let delivered = frames.lock().unwrap().len();
        // The relay must be stoppable with a PENDING change behind it: after
        // the unsubscribe, a version bump (which would otherwise notify the
        // relay to send) must NOT be delivered — the stop flag wins over the
        // change. The bump comes AFTER the unsubscribe so the interleaving
        // is deterministic under the event-driven relay (a bump that raced
        // the unsubscribe could wake the relay first and lawfully send).
        let done = unsubscribe_running(&state, &subscription_id);
        assert_eq!(done["ok"], true, "{done}");
        assert!(!state.event_relays.lock().unwrap().contains_key(&subscription_id));
        bump_session_list_version(&state);
        std::thread::sleep(Duration::from_millis(2_400));
        assert_eq!(
            frames.lock().unwrap().len(),
            delivered,
            "no frames after unsubscribe: {:?}",
            frames.lock().unwrap()
        );
        // The second unsubscribe answers not_found (idempotent cleanup).
        let again = unsubscribe_running(&state, &subscription_id);
        assert_eq!(again["error"]["code"], "not_found", "{again}");
    }

    /// A Channel that records every frame AND blocks inside send #`block_at`
    /// (1-based) until released — the deterministic seam for holding the
    /// relay mid-send, exactly the interleavings the replay (P2-1) and
    /// cancel (P2-2) contracts cover. Sends before/after `block_at` pass
    /// and are recorded.
    struct GatedChannel {
        channel: Channel<Value>,
        frames: Arc<Mutex<Vec<Value>>>,
        sends_entered: Arc<AtomicU64>,
        gate: Arc<(Mutex<bool>, std::sync::Condvar)>,
    }

    fn gated_channel(block_at: u64) -> GatedChannel {
        let frames: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sends_entered = Arc::new(AtomicU64::new(0));
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let sink = Arc::clone(&frames);
        let counter = Arc::clone(&sends_entered);
        let block = Arc::clone(&gate);
        let channel = Channel::new(move |message| {
            let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
            if n == block_at {
                let (lock, cv) = &*block;
                let mut open = lock.lock().unwrap();
                while !*open {
                    open = cv.wait(open).unwrap();
                }
            }
            if let tauri::ipc::InvokeResponseBody::Json(text) = message {
                if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                    sink.lock().unwrap().push(frame);
                }
            }
            Ok(())
        });
        GatedChannel { channel, frames, sends_entered, gate }
    }

    impl GatedChannel {
        /// Unblock the gated send (stays open for later sends).
        fn open(&self) {
            let (lock, cv) = &*self.gate;
            *lock.lock().unwrap() = true;
            cv.notify_all();
        }

        /// Wait until at least `n` sends have ENTERED the channel closure
        /// (bounded): send #n has begun on the relay thread — if it is the
        /// gated one, the relay is deterministically mid-send.
        fn wait_sends(&self, n: u64, limit: Duration) -> bool {
            let deadline = std::time::Instant::now() + limit;
            while std::time::Instant::now() < deadline {
                if self.sends_entered.load(Ordering::SeqCst) >= n {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            self.sends_entered.load(Ordering::SeqCst) >= n
        }
    }

    /// Wait until the running-relay THREAD count falls back to `baseline`
    /// (bounded) — the thread-lifetime truth (P2-2): a relay that ignored
    /// its stop flag keeps this count up even after its map entry is gone.
    fn wait_for_relay_threads(state: &IpcHostState, baseline: usize, limit: Duration) -> bool {
        let deadline = std::time::Instant::now() + limit;
        while std::time::Instant::now() < deadline {
            if state.running_relay_threads.load(Ordering::SeqCst) <= baseline {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        state.running_relay_threads.load(Ordering::SeqCst) <= baseline
    }

    /// Terra P2-1: a run that starts AND settles while the relay is blocked
    /// in a frame send must still be OBSERVABLE. The relay replays the
    /// recorded transitions transition-by-transition (intermediate sets
    /// synthesized from the last-sent set), so both the start `[s1]` and the
    /// settle `[]` reach the client — an epoch-only relay wakes to an
    /// unchanged net set and delivers NOTHING (verified by reverting the
    /// replay: the wait for frame 3 fails).
    #[test]
    fn a_short_run_that_settled_while_a_send_was_blocked_is_replayed() {
        let state = state();
        let gated = gated_channel(1);
        let ack = subscribe_running(&state, gated.channel.clone(), Duration::from_secs(60));
        let subscription_id = ack["subscriptionId"].as_str().expect("subscriptionId").to_string();
        // The relay is now deterministically stuck INSIDE its first send.
        assert!(
            gated.wait_sends(1, Duration::from_secs(5)),
            "the first send entered the gate"
        );
        // The run starts and settles while nobody can deliver. No real
        // session is needed: the replay synthesizes from the RECORDED
        // transitions, not the registry (which still lists nothing).
        let signal = state.registry.running_signal();
        signal.notify_transition("s1", true);
        signal.notify_transition("s1", false);
        gated.open();
        assert!(
            wait_for_frames(&gated.frames, 3, Duration::from_secs(5)),
            "initial + BOTH transitions: {:?}",
            gated.frames.lock().unwrap()
        );
        let frames = gated.frames.lock().unwrap().clone();
        assert_eq!(frames[0]["payload"]["runningSessionIds"], json!([]), "the initial snapshot");
        assert_eq!(
            frames[1]["payload"]["runningSessionIds"],
            json!(["s1"]),
            "the START is observable: {:?}",
            frames[1]
        );
        assert_eq!(
            frames[2]["payload"]["runningSessionIds"],
            json!([]),
            "the SETTLE is observable: {:?}",
            frames[2]
        );
        // The net derivation after the replay equals the last replayed set:
        // no fourth frame.
        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(
            gated.frames.lock().unwrap().len(),
            3,
            "no frame beyond the replay: {:?}",
            gated.frames.lock().unwrap()
        );
        let done = unsubscribe_running(&state, &subscription_id);
        assert_eq!(done["ok"], true, "{done}");
        assert!(wait_for_relay_threads(&state, 0, Duration::from_secs(3)));
    }

    /// The bounded half of P2-1: a burst LONGER than the replay ring is
    /// never answered with an unbounded frame burst. The dropped head makes
    /// the intermediate sets unrecoverable — the relay must send exactly
    /// ONE forced resync frame (the current net set) instead of replaying.
    #[test]
    fn a_ring_gap_forces_one_resync_frame_instead_of_replaying_the_burst() {
        let state = state();
        let gated = gated_channel(1);
        let ack = subscribe_running(&state, gated.channel.clone(), Duration::from_secs(60));
        let subscription_id = ack["subscriptionId"].as_str().expect("subscriptionId").to_string();
        assert!(gated.wait_sends(1, Duration::from_secs(5)));
        // 600 recorded transitions overflow the 512-entry ring.
        let signal = state.registry.running_signal();
        for n in 0..600 {
            signal.notify_transition(&format!("s{n}"), true);
        }
        gated.open();
        assert!(
            wait_for_frames(&gated.frames, 2, Duration::from_secs(5)),
            "initial + ONE forced resync frame: {:?}",
            gated.frames.lock().unwrap()
        );
        std::thread::sleep(Duration::from_millis(700));
        let frames = gated.frames.lock().unwrap();
        assert_eq!(
            frames.len(),
            2,
            "no per-transition replay after a gap (bounded): {:?}",
            frames
        );
        assert_eq!(frames[0]["payload"]["runningSessionIds"], json!([]));
        assert_eq!(
            frames[1]["payload"]["runningSessionIds"],
            json!([]),
            "the resync frame is the current net observation (the fabricated sessions never existed): {:?}",
            frames[1]
        );
        drop(frames);
        let done = unsubscribe_running(&state, &subscription_id);
        assert_eq!(done["ok"], true, "{done}");
        assert!(wait_for_relay_threads(&state, 0, Duration::from_secs(3)));
    }

    /// Terra P2-2 (a): a QUIET unsubscribe must end the relay THREAD at
    /// once. The probe here is 60 s — without the unsubscribe wake the
    /// thread sits in wait_for_change for the whole probe (the old
    /// behavior). The liveness COUNT, not the registry entry (which the
    /// handler clears itself), is the proof the thread really finished.
    #[test]
    fn unsubscribing_a_quiet_running_relay_ends_its_thread_at_once() {
        let state = state();
        let baseline = state.running_relay_threads.load(Ordering::SeqCst);
        let (channel, frames) = recording_channel();
        let ack = subscribe_running(&state, channel, Duration::from_secs(60));
        let subscription_id = ack["subscriptionId"].as_str().expect("subscriptionId").to_string();
        assert!(wait_for_frames(&frames, 1, Duration::from_secs(5)));
        assert_eq!(
            state.running_relay_threads.load(Ordering::SeqCst),
            baseline + 1,
            "the relay thread is alive"
        );
        let done = unsubscribe_running(&state, &subscription_id);
        assert_eq!(done["ok"], true, "{done}");
        assert!(
            wait_for_relay_threads(&state, baseline, Duration::from_secs(3)),
            "the relay thread ended within 3 s of a quiet unsubscribe (its probe is 60 s): count = {}",
            state.running_relay_threads.load(Ordering::SeqCst)
        );
    }

    /// Terra P2-2 (b): the cancel contract with frames IN FLIGHT. The relay
    /// is deterministically mid-send (send #2 — the first replay frame of a
    /// five-transition burst) when the unsubscribe lands: the in-flight
    /// frame completes, at most ONE more frame may leave, then silence, the
    /// entry is gone and the thread ends — the between-frames stop check is
    /// what bounds the multi-frame replay under a cancel.
    #[test]
    fn unsubscribing_with_replay_pending_delivers_at_most_one_more_frame() {
        let state = state();
        let gated = gated_channel(2);
        let ack = subscribe_running(&state, gated.channel.clone(), Duration::from_secs(60));
        let subscription_id = ack["subscriptionId"].as_str().expect("subscriptionId").to_string();
        // Frame 1 (the initial snapshot) passes the gate untouched.
        assert!(wait_for_frames(&gated.frames, 1, Duration::from_secs(5)));
        // Five transitions pile up behind the quiet relay.
        let signal = state.registry.running_signal();
        for n in 0..5 {
            signal.notify_transition(&format!("s{n}"), true);
        }
        // The relay wakes and enters send #2 (its first replay frame) —
        // which the gate holds open.
        assert!(
            gated.wait_sends(2, Duration::from_secs(5)),
            "the relay is mid-send on its first replay frame"
        );
        // The cancel lands while that frame is in flight.
        let done = unsubscribe_running(&state, &subscription_id);
        assert_eq!(done["ok"], true, "{done}");
        gated.open();
        // The in-flight frame completes (frame 2). At most ONE more frame
        // may leave after the unsubscribe — here the between-frames stop
        // check must end the relay before frames 3..6.
        assert!(wait_for_frames(&gated.frames, 2, Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(800));
        let frames = gated.frames.lock().unwrap();
        assert!(
            frames.len() <= 2,
            "at most one frame after the unsubscribe (the in-flight one), got {}: {:?}",
            frames.len(),
            frames
        );
        drop(frames);
        assert!(!state.event_relays.lock().unwrap().contains_key(&subscription_id));
        assert!(wait_for_relay_threads(&state, 0, Duration::from_secs(3)));
        let again = unsubscribe_running(&state, &subscription_id);
        assert_eq!(again["error"]["code"], "not_found", "{again}");
    }


    /// The tool picker over the REAL bridge (PI_CLI_BIN, sandboxed): the
    /// child's authoritative registry lists with active flags, and setting
    /// the active set round-trips.
    #[test]
    fn real_pi_agent_get_tools_and_set_tools_over_the_bridge() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
            .canonicalize()
            .expect("the shipped bridge asset resolves");
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let sessions = agent_dir.join("sessions").join("proj");
        let cwd = dir.path().join("work");
        std::fs::create_dir_all(&sessions).expect("sessions");
        std::fs::create_dir_all(&cwd).expect("cwd");
        let (_file, file_id) = session_host::create_session_file(&sessions, &cwd).expect("create");

        let state = state();
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        *state.spawn_base.lock().unwrap() = Some(spawn_base(&executable, bridge));

        let tools = send(
            &state,
            json!({ "v": 1, "id": "gt1", "op": "agent.getTools", "args": { "session": file_id } }),
        );
        assert_eq!(tools["ok"], true, "the bridge answers the tool registry: {tools}");
        let list = tools["data"].as_array().expect("a plain ToolEntry array (the wrapper's get_tools shape)");
        assert!(!list.is_empty(), "the child has a tool registry");
        // Every entry carries the ToolEntry projection (name + active flag).
        for tool in list {
            assert!(tool.get("name").is_some(), "an entry without a name: {tool}");
            assert!(tool.get("active").is_some(), "an entry without an active flag: {tool}");
            // Hidden tools never list (withdrawn).
            assert_ne!(tool.get("exposure").and_then(Value::as_str), Some("hidden"));
        }
        // The built-in read tool exists and reports a boolean active state.
        let read = list
            .iter()
            .find(|tool| tool.get("name").and_then(Value::as_str) == Some("read"))
            .expect("the built-in read tool lists");
        assert!(read["active"].is_boolean());

        // Setting the active set round-trips through the bridge: the names
        // that reported active.
        let active_names: Vec<String> = list
            .iter()
            .filter(|tool| tool.get("active").and_then(Value::as_bool) == Some(true))
            .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string))
            .collect();
        let set = send(
            &state,
            json!({ "v": 1, "id": "gt2", "op": "agent.setTools", "args": {
                "session": file_id, "names": if active_names.is_empty() { vec!["read".to_string()] } else { active_names }
            } }),
        );
        assert_eq!(set["ok"], true, "tools.set applies: {set}");

        state.registry.remove(&file_id, std::time::Duration::from_secs(5));
    }

    /// The resume flow with the REAL pi child (PI_CLI_BIN, sandboxed): an
    /// agent op on an on-disk session cold-starts its child — the POST
    /// /api/agent/[id] contract (startRpcSession on demand).
    #[test]
    fn real_pi_agent_op_cold_starts_an_on_disk_session() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
            .canonicalize()
            .expect("the shipped bridge asset resolves");
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let sessions = agent_dir.join("sessions").join("proj");
        let cwd = dir.path().join("work");
        std::fs::create_dir_all(&sessions).expect("sessions");
        std::fs::create_dir_all(&cwd).expect("cwd");
        // One on-disk session file with a real header.
        let (_file, file_id) = session_host::create_session_file(&sessions, &cwd).expect("create");

        let state = state();
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        *state.spawn_base.lock().unwrap() = Some(spawn_base(&executable, bridge));

        // A command on the not-yet-running session RESUMES it: the child
        // spawns, handshakes and answers get_state.
        let response = send(
            &state,
            json!({ "v": 1, "id": "cold1", "op": "agent.command", "args": { "session": file_id, "type": "get_state" } }),
        );
        assert_eq!(response["ok"], true, "the on-disk session cold-started: {response}");
        assert_eq!(response["data"]["sessionId"], file_id.as_str());
        // The registry holds it now.
        assert_eq!(state.registry.ids(), vec![file_id.clone()]);
        // A second command reuses the SAME child (no second spawn).
        let again = send(
            &state,
            json!({ "v": 1, "id": "cold2", "op": "agent.command", "args": { "session": file_id, "type": "get_state" } }),
        );
        assert_eq!(again["ok"], true, "{again}");
        // Cleanup: shut the child down.
        state.registry.remove(&file_id, std::time::Duration::from_secs(5));
    }

    /// Terra round-4 (the reviewer's requirement): a RELATIVE cwd must reach
    /// the same absolute identity the absolute form does — BEFORE
    /// classification — so a relative path that points at the chat root, a
    /// chat folder or the legacy chat cwd still spawns a CHAT (and a
    /// relative project path still spawns a project). Verified through the
    /// FINAL SPAWN SHAPE (the child's live tool loadout) and the session
    /// header's cwd, not just `workspace.validateCwd`.
    #[test]
    fn real_pi_create_resolves_a_relative_cwd_before_classification() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
            .canonicalize()
            .expect("the shipped bridge asset resolves");
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let managed = stage_managed_tree(dir.path());
        let state = state();
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        *state.spawn_base.lock().unwrap() = Some(spawn_base(&executable, bridge));
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable: executable.clone(),
            agent_dir: Some(agent_dir.clone()),
            extensions: vec![
                std::path::Path::new("../lib/pi-rpc/assets/pi-web-management.mjs")
                    .canonicalize()
                    .expect("management asset"),
            ],
            env: vec![(
                "PI_WEB_MANAGED_MODULES".to_string(),
                managed.display().to_string(),
            )],
        });

        // A GENUINE relative path: built from the test process's cwd to the
        // target, exactly the form a client would send. The create entry
        // must resolve it against the host's working directory (where the
        // Next server's raw-string cwd effectively landed) and classify on
        // the ABSOLUTE identity.
        let relative_to = |target: &Path| {
            let cwd = std::env::current_dir().expect("the test process has a cwd");
            let cwd_parts: Vec<_> = cwd.components().collect();
            let target_parts: Vec<_> = target.components().collect();
            let mut common = 0;
            while common < cwd_parts.len()
                && common < target_parts.len()
                && cwd_parts[common] == target_parts[common]
            {
                common += 1;
            }
            let mut rel = PathBuf::new();
            for _ in common..cwd_parts.len() {
                rel.push("..");
            }
            for part in &target_parts[common..] {
                rel.push(part.as_os_str());
            }
            rel.to_string_lossy().into_owned()
        };
        let active_tools = |session_id: &str| -> Vec<String> {
            let tools = send(
                &state,
                json!({ "v": 1, "id": "reltools", "op": "agent.getTools", "args": { "session": session_id } }),
            );
            assert_eq!(tools["ok"], true, "{tools}");
            tools["data"]
                .as_array()
                .expect("tools array")
                .iter()
                .filter(|tool| tool["active"] == true)
                .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string))
                .collect()
        };
        let create = |rel: &str| -> Value {
            send(
                &state,
                json!({ "v": 1, "id": "relnew", "op": "agent.create", "args": {
                    "cwd": rel,
                    "type": "ensure_session",
                }}),
            )
        };

        // 1. A relative path pointing at a CHAT FOLDER: the folder shape
        //    (read+write active, no shell) and the header cwd is the folder.
        let folder = crate::session_view::chat_workspace_dir(&agent_dir).join("20260101-120000-abcd");
        std::fs::create_dir_all(&folder).expect("the chat folder exists");
        let created = create(&relative_to(&folder));
        assert_eq!(created["ok"], true, "the folder chat created through a relative cwd: {created}");
        let folder_id = created["data"]["sessionId"].as_str().expect("id").to_string();
        let summary = session_host::history::find_session_by_id(&agent_dir, &folder_id).expect("the file");
        assert_eq!(
            PathBuf::from(&summary.cwd), folder,
            "the session header carries the ABSOLUTE chat folder identity"
        );
        let tools = active_tools(&folder_id);
        assert!(tools.contains(&"read".to_string()) && tools.contains(&"write".to_string()), "a folder chat's loadout: {tools:?}");
        assert!(!tools.contains(&"bash".to_string()), "a locked chat has no shell: {tools:?}");
        state.registry.remove(&folder_id, std::time::Duration::from_secs(5));

        // 2. A relative path pointing at the chat ROOT: the request becomes
        //    a folder of its own (the root itself is never a session cwd).
        let chat_root = crate::session_view::chat_workspace_dir(&agent_dir);
        std::fs::create_dir_all(&chat_root).expect("the chat root");
        let created = create(&relative_to(&chat_root));
        assert_eq!(created["ok"], true, "the root request created a folder chat: {created}");
        let root_id = created["data"]["sessionId"].as_str().expect("id").to_string();
        let summary = session_host::history::find_session_by_id(&agent_dir, &root_id).expect("the file");
        assert!(
            crate::session_view::is_chat_folder_path(Path::new(&summary.cwd), &agent_dir),
            "the root request landed in a NEW folder: {}",
            summary.cwd
        );
        let tools = active_tools(&root_id);
        assert!(tools.contains(&"write".to_string()) && !tools.contains(&"bash".to_string()), "the folder loadout: {tools:?}");
        state.registry.remove(&root_id, std::time::Duration::from_secs(5));

        // 3. A relative path pointing at the LEGACY shared chat cwd: the
        //    legacy shape (read alone — no file tools, no shell).
        let legacy = agent_dir.join("chat-workspace");
        std::fs::create_dir_all(&legacy).expect("the legacy cwd");
        let created = create(&relative_to(&legacy));
        assert_eq!(created["ok"], true, "the legacy chat created: {created}");
        let legacy_id = created["data"]["sessionId"].as_str().expect("id").to_string();
        let summary = session_host::history::find_session_by_id(&agent_dir, &legacy_id).expect("the file");
        assert_eq!(PathBuf::from(&summary.cwd), legacy, "the legacy cwd identity");
        let tools = active_tools(&legacy_id);
        assert!(tools.contains(&"read".to_string()) && !tools.contains(&"write".to_string()) && !tools.contains(&"bash".to_string()), "the legacy loadout is read alone: {tools:?}");
        state.registry.remove(&legacy_id, std::time::Duration::from_secs(5));

        // 4. A relative path pointing at an ordinary PROJECT: the project
        //    shape (the coding domain, shell included).
        let project_cwd = dir.path().join("work");
        std::fs::create_dir_all(&project_cwd).expect("the project cwd");
        let created = create(&relative_to(&project_cwd));
        assert_eq!(created["ok"], true, "the project created through a relative cwd: {created}");
        let project_id = created["data"]["sessionId"].as_str().expect("id").to_string();
        let summary = session_host::history::find_session_by_id(&agent_dir, &project_id).expect("the file");
        assert_eq!(PathBuf::from(&summary.cwd), project_cwd, "the project cwd identity");
        let tools = active_tools(&project_id);
        assert!(tools.contains(&"bash".to_string()), "a project keeps the coding domain: {tools:?}");
        state.registry.remove(&project_id, std::time::Duration::from_secs(5));
    }

    /// The vertical create loop against the REAL pi (PI_CLI_BIN, sandboxed
    /// agent dir + a staged managed tree): POST /api/agent/new's contract —
    /// the ensure_session create for a project (with a persisted tool pin)
    /// and for a chat (the ROOT request becomes a folder of its own), the
    /// startup state answer, and the honest invalid-args rejection.
    #[test]
    fn real_pi_sessions_create_runs_the_factory_contract() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
            .canonicalize()
            .expect("the shipped bridge asset resolves");
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("work");
        std::fs::create_dir_all(&cwd).expect("cwd");
        let managed = stage_managed_tree(dir.path());

        let state = state();
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        *state.spawn_base.lock().unwrap() = Some(spawn_base(&executable, bridge));
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable: executable.clone(),
            agent_dir: Some(agent_dir.clone()),
            extensions: vec![
                std::path::Path::new("../lib/pi-rpc/assets/pi-web-management.mjs")
                    .canonicalize()
                    .expect("management asset"),
            ],
            env: vec![(
                "PI_WEB_MANAGED_MODULES".to_string(),
                managed.display().to_string(),
            )],
        });

        // 1. ensure_session for a PROJECT with a pinned tool selection.
        let created = send(
            &state,
            json!({ "v": 1, "id": "new1", "op": "agent.create", "args": {
                "cwd": cwd.display().to_string(),
                "type": "ensure_session",
                "toolNames": ["read", "bash"],
            }}),
        );
        assert_eq!(created["ok"], true, "the project session created: {created}");
        assert_eq!(created["data"]["success"], true);
        assert_eq!(created["data"]["data"], Value::Null, "ensure_session answers data: null");
        let project_id = created["data"]["sessionId"].as_str().expect("the session id").to_string();
        assert!(!project_id.is_empty());
        // The session file landed in the SDK's encoded dir with the header id.
        let encoded = crate::session_view::default_session_dir(&agent_dir, &cwd);
        let mut file = None;
        for entry in std::fs::read_dir(&encoded).expect("the encoded session dir exists").flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(&format!("_{project_id}.jsonl")) {
                file = Some(entry.path());
            }
        }
        let file = file.expect("the session file carries the header id");
        // The pin persisted BEFORE the child opened the file (the factory's order).
        let pinned = session_host::spawn_plan::read_session_tool_selection(&file);
        assert_eq!(pinned, Some(vec!["read".to_string(), "bash".to_string()]));
        // The child answers get_state (the handshake passed; the model state
        // the route answered came from the child).
        let state_answer = send(
            &state,
            json!({ "v": 1, "id": "new1s", "op": "agent.command", "args": { "session": project_id, "type": "get_state" } }),
        );
        assert_eq!(state_answer["ok"], true, "{state_answer}");
        // The pinned tools applied to the child: read+bash active, the rest
        // of the coding domain not.
        let tools = send(
            &state,
            json!({ "v": 1, "id": "new1t", "op": "agent.getTools", "args": { "session": project_id } }),
        );
        assert_eq!(tools["ok"], true, "{tools}");
        let active: Vec<&str> = tools["data"]
            .as_array()
            .expect("tools array")
            .iter()
            .filter(|tool| tool["active"] == true)
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect();
        assert!(active.contains(&"read"), "the pinned read is active: {active:?}");
        assert!(active.contains(&"bash"), "the pinned bash is active: {active:?}");
        assert!(!active.contains(&"edit"), "an unpinned coding tool is off: {active:?}");
        state.registry.remove(&project_id, std::time::Duration::from_secs(5));

        // 2. ensure_session for a CHAT: the ROOT request becomes a folder of
        // its own under the hidden chat root, and the spawn plan loads the
        // chat prompt through the management instance.
        let chat_root = crate::session_view::chat_workspace_dir(&agent_dir);
        let chat_created = send(
            &state,
            json!({ "v": 1, "id": "new2", "op": "agent.create", "args": {
                "cwd": chat_root.display().to_string(),
                "type": "ensure_session",
                // A chat ignores a stale client tool selection (the policy decides).
                "toolNames": ["bash"],
            }}),
        );
        assert_eq!(chat_created["ok"], true, "the chat session created: {chat_created}");
        let chat_id = chat_created["data"]["sessionId"].as_str().expect("the chat id").to_string();
        // The chat's cwd is a FOLDER under the root (never the root itself).
        let chat_summary = session_host::history::find_session_by_id(&agent_dir, &chat_id).expect("the chat session file");
        let chat_cwd = std::path::PathBuf::from(&chat_summary.cwd);
        assert!(crate::session_view::is_chat_folder_path(&chat_cwd, &agent_dir), "a folder chat: {}", chat_cwd.display());
        // No tool pin persisted for a chat (the request's selection ignored).
        assert_eq!(session_host::spawn_plan::read_session_tool_selection(&chat_summary.file), None);
        // The chat child answers and its loadout is the chat's own: read
        // active, the shell tools withheld.
        let chat_tools = send(
            &state,
            json!({ "v": 1, "id": "new2t", "op": "agent.getTools", "args": { "session": chat_id } }),
        );
        assert_eq!(chat_tools["ok"], true, "{chat_tools}");
        let chat_active: Vec<&str> = chat_tools["data"]
            .as_array()
            .expect("tools array")
            .iter()
            .filter(|tool| tool["active"] == true)
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect();
        assert!(chat_active.contains(&"read"), "a folder chat keeps read: {chat_active:?}");
        assert!(chat_active.contains(&"write"), "a folder chat keeps write: {chat_active:?}");
        assert!(!chat_active.contains(&"bash"), "a locked chat has no shell: {chat_active:?}");
        state.registry.remove(&chat_id, std::time::Duration::from_secs(5));

        // 3. The honest rejection: a cwd that does not exist.
        let missing = send(
            &state,
            json!({ "v": 1, "id": "new3", "op": "agent.create", "args": {
                "cwd": dir.path().join("nope").display().to_string(),
                "type": "ensure_session",
            }}),
        );
        assert_eq!(missing["ok"], false, "{missing}");
        assert_eq!(missing["error"]["code"], "invalid_args");
        assert!(
            missing["error"]["message"].as_str().unwrap_or("").contains("does not exist"),
            "the route's message: {}",
            missing["error"]["message"]
        );
        // A prompt-type create that never reached the child carries the
        // rejection contract (no blind retry).
        let rejected = send(
            &state,
            json!({ "v": 1, "id": "new4", "op": "agent.create", "args": {
                "cwd": dir.path().join("nope").display().to_string(),
                "type": "prompt",
                "message": "hello",
            }}),
        );
        assert_eq!(rejected["error"]["details"]["code"], "prompt_rejected", "{rejected}");
        assert_eq!(rejected["error"]["details"]["accepted"], false);
    }

    /// Terra round-3 P1-1's runtime half: a REAL folder chat (real pi child,
    /// the shipped chat policy asset, the real handshake) must refuse a
    /// `read` that points OUTSIDE its folder — and still serve one INSIDE
    /// it. The "model" is a fixture provider that answers with a
    /// deterministic `tool_calls` delta: the attack is not prompt-driven
    /// (naming the path in the user's message would legitimately GRANT it),
    /// it is the tool call itself, which only the policy hook can stop.
    #[test]
    fn real_pi_folder_chat_blocks_an_out_of_folder_read_and_serves_one_inside() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        // The secret OUTSIDE every chat folder, created before the provider
        // starts so its absolute path is fixed for the attack round.
        let outside_dir = tempfile::tempdir().expect("tempdir");
        let secret = outside_dir.path().join("secret.txt");
        std::fs::write(&secret, "SECRET-CONTENT-NEVER-IN-A-CHAT-9f3c1a").expect("secret");
        let secret_path = secret.display().to_string();
        let secret_json = serde_json::to_string(&json!({ "path": secret_path })).expect("arguments json");

        // The fixture provider: a request whose body carries the round's
        // marker answers a deterministic `read` tool_call (OUTSIDE-ATTACK →
        // the secret outside the folder, INSIDE-CONTROL → a RELATIVE path
        // inside it); the rounds after a tool result answer plain text. The
        // attack is the tool call itself, never the prompt (naming a path in
        // the user's own message would legitimately GRANT it).
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let endpoint = listener.local_addr().expect("addr");
        let secret_json_for_thread = secret_json.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let secret_json = secret_json_for_thread.clone();
                std::thread::spawn(move || {
                    use std::io::{BufRead, BufReader, Read, Write};
                    let sse_chunk = |payload: &Value| -> String {
                        serde_json::to_string(payload).expect("chunk json")
                    };
                    let tool_call_chunk = |call_id: &str, arguments: &str| -> String {
                        // OpenAI's function.arguments is a JSON STRING that
                        // PARSES to the argument object — the raw text goes
                        // on the wire once, never re-stringified (double
                        // encoding makes pi reject the arguments as
                        // "must be a JSON object").
                        sse_chunk(&json!({
                            "choices": [{ "delta": { "tool_calls": [{
                                "index": 0, "id": call_id, "type": "function",
                                "function": { "name": "read", "arguments": arguments },
                            }] } }]
                        }))
                    };
                    let Ok(clone) = stream.try_clone() else { return };
                    let mut reader = BufReader::new(clone);
                    let mut content_length = 0usize;
                    let mut body = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        let trimmed = line.trim_end();
                        if trimmed.is_empty() {
                            break;
                        }
                        if let Some((name, value)) = trimmed.split_once(':') {
                            if name.trim().eq_ignore_ascii_case("content-length") {
                                content_length = value.trim().parse().unwrap_or(0);
                            }
                        }
                    }
                    if content_length > 0 {
                        let mut bytes = vec![0u8; content_length];
                        if reader.read_exact(&mut bytes).is_err() {
                            return;
                        }
                        body = String::from_utf8_lossy(&bytes).into_owned();
                    }
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                    );
                    // The dispatcher works on the history AFTER the last
                    // user message: markers stay in earlier turns forever,
                    // and a naive `contains` would re-issue the tool call
                    // every round (the attack never settles). A pending tool
                    // result in that tail means the current run's tool round
                    // completed — answer text so the run settles.
                    let tail = &body[body.rfind("\"role\":\"user\"").map(|i| i).unwrap_or(0)..];
                    let attack_here = tail.contains("OUTSIDE-ATTACK") && !tail.contains("\"role\":\"tool\"");
                    let control_here = tail.contains("INSIDE-CONTROL") && !tail.contains("\"role\":\"tool\"");
                    let mut chunks: Vec<String> = vec![sse_chunk(&json!({
                        "choices": [{ "delta": { "role": "assistant" } }]
                    }))];
                    if attack_here {
                        chunks.push(tool_call_chunk("call-out", &secret_json));
                        chunks.push(sse_chunk(&json!({
                            "choices": [{ "delta": {}, "finish_reason": "tool_calls" }]
                        })));
                    } else if control_here {
                        chunks.push(tool_call_chunk("call-in", "{\"path\":\"inside.txt\"}"));
                        chunks.push(sse_chunk(&json!({
                            "choices": [{ "delta": {}, "finish_reason": "tool_calls" }]
                        })));
                    } else {
                        chunks.push(sse_chunk(&json!({ "choices": [{ "delta": { "content": "done" } }] })));
                        chunks.push(sse_chunk(&json!({
                            "choices": [{ "delta": {}, "finish_reason": "stop" }]
                        })));
                    }
                    chunks.push("[DONE]".to_string());
                    for chunk in chunks {
                        let _ = stream.write_all(format!("data: {chunk}\n\n").as_bytes());
                    }
                    let _ = stream.flush();
                });
            }
        });
        let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
            .canonicalize()
            .expect("the shipped bridge asset resolves");
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent");
        let managed = stage_managed_tree(dir.path());

        let models = json!({
            "providers": {
                "attack": {
                    "baseUrl": format!("http://{endpoint}"),
                    "apiKey": "attack-not-a-credential",
                    "api": "openai-completions",
                    "models": [{
                        "id": "attacky", "name": "Attack fixture", "reasoning": false,
                        "input": ["text"], "contextWindow": 200000, "maxTokens": 4096,
                        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
                    }]
                }
            }
        });
        std::fs::write(agent_dir.join("models.json"), models.to_string()).expect("models");
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"defaultProvider":"attack","defaultModel":"attacky"}"#,
        )
        .expect("settings");

        let state = state();
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        *state.spawn_base.lock().unwrap() = Some(spawn_base(&executable, bridge));
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable: executable.clone(),
            agent_dir: Some(agent_dir.clone()),
            extensions: vec![
                std::path::Path::new("../lib/pi-rpc/assets/pi-web-management.mjs")
                    .canonicalize()
                    .expect("management asset"),
            ],
            env: vec![("PI_WEB_MANAGED_MODULES".to_string(), managed.display().to_string())],
        });

        // The folder chat (the ROOT request creates a folder of its own).
        let chat_root = crate::session_view::chat_workspace_dir(&agent_dir);
        let created = send(
            &state,
            json!({ "v": 1, "id": "at-c0", "op": "agent.create", "args": {
                "cwd": chat_root.display().to_string(), "type": "ensure_session",
            }}),
        );
        assert_eq!(created["ok"], true, "the chat session created: {created}");
        let chat_id = created["data"]["sessionId"].as_str().expect("the chat id").to_string();
        let summary = session_host::history::find_session_by_id(&agent_dir, &chat_id).expect("the chat session");
        let folder = std::path::PathBuf::from(&summary.cwd);
        assert!(
            crate::session_view::is_chat_folder_path(&folder, &agent_dir),
            "a folder chat: {}",
            folder.display()
        );
        // The control file INSIDE the folder, with unique content.
        let inside = folder.join("inside.txt");
        std::fs::write(&inside, "INSIDE-CONTENT-SERVED-BY-THE-POLICY-77aa").expect("inside");

        let wait_for_transcript = |needle: &str, limit: Duration| -> bool {
            let deadline = std::time::Instant::now() + limit;
            while std::time::Instant::now() < deadline {
                if let Ok(text) = std::fs::read_to_string(&summary.file) {
                    if text.contains(needle) {
                        return true;
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            false
        };

        // ATTACK: the model tries to read the OUTSIDE secret. The user's
        // message deliberately does NOT name the path (naming it would be a
        // legitimate user grant) — only the tool call does.
        let attacked = send(
            &state,
            json!({ "v": 1, "id": "at-p1", "op": "agent.command", "args": {
                "session": chat_id, "type": "prompt", "message": "OUTSIDE-ATTACK now",
            }}),
        );
        assert_eq!(attacked["ok"], true, "the prompt was accepted: {attacked}");
        assert!(
            wait_for_transcript("only works inside this chat's own folder", Duration::from_secs(30))
                || wait_for_transcript("Chats can read files in their own folder", Duration::from_secs(30)),
            "the policy hook's refusal reached the transcript"
        );
        // The secret never did (the read never executed).
        assert!(
            !wait_for_transcript("SECRET-CONTENT-NEVER-IN-A-CHAT-9f3c1a", Duration::from_secs(3)),
            "the out-of-folder read executed despite the policy"
        );

        // CONTROL: the same tool pointed INSIDE the folder is served.
        let served = send(
            &state,
            json!({ "v": 1, "id": "at-p2", "op": "agent.command", "args": {
                "session": chat_id, "type": "prompt", "message": "INSIDE-CONTROL now",
                // The composer's active-run behavior: the message queues as
                // a follow-up instead of colliding with the run in flight.
                "streamingBehavior": "followUp",
            }}),
        );
        assert_eq!(served["ok"], true, "the control prompt was accepted: {served}");
        assert!(
            wait_for_transcript("INSIDE-CONTENT-SERVED-BY-THE-POLICY-77aa", Duration::from_secs(30)),
            "the in-folder read was served (the policy scopes, it does not brick the chat)"
        );
        state.registry.remove(&chat_id, std::time::Duration::from_secs(5));
    }

    /// A rename changes the catalogue every holder displays: the list
    /// version must bump so other windows' staleness check refetches (the
    /// SSE stream carried the same bump through getSessionListVersion).
    #[test]
    fn real_pi_set_session_name_bumps_the_list_version() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
            .canonicalize()
            .expect("the shipped bridge asset resolves");
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("work");
        std::fs::create_dir_all(&cwd).expect("cwd");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");

        let state = state();
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        *state.spawn_base.lock().unwrap() = Some(spawn_base(&executable, bridge));

        let created = send(
            &state,
            json!({ "v": 1, "id": "rn0", "op": "agent.create", "args": {
                "cwd": cwd.display().to_string(), "type": "ensure_session",
            }}),
        );
        assert_eq!(created["ok"], true, "{created}");
        let sid = created["data"]["sessionId"].as_str().expect("id").to_string();
        // create itself bumped once; capture the version AFTER that.
        let before = state.session_list_version();

        let renamed = send(
            &state,
            json!({ "v": 1, "id": "rn1", "op": "agent.setSessionName", "args": { "session": sid, "name": "Renamed for the version test" } }),
        );
        assert_eq!(renamed["ok"], true, "{renamed}");
        assert!(
            state.session_list_version() > before,
            "a rename bumps the catalogue version (before {before}, after {})",
            state.session_list_version()
        );

        state.registry.remove(&sid, std::time::Duration::from_secs(5));
    }

    /// The composer outbox (queue_composer / take / send) and the state
    /// poll's queued/context fields, against the REAL pi (PI_CLI_BIN,
    /// sandboxed): an idle session with queued items delivers them as
    /// follow-ups (the prompt command reaches the child), take removes, and
    /// the state answer carries the queue snapshot.
    #[test]
    fn real_pi_composer_outbox_queues_and_delivers() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
            .canonicalize()
            .expect("the shipped bridge asset resolves");
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("work");
        std::fs::create_dir_all(cwd.join(".pi")).expect("cwd");
        std::fs::create_dir_all(agent_dir.join("extensions")).expect("extensions");
        // A local-only configured model (the recovery-smoke pattern: a dead
        // endpoint with real limits — no model or network is ever called) so
        // the child computes usage, and a discovered fixture command a queued
        // message can address (project sessions discover agent extensions —
        // the spawn shape the Next factory kept).
        std::fs::write(
            agent_dir.join("models.json"),
            r#"{"providers":{"fixture":{"baseUrl":"http://127.0.0.1:1","apiKey":"fixture-not-a-credential","api":"openai-completions","models":[{"id":"local","name":"Local fixture","reasoning":false,"input":["text"],"contextWindow":200000,"maxTokens":4096,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}"#,
        )
        .expect("models");
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"defaultProvider":"fixture","defaultModel":"local"}"#,
        )
        .expect("settings");
        let marker = cwd.join("delivered-marker.txt");
        let marker_text = marker.display().to_string().replace('\\', "\\\\");
        std::fs::write(
            agent_dir.join("extensions").join("fixture.js"),
            format!(
                "export default function(pi) {{ pi.registerCommand('fixture-mark', {{ handler: async () => {{ require('fs').appendFileSync({marker_text:?}, 'marked\\n'); }} }}); }}"
            ),
        )
        .expect("fixture");

        let state = state();
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        *state.spawn_base.lock().unwrap() = Some(spawn_base(&executable, bridge));

        // A session to host the outbox.
        let created = send(
            &state,
            json!({ "v": 1, "id": "cq0", "op": "agent.create", "args": {
                "cwd": cwd.display().to_string(), "type": "ensure_session",
            }}),
        );
        assert_eq!(created["ok"], true, "{created}");
        let sid = created["data"]["sessionId"].as_str().expect("id").to_string();

        // 1. An empty message is refused (the wrapper's own validation).
        let empty = send(
            &state,
            json!({ "v": 1, "id": "cq1", "op": "agent.command", "args": { "session": sid, "type": "queue_composer", "message": "   " } }),
        );
        assert_eq!(empty["error"]["code"], "invalid_args", "{empty}");

        // 2. Queue one; the item answers and the state poll carries it.
        let queued = send(
            &state,
            json!({ "v": 1, "id": "cq2", "op": "agent.command", "args": { "session": sid, "type": "queue_composer", "message": "queued hello" } }),
        );
        assert_eq!(queued["ok"], true, "{queued}");
        let item_id = queued["data"]["id"].as_str().expect("the queued item id").to_string();
        assert_eq!(queued["data"]["message"], "queued hello");

        // 3. take_composer_message returns the item and the snapshot.
        let taken = send(
            &state,
            json!({ "v": 1, "id": "cq3", "op": "agent.command", "args": { "session": sid, "type": "take_composer_message", "id": item_id } }),
        );
        assert_eq!(taken["ok"], true, "{taken}");
        assert_eq!(taken["data"]["item"]["message"], "queued hello");
        assert_eq!(taken["data"]["pending"].as_array().map(Vec::len), Some(0));

        // 4. Queue a fixture command and let idle delivery send it to the
        // child: the handled prompt runs the discovered fixture extension's
        // command (proof the delivery rode the prompt command AND that
        // project sessions discover agent-dir extensions — the factory's
        // discovery-on shape).
        let queued2 = send(
            &state,
            json!({ "v": 1, "id": "cq4", "op": "agent.command", "args": { "session": sid, "type": "queue_composer", "message": "/fixture-mark" } }),
        );
        assert_eq!(queued2["ok"], true, "{queued2}");
        // The drain thread delivers; poll for the fixture's marker.
        let mut delivered = false;
        for _ in 0..150 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if std::fs::read_to_string(&marker).is_ok_and(|text| text.contains("marked")) {
                delivered = true;
                break;
            }
        }
        assert!(delivered, "the queued message reached the child (the fixture command ran)");
        // The queue emptied.
        let poll = send(
            &state,
            json!({ "v": 1, "id": "cq5", "op": "sessions.state", "args": { "session": sid } }),
        );
        assert_eq!(poll["ok"], true, "{poll}");
        assert_eq!(
            poll["data"]["state"]["queuedMessages"]["pending"].as_array().map(Vec::len),
            Some(0),
            "the delivered item left the outbox: {}",
            poll["data"]["state"]["queuedMessages"]
        );
        // The context meter answers the child's own usage (a configured
        // local model → real limits; null stays null, never zero).
        assert!(
            poll["data"]["state"]["contextUsage"].is_null()
                || poll["data"]["state"]["contextUsage"].is_object(),
            "the context meter field: {}",
            poll["data"]["state"]["contextUsage"]
        );
        assert!(poll["data"]["state"].get("systemPrompt").is_some(), "the system-prompt field exists");
        state.registry.remove(&sid, std::time::Duration::from_secs(5));
    }

    /// The drain's settle coordination against the REAL pi (PI_CLI_BIN,
    /// sandboxed): two items queued while the session is idle; the FIRST
    /// delivery's run is held open by a fixture extension (deterministic —
    /// a slow command, no model). While that run is in flight, the second
    /// item MUST still be in the editable outbox: admission alone must not
    /// pop it (the agent_start event projects the run only after the
    /// admission response — the exact window the old drain raced).
    #[test]
    fn real_pi_composer_drain_keeps_the_next_item_editable_until_the_run_settles() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
            .canonicalize()
            .expect("the shipped bridge asset resolves");
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("work");
        std::fs::create_dir_all(cwd.join(".pi")).expect("cwd");
        std::fs::create_dir_all(agent_dir.join("extensions")).expect("extensions");
        // The stalled-model shape keeps the run open deterministically.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let endpoint = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                std::mem::forget(stream);
            }
        });
        let models = json!({
            "providers": {
                "stall": {
                    "baseUrl": format!("http://{endpoint}"),
                    "apiKey": "stall-not-a-credential",
                    "api": "openai-completions",
                    "models": [{
                        "id": "stuck", "name": "Stuck", "reasoning": false,
                        "input": ["text"], "contextWindow": 200000, "maxTokens": 4096,
                        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
                    }]
                }
            }
        });
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        std::fs::write(agent_dir.join("models.json"), models.to_string()).expect("models");
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"defaultProvider":"stall","defaultModel":"stuck"}"#,
        )
        .expect("settings");

        let state = state();
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        *state.spawn_base.lock().unwrap() = Some(spawn_base(&executable, bridge));

        // Create the session and hold ONE run open (the prompt stalls on the
        // model endpoint — is_running stays true until the 120s timeout).
        let created = send(
            &state,
            json!({ "v": 1, "id": "dr0", "op": "agent.create", "args": {
                "cwd": cwd.display().to_string(), "type": "prompt", "message": "hold the run open",
            }}),
        );
        assert_eq!(created["ok"], true, "{created}");
        let sid = created["data"]["sessionId"].as_str().expect("id").to_string();

        // The run is in flight: queue TWO more while it runs.
        let run_state = send(
            &state,
            json!({ "v": 1, "id": "dr1", "op": "sessions.runState", "args": { "session": sid } }),
        );
        assert_eq!(run_state["data"]["running"], true, "the first run is in flight: {run_state}");
        let first = send(
            &state,
            json!({ "v": 1, "id": "dr2", "op": "agent.command", "args": { "session": sid, "type": "queue_composer", "message": "first follow-up" } }),
        );
        assert_eq!(first["ok"], true, "{first}");
        let second = send(
            &state,
            json!({ "v": 1, "id": "dr3", "op": "agent.command", "args": { "session": sid, "type": "queue_composer", "message": "second follow-up" } }),
        );
        assert_eq!(second["ok"], true, "{second}");
        let second_id = second["data"]["id"].as_str().expect("the second item id").to_string();

        // While the run is in flight, the SECOND item is still editable —
        // the drain must not have popped it (canDeliver is false).
        let taken = send(
            &state,
            json!({ "v": 1, "id": "dr4", "op": "agent.command", "args": { "session": sid, "type": "take_composer_message", "id": second_id } }),
        );
        assert_eq!(taken["ok"], true, "{taken}");
        assert_eq!(taken["data"]["item"]["message"], "second follow-up", "the second item was still in the editable outbox");
        assert_eq!(
            taken["data"]["pendingVersion"], 3,
            "the version moved with every change (enqueue, enqueue, take): {taken}"
        );
        assert_eq!(
            taken["data"]["pending"].as_array().map(Vec::len),
            Some(1),
            "only the first follow-up is still queued: {taken}"
        );

        state.registry.remove(&sid, std::time::Duration::from_secs(5));
    }

    /// The running-set stream against the REAL pi (PI_CLI_BIN, sandboxed):
    /// two sessions stuck on a model endpoint that accepts connections and
    /// never answers (deterministic — no model, no network) hold the running
    /// set; the stream's observation lists them SORTED and does not re-emit
    /// an unchanged observation.
    #[test]
    fn real_pi_running_stream_lists_sorted_ids_and_skips_unchanged() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        // The stalled endpoint: accept every connection, never answer.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let endpoint = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                // Hold the socket open without ever writing a response.
                std::mem::forget(stream);
            }
        });
        let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
            .canonicalize()
            .expect("the shipped bridge asset resolves");
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("work");
        std::fs::create_dir_all(&cwd).expect("cwd");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let models = json!({
            "providers": {
                "stall": {
                    "baseUrl": format!("http://{endpoint}"),
                    "apiKey": "stall-not-a-credential",
                    "api": "openai-completions",
                    "models": [{
                        "id": "stuck",
                        "name": "Stuck",
                        "reasoning": false,
                        "input": ["text"],
                        "contextWindow": 200000,
                        "maxTokens": 4096,
                        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
                    }]
                }
            }
        });
        std::fs::write(agent_dir.join("models.json"), models.to_string()).expect("models");
        std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions");
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"defaultProvider":"stall","defaultModel":"stuck"}"#,
        )
        .expect("settings");

        let state = state();
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        *state.spawn_base.lock().unwrap() = Some(spawn_base(&executable, bridge));

        // Two sessions, both prompted at the stalled endpoint: each holds
        // the running set while its model call hangs.
        let mut ids: Vec<String> = Vec::new();
        for n in 0..2 {
            let created = send(
                &state,
                json!({ "v": 1, "id": format!("rs-c{n}"), "op": "agent.create", "args": {
                    "cwd": cwd.display().to_string(), "type": "prompt",
                    "message": format!("hold {n}"),
                }}),
            );
            assert_eq!(created["ok"], true, "session {n} created: {created}");
            ids.push(created["data"]["sessionId"].as_str().expect("id").to_string());
        }
        let mut sorted_expected = ids.clone();
        sorted_expected.sort();

        // Subscribe: the first frame lists both ids sorted.
        let (channel, frames) = recording_channel();
        let ack = subscribe_running(&state, channel, Duration::from_secs(60));
        let subscription_id = ack["subscriptionId"].as_str().expect("subscriptionId").to_string();
        let mut both_running = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            if frames.lock().unwrap().iter().any(|frame| {
                frame["payload"]["runningSessionIds"] == json!(sorted_expected)
            }) {
                both_running = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(
            both_running,
            "a frame lists both sessions sorted {sorted_expected:?}: {:?}",
            frames.lock().unwrap()
        );
        // An unchanged observation is not re-emitted (no probe in 60s; two
        // cadences settle below the frame count that arrived).
        let settled = frames.lock().unwrap().len();
        std::thread::sleep(Duration::from_millis(2_400));
        assert!(
            frames.lock().unwrap().len() <= settled,
            "no spurious duplicate frames for an unchanged set: {:?}",
            frames.lock().unwrap()
        );
        // Every frame's payload is a valid observation (never a partial set
        // with an unsorted pair).
        for frame in frames.lock().unwrap().iter() {
            let listed: Vec<String> = frame["payload"]["runningSessionIds"]
                .as_array()
                .map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let mut listed_sorted = listed.clone();
            listed_sorted.sort();
            assert_eq!(listed, listed_sorted, "every frame lists sorted ids: {frame}");
        }
        let done = unsubscribe_running(&state, &subscription_id);
        assert_eq!(done["ok"], true, "{done}");
        for id in &ids {
            state.registry.remove(id, std::time::Duration::from_secs(5));
        }
    }

    /// The event-driven relay must observe a run SHORTER than any sampling
    /// cadence (the reviewer's P2-1 question): with a 60 s probe, only the
    /// registry's running SIGNAL can carry the start and the settle inside
    /// the test window. A fast fixture provider answers at once, so the run
    /// starts and settles well under a second.
    #[test]
    fn real_pi_running_stream_observes_a_short_run_start_and_settle() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        // A fast openai-completions endpoint: one streamed completion,
        // written the moment the request arrives.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let endpoint = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                std::thread::spawn(move || {
                    // Read the request head + body (best effort; the answer
                    // does not depend on it).
                    use std::io::{BufRead, BufReader, Read, Write};
                    let Ok(clone) = stream.try_clone() else { return };
                    let mut reader = BufReader::new(clone);
                    let mut content_length = 0usize;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        let trimmed = line.trim_end();
                        if trimmed.is_empty() {
                            break;
                        }
                        if let Some((name, value)) = trimmed.split_once(':') {
                            if name.trim().eq_ignore_ascii_case("content-length") {
                                content_length = value.trim().parse().unwrap_or(0);
                            }
                        }
                    }
                    if content_length > 0 {
                        let mut body = vec![0u8; content_length];
                        if reader.read_exact(&mut body).is_err() {
                            return;
                        }
                    }
                    let chunks = [
                        "{\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}".to_string(),
                        "{\"choices\":[{\"delta\":{\"content\":\"done\"}}]}".to_string(),
                        "{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}".to_string(),
                        "[DONE]".to_string(),
                    ];
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
                    );
                    for chunk in chunks {
                        let _ = stream.write_all(format!("data: {chunk}\n\n").as_bytes());
                    }
                    let _ = stream.flush();
                });
            }
        });
        let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
            .canonicalize()
            .expect("the shipped bridge asset resolves");
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let cwd = dir.path().join("work");
        std::fs::create_dir_all(&cwd).expect("cwd");
        std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
        let models = json!({
            "providers": {
                "fast": {
                    "baseUrl": format!("http://{endpoint}"),
                    "apiKey": "fast-not-a-credential",
                    "api": "openai-completions",
                    "models": [{
                        "id": "quick", "name": "Quick", "reasoning": false,
                        "input": ["text"], "contextWindow": 200000, "maxTokens": 4096,
                        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
                    }]
                }
            }
        });
        std::fs::write(agent_dir.join("models.json"), models.to_string()).expect("models");
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"defaultProvider":"fast","defaultModel":"quick"}"#,
        )
        .expect("settings");

        let state = state();
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        *state.spawn_base.lock().unwrap() = Some(spawn_base(&executable, bridge));

        // The session exists (and its child is up) BEFORE the subscription,
        // so the first frame is a settled observation and the ONLY later
        // changes are the prompt's start and settle transitions.
        let created = send(
            &state,
            json!({ "v": 1, "id": "sr-c0", "op": "agent.create", "args": {
                "cwd": cwd.display().to_string(), "type": "ensure_session",
            }}),
        );
        assert_eq!(created["ok"], true, "{created}");
        let session_id = created["data"]["sessionId"].as_str().expect("id").to_string();

        let (channel, frames) = recording_channel();
        // A 60 s probe: within the test window ONLY the running signal can
        // deliver a frame — this is exactly what the test asserts.
        let ack = subscribe_running(&state, channel, Duration::from_secs(60));
        let subscription_id = ack["subscriptionId"].as_str().expect("subscriptionId").to_string();
        assert!(wait_for_frames(&frames, 1, Duration::from_secs(5)));
        assert_eq!(
            frames.lock().unwrap()[0]["payload"]["runningSessionIds"],
            json!([]),
            "the first observation is settled: {:?}",
            frames.lock().unwrap()
        );

        // The prompt: a run that starts and settles within ~a second.
        let prompted = send(
            &state,
            json!({ "v": 1, "id": "sr-p0", "op": "agent.command", "args": {
                "session": session_id, "type": "prompt", "message": "finish fast",
            }}),
        );
        assert_eq!(prompted["ok"], true, "the prompt was accepted: {prompted}");

        // Transition 1: the session appears in the running set.
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        let mut saw_running = false;
        while std::time::Instant::now() < deadline {
            if frames.lock().unwrap().iter().any(|frame| {
                frame["payload"]["runningSessionIds"] == json!([session_id])
            }) {
                saw_running = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(
            saw_running,
            "the short run's START was observed without any cadence: {:?}",
            frames.lock().unwrap()
        );
        // Transition 2: the settle — a later frame without the id.
        let mut saw_settled = false;
        while std::time::Instant::now() < deadline {
            let frames_now = frames.lock().unwrap();
            if frames_now.iter().any(|frame| {
                frame["seq"].as_u64().unwrap_or(0) > 1
                    && frame["payload"]["runningSessionIds"] == json!([])
            }) {
                saw_settled = true;
                break;
            }
            drop(frames_now);
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(
            saw_settled,
            "the short run's SETTLE was observed without any cadence: {:?}",
            frames.lock().unwrap()
        );

        let done = unsubscribe_running(&state, &subscription_id);
        assert_eq!(done["ok"], true, "{done}");
        state.registry.remove(&session_id, std::time::Duration::from_secs(5));
    }

    #[test]
    fn files_list_shows_the_wire_shape_and_refuses_outside_roots() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(project.join("sub")).expect("sub");
        std::fs::write(project.join("a.txt"), b"1").expect("a");
        std::fs::write(project.join("z.txt"), b"2").expect("z");
        // Conventionally hidden names (no git repo here: the fallback list).
        std::fs::create_dir_all(project.join("node_modules")).expect("nm");
        std::fs::write(project.join("keep.pyc"), b"").expect("pyc");

        // Outside the roots: refused.
        let refused = send(
            &state,
            json!({ "v": 1, "id": "l0", "op": "files.list", "args": { "path": project.display().to_string() } }),
        );
        assert_eq!(refused["error"]["code"], "unauthorized_scope");

        state.propose_path(&project);
        let listed = send(
            &state,
            json!({ "v": 1, "id": "l1", "op": "files.list", "args": { "path": project.display().to_string() } }),
        );
        assert_eq!(listed["ok"], true, "{listed}");
        let entries = listed["data"]["entries"].as_array().expect("entries");
        let names: Vec<&str> = entries.iter().map(|e| e["name"].as_str().unwrap_or("")).collect();
        // Hidden names stay out; the rest is dirs-first alphabetical.
        assert_eq!(names, vec!["sub", "a.txt", "z.txt"], "dirs first, then files");
        assert_eq!(entries[0]["isDir"], true);
        assert_eq!(entries[1]["isDir"], false);
        assert_eq!(listed["data"]["path"], project.display().to_string());
        // A file path is not a directory.
        let not_dir = send(
            &state,
            json!({ "v": 1, "id": "l2", "op": "files.list", "args": { "path": project.join("a.txt").display().to_string() } }),
        );
        assert_eq!(not_dir["error"]["code"], "invalid_args", "{not_dir}");
    }

    #[test]
    fn files_list_git_tracked_names_win_over_ignores() {
        // #677: a repository decides inside a work tree — a TRACKED build/
        // stays visible even though the fallback list would hide it, and an
        // ignored name stays hidden. Requires git on PATH (the test skips
        // honestly where git is absent, like the TS suite's environment).
        if !std::process::Command::new("git").arg("--version").output().is_ok() {
            eprintln!("skipping: git not on PATH");
            return;
        }
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).expect("repo");
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .expect("git")
        };
        assert!(git(&["init", "-q"]).status.success());
        assert!(git(&["config", "user.email", "t@t"]).status.success());
        assert!(git(&["config", "user.name", "t"]).status.success());
        // build/ is tracked; cache/ is ignored via .gitignore; .git always hides.
        std::fs::create_dir_all(repo.join("build")).expect("build");
        std::fs::create_dir_all(repo.join("cache")).expect("cache");
        std::fs::write(repo.join("build").join("out.txt"), "x").expect("out");
        std::fs::write(repo.join(".gitignore"), "cache/\n").expect("ignore");
        assert!(git(&["add", "."]).status.success());
        assert!(git(&["commit", "-qm", "init"]).status.success());

        state.propose_path(&repo);
        let listed = send(
            &state,
            json!({ "v": 1, "id": "gl1", "op": "files.list", "args": { "path": repo.display().to_string() } }),
        );
        assert_eq!(listed["ok"], true, "{listed}");
        let names: Vec<&str> = listed["data"]["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .map(|e| e["name"].as_str().unwrap_or(""))
            .collect();
        assert!(names.contains(&"build"), "a tracked build/ stays visible (#677): {names:?}");
        assert!(!names.contains(&"cache"), "an ignored directory hides: {names:?}");
        assert!(!names.contains(&".git"), ".git always hides: {names:?}");
        assert!(names.contains(&".gitignore"), "a tracked file lists: {names:?}");
    }


    #[test]
    #[cfg(unix)]
    fn files_allow_link_grants_only_the_shown_target() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).expect("proj");
        let outside = dir.path().join("outside");
        let other = dir.path().join("other");
        std::fs::create_dir_all(&outside).expect("outside");
        std::fs::create_dir_all(&other).expect("other");
        let link = project.join("linked");
        std::os::unix::fs::symlink(&outside, &link).expect("linked");
        state.propose_path(&project);
        let send_allow = |id: &str, target: &std::path::Path| {
            send(
                &state,
                json!({ "v": 1, "id": id, "op": "files.allowLink", "args": {
                    "link": link.display().to_string(),
                    "target": target.display().to_string(),
                } }),
            )
        };

        // The operator was shown `outside`: approved, and the target becomes
        // browsable (a host-side root from an explicit operator action).
        let approved = send_allow("al1", &outside);
        assert_eq!(approved["ok"], true, "{approved}");
        assert_eq!(approved["data"]["alreadyAllowed"], false);
        let listed = send(
            &state,
            json!({ "v": 1, "id": "al2", "op": "files.list", "args": { "path": outside.display().to_string() } }),
        );
        assert_eq!(listed["ok"], true, "the granted target is browsable: {listed}");

        // A NEW project link aimed at `other`: the shown-target check
        // refuses (the listing showed the old target).
        let link2 = project.join("relinked");
        std::os::unix::fs::symlink(&other, &link2).expect("relinked");
        let reaimed = send(
            &state,
            json!({ "v": 1, "id": "al3", "op": "files.allowLink", "args": {
                "link": link2.display().to_string(),
                "target": outside.display().to_string(),
            } }),
        );
        assert_eq!(reaimed["ok"], false, "{reaimed}");
        assert_eq!(reaimed["error"]["code"], "invalid_args");
        assert!(reaimed["error"]["message"].as_str().unwrap_or_default().contains("changed"));
        // And nothing was granted.
        let not_granted = send(
            &state,
            json!({ "v": 1, "id": "al4", "op": "files.list", "args": { "path": other.display().to_string() } }),
        );
        assert_eq!(not_granted["error"]["code"], "unauthorized_scope");

        // A non-symlink path inside the roots is refused with the TS shape.
        std::fs::write(project.join("plain.txt"), b"x").expect("plain");
        let not_link = send(
            &state,
            json!({ "v": 1, "id": "al6", "op": "files.allowLink", "args": {
                "link": project.join("plain.txt").display().to_string(),
                "target": project.display().to_string(),
            } }),
        );
        assert_eq!(not_link["error"]["code"], "invalid_args", "{not_link}");
        assert!(not_link["error"]["message"].as_str().unwrap_or_default().contains("Not a linked"));
    }

    #[test]
    fn files_list_marks_a_directory_symlink_pointing_outside() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).expect("proj");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        std::os::unix::fs::symlink(&outside, project.join("linked")).expect("linked");
        state.propose_path(&project);
        let listed = send(
            &state,
            json!({ "v": 1, "id": "sl1", "op": "files.list", "args": { "path": project.display().to_string() } }),
        );
        assert_eq!(listed["ok"], true, "{listed}");
        let entry = listed["data"]["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .find(|e| e["name"] == "linked")
            .expect("the link lists as a directory");
        assert_eq!(entry["isDir"], true);
        assert_eq!(
            entry["outsideLinkTarget"].as_str().unwrap_or(""),
            outside.canonicalize().unwrap().to_string_lossy(),
            "the explorer gets the target for its confirmation flow"
        );
    }

    // ---------------------------------------------------------------------
    // The session view over the REAL pi child (PI_CLI_BIN, sandboxed agent
    // dir, staged vendored management tree): sessions.get / sessions.context
    // / sessions.state — the M2 read loop.
    // ---------------------------------------------------------------------

    /// Write a fixture session file with a branch point, a model change, a
    /// compaction divider and a tool pin (the same shape the differential
    /// projection test pins field by field).
    fn write_view_fixture(sessions_dir: &std::path::Path, cwd: &std::path::Path, id: &str) -> std::path::PathBuf {
        std::fs::create_dir_all(sessions_dir).expect("sessions dir");
        let file = sessions_dir.join(format!("20260201T100000_{id}.jsonl"));
        let lines = vec![
            json!({ "type": "session", "version": 3, "id": id, "timestamp": "2026-02-01T10:00:00.000Z", "cwd": cwd.display().to_string() }),
            json!({ "type": "message", "id": "u1", "parentId": null, "timestamp": "2026-02-01T10:00:01.000Z", "message": { "role": "user", "content": "first question" } }),
            json!({ "type": "message", "id": "a1", "parentId": "u1", "timestamp": "2026-02-01T10:00:02.000Z", "message": { "role": "assistant", "provider": "p", "model": "m1", "content": [{ "type": "text", "text": "answer one" }] } }),
            json!({ "type": "message", "id": "u2", "parentId": "a1", "timestamp": "2026-02-01T10:00:03.000Z", "message": { "role": "user", "content": "the abandoned branch" } }),
            json!({ "type": "message", "id": "u2b", "parentId": "a1", "timestamp": "2026-02-01T10:00:04.000Z", "message": { "role": "user", "content": "the kept branch" } }),
            json!({ "type": "message", "id": "a2", "parentId": "u2b", "timestamp": "2026-02-01T10:00:05.000Z", "message": { "role": "assistant", "content": [{ "type": "text", "text": "answer two" }] } }),
            json!({ "type": "model_change", "id": "mc1", "parentId": "a2", "timestamp": "2026-02-01T10:00:06.000Z", "provider": "prov", "modelId": "model-x" }),
            json!({ "type": "thinking_level_change", "id": "tl1", "parentId": "mc1", "timestamp": "2026-02-01T10:00:07.000Z", "thinkingLevel": "high" }),
            json!({ "type": "compaction", "id": "cp1", "parentId": "tl1", "timestamp": "2026-02-01T10:00:08.000Z", "summary": "earlier turns compacted", "firstKeptEntryId": "u2b", "tokensBefore": 4096 }),
            json!({ "type": "message", "id": "u3", "parentId": "cp1", "timestamp": "2026-02-01T10:00:09.000Z", "message": { "role": "user", "content": "after compaction" } }),
            json!({ "type": "custom", "id": "ts1", "parentId": "u3", "timestamp": "2026-02-01T10:00:10.000Z", "customType": "pi-web:tool-selection", "data": { "version": 1, "tools": ["read", "bash"] } }),
            json!({ "type": "message", "id": "a3", "parentId": "ts1", "timestamp": "2026-02-01T10:00:11.000Z", "message": { "role": "assistant", "content": [{ "type": "text", "text": "final" }] } }),
        ];
        let body = lines
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&file, format!("{body}\n")).expect("fixture");
        file
    }

    /// Stage the vendored management tree with the repo's node (the same
    /// staging rules desktop:prepare uses — never a partial tree). The tree
    /// root holds node_modules/ so the vendored packages resolve their
    /// closure inside the tree (the desktop:prepare layout).
    fn stage_managed_tree(dir: &std::path::Path) -> std::path::PathBuf {
        let managed = dir.join("managed").join("node_modules");
        let script = std::path::Path::new("../scripts/migration/stage-managed-tree.mjs")
            .canonicalize()
            .expect("the staging script resolves");
        let output = std::process::Command::new("node")
            .arg(script)
            .arg("--out")
            .arg(&managed)
            .output()
            .expect("node runs the staging script");
        assert!(
            output.status.success(),
            "staging failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        managed
    }

    #[test]
    fn real_pi_sessions_get_context_and_state_read_the_view() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|value| !value.is_empty()) else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let sessions = agent_dir.join("sessions").join("proj");
        let cwd = dir.path().join("work");
        std::fs::create_dir_all(&cwd).expect("cwd");
        let file = write_view_fixture(&sessions, &cwd, "view-s1");
        let managed = stage_managed_tree(dir.path());

        let state = state();
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        *state.spawn_base.lock().unwrap() = Some(spawn_base(
            &executable,
            std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
                .canonicalize()
                .expect("bridge asset"),
        ));
        // The management instance runs SANDBOXED against the same temp agent
        // dir with the staged vendored tree (never the real ~/.pi/agent).
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable,
            agent_dir: Some(agent_dir.clone()),
            extensions: vec![
                std::path::Path::new("../lib/pi-rpc/assets/pi-web-management.mjs")
                    .canonicalize()
                    .expect("management asset"),
            ],
            env: vec![(
                "PI_WEB_MANAGED_MODULES".to_string(),
                managed.display().to_string(),
            )],
        });

        // 1. The disk view (no child): the full GET /api/sessions/[id] shape.
        let view = send(
            &state,
            json!({ "v": 1, "id": "v1", "op": "sessions.get", "args": {
                "session": "view-s1", "summaryTree": true, "deferThinking": true, "deferMedia": true, "wholeTurns": true,
            } }),
        );
        assert_eq!(view["ok"], true, "the disk view answered: {view}");
        let data = &view["data"];
        assert_eq!(data["sessionId"], "view-s1");
        assert_eq!(data["filePath"], file.display().to_string());
        assert_eq!(data["treeFormat"], "summary");
        assert_eq!(data["leafId"], "a3");
        assert_eq!(data["info"]["id"], "view-s1");
        assert_eq!(data["info"]["workspaceKind"], "project");
        assert_eq!(data["info"]["firstMessage"], "first question");
        assert_eq!(data["info"]["messageCount"], 7, "user+assistant messages over all branches");
        assert_eq!(data["info"]["compactionCount"], 1);
        assert_eq!(data["toolNames"].as_array().map(Vec::len), Some(2), "the tool pin survived");
        let context = &data["context"];
        assert_eq!(context["model"]["modelId"], "model-x");
        assert_eq!(context["thinkingLevel"], "high");
        let texts: Vec<&str> = context["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .map(|message| {
                message["content"]
                    .as_str()
                    .or_else(|| {
                        message["content"].as_array().and_then(|blocks| {
                            blocks
                                .iter()
                                .find(|block| block["type"] == "text")
                                .and_then(|block| block["text"].as_str())
                        })
                    })
                    .unwrap_or("")
            })
            .collect();
        assert!(texts.contains(&"the kept branch"), "the active branch's texts: {texts:?}");
        assert!(!texts.contains(&"the abandoned branch"), "the abandoned sibling stays out");
        // The compaction divider renders as a custom message.
        assert!(
            context["messages"].as_array().unwrap().iter().any(|message| message["customType"] == "compaction"),
            "the compaction divider renders"
        );
        assert!(data["snapshotRevision"].is_string(), "an opaque revision token");
        assert_eq!(data["stats"]["totalMessages"], 7);

        // 2. Branch paging: an explicit leaf addresses the abandoned branch.
        let branch = send(
            &state,
            json!({ "v": 1, "id": "v2", "op": "sessions.context", "args": {
                "session": "view-s1", "leafId": "u2", "deferThinking": true, "deferMedia": true,
            } }),
        );
        assert_eq!(branch["ok"], true, "{branch}");
        let branch_texts = branch["data"]["context"]["messages"].as_array().unwrap().len();
        assert_eq!(branch_texts, 3, "u1, a1, u2 — the abandoned branch, not the tail");

        // 3. `before` pagination excludes the cursor.
        let page = send(
            &state,
            json!({ "v": 1, "id": "v3", "op": "sessions.context", "args": {
                "session": "view-s1", "before": "cp1", "tail": 2, "deferThinking": true, "deferMedia": true,
            } }),
        );
        assert_eq!(page["ok"], true, "{page}");
        assert_eq!(page["data"]["before"], "cp1");
        let page_ids = page["data"]["context"]["entryIds"].as_array().unwrap();
        assert!(!page_ids.iter().any(|entry| entry == "cp1"), "the cursor is excluded");

        // 4. State on a not-running session: running=false (and a ghost 404s).
        let idle = send(
            &state,
            json!({ "v": 1, "id": "v4", "op": "sessions.state", "args": { "session": "view-s1" } }),
        );
        assert_eq!(idle["ok"], true, "{idle}");
        assert_eq!(idle["data"]["running"], false);
        let ghost = send(
            &state,
            json!({ "v": 1, "id": "v5", "op": "sessions.state", "args": { "session": "ghost" } }),
        );
        assert_eq!(ghost["error"]["code"], "not_found");

        // 5. The LIVE view: cold-start the real child, then read the same
        //    session through the one-shot snapshot handoff.
        let started = send(
            &state,
            json!({ "v": 1, "id": "v6", "op": "agent.command", "args": { "session": "view-s1", "type": "get_state" } }),
        );
        assert_eq!(started["ok"], true, "the child cold-started: {started}");
        let live = send(
            &state,
            json!({ "v": 1, "id": "v7", "op": "sessions.get", "args": {
                "session": "view-s1", "summaryTree": true, "deferThinking": true, "deferMedia": true, "wholeTurns": true,
            } }),
        );
        assert_eq!(live["ok"], true, "the live view answered: {live}");
        assert_eq!(live["data"]["leafId"], "a3");
        // The live snapshot's revision differs from the disk read's (the
        // read source is part of the token).
        assert_ne!(
            live["data"]["snapshotRevision"], data["snapshotRevision"],
            "runtime: vs disk — the token carries the source"
        );
        // The temp handoff file is gone.
        let leftovers = std::fs::read_dir(std::env::temp_dir())
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| {
                        entry.file_name().to_string_lossy().starts_with("pi-web-snapshot-")
                    })
                    .count()
            })
            .unwrap_or(0);
        assert_eq!(leftovers, 0, "the snapshot handoff files are cleaned up");

        // 6. Live state: the child's get_state + the machine's projection.
        let live_state = send(
            &state,
            json!({ "v": 1, "id": "v8", "op": "sessions.state", "args": { "session": "view-s1" } }),
        );
        assert_eq!(live_state["ok"], true, "{live_state}");
        assert_eq!(live_state["data"]["running"], false, "idle after get_state");
        assert_eq!(live_state["data"]["state"]["sessionId"], "view-s1");
        assert_eq!(live_state["data"]["state"]["autoRetryEnabled"], serde_json::Value::Null, "unknown until the child proves it");

        // Cleanup: the management child and the session child.
        state.management.recycle_expired();
        state.registry.remove("view-s1", std::time::Duration::from_secs(5));
    }

    #[test]
    fn trust_status_op_answers_the_get_project_trust_status_shape() {
        // The mount probe's op: a folder with nothing trust-requiring is
        // trusted with no decision; an ancestor decision is inherited; an
        // explicit false is untrusted; a broken trust.json surfaces as
        // decisionError for the no-trust folder (the TS contract).
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("project");
        std::fs::create_dir_all(&project).expect("project");
        // The agent dir with a trust store that trusts the PARENT (so the
        // project inherits it).
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent");
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        std::fs::write(
            agent_dir.join("trust.json"),
            serde_json::to_string(&serde_json::json!({
                dir.path().to_string_lossy(): true,
                project.to_string_lossy(): false,
            }))
            .expect("serialize"),
        )
        .expect("write trust.json");
        // HOME must not make ~/.agents/skills inside the temp tree count.
        let ask = |cwd: &std::path::Path| {
            send(
                &state,
                json!({ "v": 1, "id": "t1", "op": "trust.status", "args": { "cwd": cwd.to_string_lossy() } }),
            )
        };
        // 1. Fresh folder (no trust-requiring resources): trusted, exact
        // false decision reported, not inherited.
        let response = ask(&project);
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(response["data"]["requiresTrust"], false);
        assert_eq!(response["data"]["trusted"], true);
        assert_eq!(response["data"]["decision"], false);
        assert_eq!(response["data"]["inherited"], false);
        // 2. A child of the trusted parent inherits the parent's decision.
        let child = project.join("nested");
        std::fs::create_dir_all(&child).expect("nested");
        // (remove the exact false so only the ancestor decision remains)
        std::fs::write(
            agent_dir.join("trust.json"),
            serde_json::to_string(&serde_json::json!({
                dir.path().to_string_lossy(): true,
            }))
            .expect("serialize"),
        )
        .expect("rewrite trust.json");
        let response = ask(&child);
        assert_eq!(response["data"]["decision"], true);
        assert_eq!(response["data"]["inherited"], true, "{response}");
        // 3. No store at all: no decision, no error.
        std::fs::remove_file(agent_dir.join("trust.json")).expect("remove");
        let response = ask(&child);
        assert_eq!(response["data"]["decision"], serde_json::Value::Null);
        assert_eq!(response["data"]["trusted"], true);
        assert!(response["data"].get("decisionError").is_none());
        // 4. Broken store on a no-trust folder: decisionError, still trusted.
        std::fs::write(agent_dir.join("trust.json"), "{ broken").expect("write broken");
        let response = ask(&child);
        assert_eq!(response["data"]["trusted"], true);
        assert!(
            response["data"]["decisionError"].is_string(),
            "the unparsable store is reported: {response}"
        );
    }

    #[test]
    fn settings_extras_ipc_dispatch_roundtrip() {
        let state = state();
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent");
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());

        // 1. tools.settingsGet / tools.settingsSet
        let res = send(&state, json!({ "v": 1, "id": "t1", "op": "tools.settingsGet" }));
        assert_eq!(res["ok"], true);
        assert_eq!(res["data"]["codemode"], "automatic");

        let res = send(&state, json!({
            "v": 1,
            "id": "t2",
            "op": "tools.settingsSet",
            "args": { "codemode": "always" }
        }));
        assert_eq!(res["ok"], true);
        assert_eq!(res["data"]["codemode"], "always");

        // 2. artifacts.settingsGet / artifacts.settingsSet
        let res = send(&state, json!({ "v": 1, "id": "a1", "op": "artifacts.settingsGet" }));
        assert_eq!(res["ok"], true);
        assert_eq!(res["data"]["enabled"], true);

        let res = send(&state, json!({
            "v": 1,
            "id": "a2",
            "op": "artifacts.settingsSet",
            "args": { "enabled": false }
        }));
        assert_eq!(res["ok"], true);
        assert_eq!(res["data"]["enabled"], false);

        // 3. chats.settingsGet / chats.settingsSet
        let res = send(&state, json!({ "v": 1, "id": "c1", "op": "chats.settingsGet" }));
        assert_eq!(res["ok"], true);
        assert_eq!(res["data"]["instructions"], "");

        let res = send(&state, json!({
            "v": 1,
            "id": "c2",
            "op": "chats.settingsSet",
            "args": { "instructions": "System prompt instructions" }
        }));
        assert_eq!(res["ok"], true);
        assert_eq!(res["data"]["instructions"], "System prompt instructions");

        // 4. appearance.customCssGet / appearance.customCssSet
        let res = send(&state, json!({ "v": 1, "id": "css1", "op": "appearance.customCssGet" }));
        assert_eq!(res["ok"], true);
        assert_eq!(res["data"]["css"], "");

        let res = send(&state, json!({ "v": 1, "id": "css2", "op": "appearance.customCssSet", "args": {} }));
        assert_eq!(res["ok"], true);
        assert_eq!(res["data"]["created"], true);
    }
}