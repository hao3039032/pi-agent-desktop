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
    Some(ManagementSpawnConfig {
        executable: executable.to_string_lossy().into_owned(),
        agent_dir: None,
        extensions: vec![extension],
        env: Vec::new(),
    })
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
        "sessions.runState" | "agent.interrupt" | "agent.setSessionName" | "agent.runState"
        | "agent.eventsSnapshot" | "agent.command" => {
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
        "files.read" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or_default();
            let target = PathBuf::from(path);
            let allowed = {
                let roots = state.file_roots.lock().unwrap();
                // An existing file authorizes through itself (resolved
                // containment); a not-yet-existing path through its parent.
                if target.exists() {
                    roots.is_existing_path_allowed(&target)
                } else {
                    roots.is_new_path_allowed(&target)
                }
            };
            if !allowed {
                return protocol_error(&id, "unauthorized_scope", "the path is outside the allowed roots");
            }
            match std::fs::read(&target) {
                Ok(bytes) => protocol_ok(
                    &id,
                    json!({
                        "mime": crate::file_access::mime_for(&target),
                        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                    }),
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    protocol_error(&id, "not_found", "no such file")
                }
                Err(error) => protocol_error(&id, "io", &error.to_string()),
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
            // An existing file authorizes through its RESOLVED self (a
            // symlink pointing outside is refused); a new file through its
            // resolved PARENT (never a lexical pass — the write would follow
            // a symlinked final component outside the roots).
            let allowed = {
                let roots = state.file_roots.lock().unwrap();
                if target.exists() {
                    roots.is_existing_path_allowed(&target)
                } else {
                    roots.is_new_path_allowed(&target)
                }
            };
            if !allowed {
                return protocol_error(&id, "unauthorized_scope", "the path is outside the allowed roots");
            }
            match std::fs::write(&target, data) {
                Ok(()) => protocol_ok(&id, json!({ "written": path })),
                Err(error) => protocol_error(&id, "io", &error.to_string()),
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
}
