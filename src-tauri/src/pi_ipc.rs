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
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;

use management_host::{ManagementHost, ManagementSpawnConfig};
use session_host::{SessionRegistry, SessionSpawnConfig};

// Terminal output frames carry base64 inside JSON Channels today; the
// raw-bytes upgrade (protocol doc §4) lands with the M4 binary channel.

/// Protocol version (must match static-frontend/src/ipc/protocol.ts and
/// docs/migration/ipc-protocol.md).
pub const IPC_PROTOCOL_VERSION: i64 = 1;

/// The managed host state (one registry per app process).
pub struct IpcHostState {
    pub registry: SessionRegistry,
    /// The spawn config is resolved at host startup (the packaged pi
    /// executable and asset paths); identity operations answer before any
    /// child exists.
    pub spawn_config: Mutex<Option<SessionSpawnConfig>>,
    subscription_counter: AtomicU64,
    /// Live event-stream relays by subscription id (unsubscribe detaches).
    event_relays: Arc<Mutex<BTreeMap<String, EventRelayHandle>>>,
    /// The terminal registry (portable-pty; crates/pty-host).
    pub terminals: pty_host::PtyHost,
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
    /// Paths the HOST itself proposed (session cwds, project roots from the
    /// session index, artifact locations). resource grants only ever accept
    /// members of this set — the frontend cannot mint its own.
    proposed_paths: Mutex<BTreeSet<String>>,
    /// Git project identity with the TS resolver's TTL cache
    /// (lib/worktree.ts resolveProject).
    pub projects: crate::session_view::ProjectResolver,
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
        Self {
            registry: SessionRegistry::new(),
            spawn_config: Mutex::new(resolve_session_spawn_config()),
            subscription_counter: AtomicU64::new(0),
            event_relays: Arc::new(Mutex::new(BTreeMap::new())),
            terminals: pty_host::PtyHost::new(),
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
            proposed_paths: Mutex::new(BTreeSet::new()),
            projects: crate::session_view::ProjectResolver::new(),
        }
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
    if let Ok(path) = std::env::var("PI_WEB_BRIDGE_EXTENSION") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    if let Some(exe_dir) = exe_dir {
        let candidates = [
            exe_dir.join("../Resources/server/lib/pi-rpc/assets/pi-web-bridge.mjs"),
            exe_dir.join("../../resources/server/lib/pi-rpc/assets/pi-web-bridge.mjs"),
        ];
        for candidate in candidates {
            if let Ok(resolved) = candidate.canonicalize() {
                if resolved.is_file() {
                    return Some(resolved);
                }
            }
        }
    }
    let dev = Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs");
    if let Ok(resolved) = dev.canonicalize() {
        if resolved.is_file() {
            return Some(resolved);
        }
    }
    None
}

