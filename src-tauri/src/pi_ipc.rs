//! The `pi_ipc` Tauri command: the single IPC entry the static frontend
//! calls (docs/migration/ipc-protocol.md). One request envelope in, one
//! response envelope out; stream subscriptions arrive as follow-up events
//! on the same call's channel from M2's session streams.
//!
//! Closed operation surface: the op table here is exhaustive — unknown
//! operations answer `unknown_op` without touching any session child.

use base64::Engine;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;

use management_host::{ManagementHost, ManagementSpawnConfig};
use session_host::{SessionRegistry, SessionSpawnConfig};

/// Terminal output frames carry base64 inside JSON Channels today; the
/// raw-bytes upgrade (protocol doc §4) lands with the M4 binary channel.

/// Protocol version (must match static-frontend/src/ipc/protocol.ts and
/// docs/migration/ipc-protocol.md).
pub const IPC_PROTOCOL_VERSION: i64 = 1;

/// The managed host state (one registry per app process).
pub struct IpcHostState {
    pub registry: SessionRegistry,
    /// The spawn config is resolved at first use (M2 wires the packaged pi
    /// executable and asset paths here); identity operations answer before
    /// any child exists. Read by the session-start wiring that lands with
    /// the operation set that spawns children.
    #[allow(dead_code)]
    pub spawn_config: std::sync::Mutex<Option<SessionSpawnConfig>>,
    subscription_counter: AtomicU64,
    /// The terminal registry (portable-pty; crates/pty-host).
    pub terminals: pty_host::PtyHost,
    /// The management instances (crates/management-host). The spawn config
    /// (packaged pi executable + the vendored management extension) is
    /// resolved by the M3 wiring; until then the models ops answer
    /// management_unavailable rather than pretending.
    pub management: ManagementHost,
    pub management_config: std::sync::Mutex<Option<ManagementSpawnConfig>>,
}

impl IpcHostState {
    pub fn new() -> Self {
        Self {
            registry: SessionRegistry::new(),
            spawn_config: std::sync::Mutex::new(None),
            subscription_counter: AtomicU64::new(0),
            terminals: pty_host::PtyHost::new(),
            management: ManagementHost::new(),
            management_config: std::sync::Mutex::new(None),
        }
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
/// events follow in arrival order with monotonic seq. The subscription
/// ends when the receiver drops the channel (page reload, window close) or
/// the session leaves the registry; the relay thread then detaches.
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
    let events = session_handle.subscribe();

    // The relay: snapshot first, then every record in order. A closed
    // channel (send error) ends the loop and detaches.
    std::thread::Builder::new()
        .name(format!("ipc-events-{subscription_id}"))
        .spawn(move || {
            let subscription_id = subscription_id_for_relay;
            let mut seq: u64 = 0;
            let snapshot = json!({
                "epoch": session_handle.epoch(),
                "settledEpoch": session_handle.machine_settled_epoch(),
                "state": session_run_state_json(&session_handle),
            });
            seq += 1;
            if on_event.send(stream_frame(&subscription_id, epoch, seq, "snapshot", snapshot)).is_err() {
                return;
            }
            while let Ok(record) = events.recv() {
                seq += 1;
                if on_event
                    .send(stream_frame(&subscription_id, epoch, seq, "event", record))
                    .is_err()
                {
                    return;
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
        "sessions.list" | "sessions.runState" | "agent.interrupt" | "agent.setSessionName" | "agent.runState"
        | "agent.eventsSnapshot" => {
            match session_host::dispatch_session_op(&state.registry, op, &args) {
                Ok(data) => protocol_ok(&id, data),
                Err(error) => protocol_error(&id, error.code(), &error.to_string()),
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
            let cwd = args.get("cwd").and_then(Value::as_str).map(std::path::PathBuf::from);
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
    fn models_ops_answer_management_unavailable_until_configured() {
        let state = state();
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
}