/// The session spawn config, when a pi executable AND the bridge asset
/// resolve. Without either, session ops answer not_found (never a fake
/// child) — the same honesty rule the models ops apply to management.
fn resolve_session_spawn_config() -> Option<SessionSpawnConfig> {
    let executable = resolve_pi_executable()?;
    let bridge_asset = resolve_bridge_asset()?;
    Some(SessionSpawnConfig {
        executable: executable.to_string_lossy().into_owned(),
        agent_dir: None,
        session_dir: None,
        bridge_asset,
        extra_args: Vec::new(),
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
    state: State<'_, IpcHostState>,
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

/// Stream one terminal's output over a Channel: the first frame carries the
/// read since the caller's cursor (suffix or the reset+replay the history
/// window demands), then new output follows. A closed channel detaches.
#[tauri::command]
pub fn pi_ipc_subscribe_terminal(
    state: State<'_, IpcHostState>,
    id: String,
    cursor: u64,
    on_output: Channel<Value>,
) -> Value {
    let Some(terminal) = state.terminals.get(&id) else {
        return protocol_error("?", "not_found", &format!("no terminal {id}"));
    };
    let subscription_id = format!(
        "term-{}",
        state.subscription_counter.fetch_add(1, Ordering::Relaxed) + 1
    );
    let subscription_id_for_relay = subscription_id.clone();
    std::thread::Builder::new()
        .name(format!("ipc-terminal-{subscription_id}"))
        .spawn(move || {
            let mut cursor = cursor;
            let mut seq: u64 = 0;
            loop {
                let outcome = terminal.read_since(cursor);
                match outcome {
                    pty_host::ReadOutcome::Suffix { cursor: next, text } => {
                        if text.is_empty() {
                            // Nothing new: poll again shortly.
                            std::thread::sleep(Duration::from_millis(120));
                            // Detect exit: a closed terminal ends the stream.
                            if terminal.wait_exit(Duration::from_millis(0)).is_some() {
                                seq += 1;
                                let _ = on_output.send(stream_frame(
                                    &subscription_id,
                                    1,
                                    seq,
                                    "event",
                                    json!({ "kind": "exit" }),
                                ));
                                return;
                            }
                            continue;
                        }
                        cursor = next;
                        seq += 1;
                        if on_output
                            .send(stream_frame(
                                &subscription_id,
                                1,
                                seq,
                                "event",
                                json!({ "kind": "suffix", "cursor": cursor, "output": text }),
                            ))
                            .is_err()
                        {
                            return;
                        }
                    }
                    pty_host::ReadOutcome::Reset { cursor: next, text } => {
                        cursor = next;
                        seq += 1;
                        if on_output
                            .send(stream_frame(
                                &subscription_id,
                                1,
                                seq,
                                "reset",
                                json!({ "kind": "reset", "cursor": cursor, "output": text }),
                            ))
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
        })
        .ok();
    json!({ "subscriptionId": subscription_id_for_relay })
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
fn protocol_error(id: &str, code: &str, message: &str) -> Value {
    json!({
        "v": IPC_PROTOCOL_VERSION,
        "id": id,
        "ok": false,
        "error": { "code": code, "message": message, "retryable": false },
    })
}

/// The response envelope for a success.
fn protocol_ok(id: &str, data: Value) -> Value {
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
        // Session operations route through the closed table in session-host.
        // `agentDir` is stripped here: the host resolves the agent dir, the
        // frontend never chooses what directory gets scanned.
        "sessions.list" => {
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
        // The catalogue (GET /api/sessions' projection): a flat session
        // array, newest first. The Rust scan provides id/cwd/name/created/
        // modified/parentSession/firstMessage/sizeBytes; the Next route's
        // messageCount/workspaceKind/relation/running fields are NOT
        // derivable from headers and stay pending (README's unfixed list) —
        // the static UI must not pretend they exist.
        // The catalogue: the FULL per-file scan (the TS scanSessionFileInfo
        // semantics, differential-tested) — the session_info rename, message
        // and compaction counts, the attachment-aware first-user title, and
        // the activity-based modified time. Field-for-field the GET
        // /api/sessions projection except workspaceKind/relation/running
        // (runtime state the disk cannot know — README's unfixed list).
        "sessions.catalogue" => {
            let agent_dir = state.agent_dir();
            let files = session_host::list_session_files(&agent_dir);
            let mut sessions: Vec<Value> = files
                .iter()
                .filter_map(|file| session_host::scan_session_file_info(file))
                .map(|scan| {
                    json!({
                        "id": scan.id,
                        "path": scan.path.display().to_string(),
                        "cwd": scan.cwd,
                        "name": scan.name,
                        "created": ms_to_iso(scan.created_ms),
                        "modified": ms_to_iso(scan.modified_ms),
                        "messageCount": scan.message_count,
                        "compactionCount": if scan.compaction_count > 0 { json!(scan.compaction_count) } else { Value::Null },
                        "parentSessionId": scan.parent_session_path,
                        "firstMessage": scan.first_message,
                        "sizeBytes": scan.size_bytes,
                    })
                })
                .collect();
            sessions.sort_by(|a, b| {
                b.get("modified").and_then(Value::as_str).cmp(&a.get("modified").and_then(Value::as_str))
            });
            // Host-derived roots stay in step with the catalogue's cwds.
            for value in sessions.iter() {
                if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
                    state.propose_path(Path::new(cwd));
                }
            }
            protocol_ok(&id, json!({ "sessions": sessions }))
        }
        // The session VIEW (GET /api/sessions/[id] and /context): the
        // projection runs in the management instance over the repo's own
        // lib/session-projection.ts bundle; this host owns resolution
        // (live child first, disk scan second), the live one-shot snapshot,
        // workspace classification and the git project identity.
        "sessions.get" | "sessions.context" | "sessions.state" => {
            match session_view_dispatch(state, op, &args) {
                Ok(data) => protocol_ok(&id, data),
                Err((code, message)) => protocol_error(&id, &code, &message),
            }
        }
        "sessions.runState" | "agent.interrupt" | "agent.setSessionName" | "agent.runState"
        | "agent.eventsSnapshot" | "agent.command" | "agent.getTools" | "agent.setTools" => {
            // The resume path: an op on an on-disk session may cold-start its
            // child (the POST /api/agent/[id] contract) — only when the host
            // resolved a spawn config; otherwise not_found stays honest.
            let config = state.spawn_config.lock().unwrap().clone();
            let agent_dir = state.agent_dir();
            let resume = config.as_ref().map(|config| (config, agent_dir.as_path()));
            match session_host::dispatch_session_op(&state.registry, op, &args, resume) {
                Ok(data) => protocol_ok(&id, data),
                Err(error) => protocol_error(&id, error.code(), &error.to_string()),
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
            let cwd = args.get("cwd").and_then(Value::as_str).map(PathBuf::from);
            // A terminal runs a shell with the user's environment: its cwd
            // must be a directory the host already allows (a session cwd,
            // project root, default-cwd layout) — never an arbitrary
            // client-supplied path.
            if let Some(cwd) = &cwd {
                let allowed = state.file_roots.lock().unwrap().is_existing_path_allowed(cwd);
                if !allowed {
                    return protocol_error(
                        &id,
                        "unauthorized_scope",
                        "the terminal cwd is outside the allowed roots",
                    );
                }
            }
            let cols = args.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
            let rows = args.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
            match state.terminals.create(terminal_id, cwd.as_deref(), pty_host::PtyOptions { cols, rows, ..Default::default() }) {
                Ok(_) => protocol_ok(&id, json!({ "id": terminal_id })),
                Err(error) => protocol_error(&id, "io", &error),
            }
        }
        "terminal.write" => {
            let terminal_id = args.get("id").and_then(Value::as_str).unwrap_or_default();
            let Some(terminal) = state.terminals.get(terminal_id) else {
                return protocol_error(&id, "not_found", &format!("no terminal {terminal_id}"));
            };
            let input = args
                .get("input")
                .and_then(Value::as_str)
                .and_then(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).ok());
            let Some(input) = input else {
                return protocol_error(&id, "invalid_args", "input must be base64");
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
            let cols = args.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
            let rows = args.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
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
            if state.terminals.close(terminal_id) {
                protocol_ok(&id, json!({ "closed": true }))
            } else {
                protocol_error(&id, "not_found", &format!("no terminal {terminal_id}"))
            }
        }
        // The models domain runs through a management instance
        // (crates/management-host). Without the packaged spawn config the
        // answer is management_unavailable — never a fallback, never a lie.
        "models.list" => {
            let config = state.management_config.lock().unwrap().clone();
            let Some(config) = config else {
                return protocol_error(&id, "management_unavailable", "the management instance is not configured yet (M3 wiring)");
            };
            let scope = args.get("scope").and_then(Value::as_str).unwrap_or("global");
            match state.management.instance(scope, &config) {
                Ok(instance) => match instance.available_models() {
                    Ok(models) => protocol_ok(&id, models),
                    Err(error) => protocol_error(&id, "io", &error.to_string()),
                },
                Err(error) => protocol_error(&id, "management_unavailable", &error),
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
        other => protocol_error(&id, "unknown_op", &format!("unknown operation {other}")),
    }
}

/// The IPC entry point. The static frontend invokes this with the request
/// envelope; the response envelope is protocol version 1.
#[tauri::command]
pub fn pi_ipc(state: State<'_, IpcHostState>, request: Value) -> Value {
    dispatch_envelope(&state, request)
}

// --- the session view (sessions.get / sessions.context / sessions.state) ---

/// One management-op call: the instance is per-scope on demand (60 s idle
/// recycle), and every failure is (code, message) — never a fallback that
/// would present a disk tail as a live view or an empty context as success.
fn management_call(
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

/// The extension reports failures as "[code] message"; recover the code for
/// the protocol envelope (unknown codes stay io, never success).
fn management_error_code(error: &str) -> (String, String) {
    if let Some((code, rest)) = error.strip_prefix('[').and_then(|body| body.split_once(']')) {
        let code = code.to_string();
        let known = matches!(
            code.as_str(),
            "unknown_op" | "invalid_args" | "not_found" | "op_failed" | "invalid_cron"
        );
        (
            if known { code } else { "io".to_string() },
            rest.trim().to_string(),
        )
    } else {
        ("io".to_string(), error.to_string())
    }
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
        // { running, state } — the /api/agent/[id] GET and
        // /api/sessions/[id]/state contract (both identical).
        "sessions.state" => {
            if let Some(session) = state.registry.get(session_id) {
                session.lease();
                let raw = session
                    .get_state()
                    .map_err(|error| ("agent_child_error".to_string(), error.to_string()))?;
                let machine = session.run_state();
                let model = raw.get("model").cloned().unwrap_or(Value::Null);
                let queued_messages = json!({
                    "steering": machine.steering_queue,
                    "followUp": machine.follow_up_queue,
                });
                let state_json = json!({
                    "sessionId": raw.get("sessionId").cloned().unwrap_or(json!(session_id)),
                    "sessionFile": raw.get("sessionFile").cloned().unwrap_or(Value::Null),
                    "isStreaming": raw.get("isStreaming").and_then(Value::as_bool).unwrap_or(false),
                    "streamingMessage": session.streaming_message_value(),
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
                });
                return Ok(json!({ "running": session.run_state().is_running(), "state": state_json }));
            }
            // Not running: the on-disk existence check answers not_found
            // exactly like the route (never an invented empty state).
            if session_host::history::find_session_by_id(&agent_dir, session_id).is_none() {
                return Err(("not_found".to_string(), format!("Session not found: {session_id}")));
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


/// Epoch ms → ISO-8601 Zulu (the catalogue's created/modified strings).
fn ms_to_iso(ms: i64) -> String {
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
        IpcHostState::new()
    }

    fn send(state: &IpcHostState, request: Value) -> Value {
        dispatch_envelope(state, request)
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
            json!({ "v": 1, "id": "cat1", "op": "sessions.catalogue" }),
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
        // No cwd: fine (the shell's default).
        let bare = send(
            &state,
            json!({ "v": 1, "id": "tc1", "op": "terminal.create", "args": { "id": "t-a" } }),
        );
        assert_eq!(bare["ok"], true, "{bare}");
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
    }

    #[test]
    fn agent_commands_refuse_unknown_types_and_bad_shapes() {
        let state = state();
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
        // Host-level commands refuse with not_supported (never a blind
        // forward into a child).
        let host_level = send(
            &state,
            json!({ "v": 1, "id": "c2c", "op": "agent.command", "args": { "session": "ghost", "type": "fork" } }),
        );
        assert_eq!(host_level["error"]["code"], "not_supported", "{host_level}");
    }

    #[test]
    fn models_ops_answer_management_unavailable_until_configured() {
        let state = state();
        // Deterministic: never depend on whether this machine's resources/pi
        // happened to be staged (release CI stages it).
        *state.management_config.lock().unwrap() = None;
        let response = send(&state, json!({ "v": 1, "id": "m1", "op": "models.list" }));
        assert_eq!(response["ok"], false, "{response}");
        assert_eq!(response["error"]["code"], "management_unavailable");
        assert_eq!(response["error"]["retryable"], false);
    }

    #[test]
    fn terminal_roundtrip_over_the_dispatch_table() {
        let state = state();
        let create = send(
            &state,
            json!({ "v": 1, "id": "t1", "op": "terminal.create", "args": { "id": "term-1", "cols": 80, "rows": 24 } }),
        );
        assert_eq!(create["ok"], true, "{create}");
        // Idempotent create: the same id answers again (the running PTY).
        let again = send(
            &state,
            json!({ "v": 1, "id": "t2", "op": "terminal.create", "args": { "id": "term-1" } }),
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
        *state.spawn_config.lock().unwrap() = None;
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
        let (file, file_id) = session_host::create_session_file(&sessions, &cwd).expect("create");

        let state = state();
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        *state.spawn_config.lock().unwrap() = Some(session_host::SessionSpawnConfig {
            executable,
            agent_dir: Some(agent_dir),
            session_dir: Some(sessions),
            bridge_asset: bridge,
            extra_args: Vec::new(),
        });

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
        *state.spawn_config.lock().unwrap() = Some(session_host::SessionSpawnConfig {
            executable,
            agent_dir: Some(agent_dir),
            session_dir: Some(sessions),
            bridge_asset: bridge,
            extra_args: Vec::new(),
        });

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
        *state.spawn_config.lock().unwrap() = Some(session_host::SessionSpawnConfig {
            executable: executable.clone(),
            agent_dir: Some(agent_dir.clone()),
            session_dir: Some(sessions.clone()),
            bridge_asset: std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs")
                .canonicalize()
                .expect("bridge asset"),
            extra_args: Vec::new(),
        });
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
}