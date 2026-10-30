//! The `/pi-web:bridge` request/reply channel — the Rust port of the bridge
//! parts of `lib/pi-rpc/core.ts`.
//!
//! pi 1.4.0 has no RPC for host-state queries (tool lists, live switching,
//! subagent fleet control), so the shipped bridge extension registers the
//! command `pi-web:bridge`; the host sends
//! `/pi-web:bridge <requestId> <base64url-json>` as a prompt (a registered
//! extension command — no run starts, the tokens never become model input)
//! and the child answers with ONE `PI_WEB_BRIDGE_V1 <json>` notify carrying
//! `{sid, rid, nonce, ok, result|error, code}`. The result envelope bypasses
//! the pre-attach UI window (pi never blocks on a notify); every other notify
//! is plain user-facing text and is forwarded to the relay channel.
//!
//! `disposition: "handled"` on the prompt ack is NOT success: a request
//! resolves only on the child's `{ok, result}` envelope, so a lost, late or
//! mismatched answer rejects (never a silent success). The ack and the result
//! are independent channels; whichever settles the request first decides, and
//! a failing ack only wins when no result arrived (see core.ts's race).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};

use crate::client::PiRpcClient;
use crate::error::PiRpcError;

/// The command the child's bridge extension registers for host state requests.
pub const BRIDGE_COMMAND: &str = "pi-web:bridge";
/// The result-channel marker; the shipped asset uses the same bytes.
pub const BRIDGE_RESULT_PREFIX: &str = "PI_WEB_BRIDGE_V1 ";
/// Default bridge request timeout.
pub const BRIDGE_TIMEOUT: Duration = Duration::from_secs(30);
/// Extra headroom for the prompt ack beyond the result deadline.
const ACK_HEADROOM: Duration = Duration::from_secs(10);

/// Error type for bridge requests.
#[derive(Debug)]
pub enum BridgeError {
    /// Transport fault (child exit, timeout, spawn trouble, shutdown).
    Transport(PiRpcError),
    /// The child answered `{ok: false}`.
    Op(BridgeOpError),
    /// The envelope was malformed, mismatched or never arrived.
    Protocol(String),
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BridgeError::Transport(error) => write!(f, "{error}"),
            BridgeError::Op(error) => write!(f, "{error}"),
            BridgeError::Protocol(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for BridgeError {}

impl BridgeError {
    pub fn protocol(message: impl Into<String>) -> Self {
        BridgeError::Protocol(message.into())
    }
}

/// A bridge op the child refused, carrying its machine-readable code (the
/// Rust twin of core.ts's BridgeOpError).
#[derive(Debug, Clone)]
pub struct BridgeOpError {
    pub op: String,
    pub message: String,
    pub code: Option<String>,
}

impl std::fmt::Display for BridgeOpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "pi-web bridge '{}' failed: {}", self.op, self.message)?;
        if let Some(code) = &self.code {
            write!(f, " (code {code})")?;
        }
        Ok(())
    }
}

impl std::error::Error for BridgeOpError {}

struct BridgePending {
    op: String,
    tx: std::sync::mpsc::Sender<Result<Value, BridgeError>>,
}

struct BridgeState {
    pending: HashMap<String, BridgePending>,
    /// Set when the client died; every later request fails fast.
    transport_fatal: Option<PiRpcError>,
}

/// The bridge channel over one live client. Create with [`Bridge::attach`].
pub struct Bridge {
    client: Arc<PiRpcClient>,
    session_id: String,
    nonce: String,
    timeout: Duration,
    state: Arc<Mutex<BridgeState>>,
    /// Plain (non-bridge) notifies from the child, for the relay to show.
    plain_notify_rx: Mutex<Option<std::sync::mpsc::Receiver<Value>>>,
    request_counter: AtomicU64,
}

impl Bridge {
    /// Attach the bridge channel: owns the `notify` UI method (bridge
    /// envelopes bypass the pre-attach window), routes envelopes to pending
    /// requests and settles everything when the child exits.
    pub fn attach(client: Arc<PiRpcClient>, session_id: String, nonce: String) -> Arc<Self> {
        Self::attach_with_timeout(client, session_id, nonce, BRIDGE_TIMEOUT)
    }

    pub fn attach_with_timeout(
        client: Arc<PiRpcClient>,
        session_id: String,
        nonce: String,
        timeout: Duration,
    ) -> Arc<Self> {
        let state = Arc::new(Mutex::new(BridgeState { pending: HashMap::new(), transport_fatal: None }));
        let (notify_tx, notify_rx) = std::sync::mpsc::channel::<crate::client::UiRequest>();
        // Bridge envelopes bypass the startup window's queue: they are
        // host-internal — rid-correlated, nonce/session-verified below — and
        // pi never blocks on a notify. A PLAIN notify never matches the
        // predicate and keeps the ordinary ordered replay.
        let bypass: Arc<dyn Fn(&Value) -> bool + Send + Sync> = Arc::new(|record: &Value| {
            record
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(|message| message.starts_with(BRIDGE_RESULT_PREFIX))
        });
        let _notify_subscription = client.on_ui("notify", notify_tx, Some(bypass));
        // Hold the subscription for the Bridge's lifetime (detached on drop).
        std::mem::forget(_notify_subscription);

        let router_state = Arc::clone(&state);
        let router_session = session_id.clone();
        let router_nonce = nonce.clone();
        let (relay_tx, relay_rx) = std::sync::mpsc::channel::<Value>();
        let router = std::thread::Builder::new()
            .name("pi-bridge-router".into())
            .spawn(move || {
                // The sender lives in the client's handler map (held for the
                // client's lifetime); when it detaches, recv ends the router.
                while let Ok(request) = notify_rx.recv() {
                    let record = request.record;
                    let message = record.get("message").and_then(Value::as_str).unwrap_or("");
                    if !message.starts_with(BRIDGE_RESULT_PREFIX) {
                        // A plain notify is an ordinary user-facing message.
                        let _ = relay_tx.send(record);
                        continue;
                    }
                    handle_bridge_envelope(
                        &router_state,
                        &router_session,
                        &router_nonce,
                        &message[BRIDGE_RESULT_PREFIX.len()..],
                    );
                }
            })
            .expect("pi bridge router thread");
        let _ = router;

        // Settle everything when the child exits.
        let exit_state = Arc::clone(&state);
        let exit_rx = client.on_process_exit();
        std::thread::Builder::new()
            .name("pi-bridge-exit".into())
            .spawn(move || {
                let Ok(code) = exit_rx.recv() else { return };
                let mut state = exit_state.lock().unwrap();
                let error = PiRpcError::exit(format!(
                    "pi process exited during a bridge request (code {})",
                    code.map(|code| code.to_string()).unwrap_or_else(|| "?".to_string())
                ));
                state.transport_fatal = Some(error.clone());
                for (_, pending) in state.pending.drain() {
                    let _ = pending.tx.send(Err(BridgeError::Transport(error.clone())));
                }
            })
            .expect("pi bridge exit thread");

        Arc::new(Self {
            client,
            session_id,
            nonce,
            timeout,
            state,
            plain_notify_rx: Mutex::new(Some(relay_rx)),
            request_counter: AtomicU64::new(0),
        })
    }

    /// Take the receiver for plain (non-bridge) notifies; the relay shows
    /// them like any other fire-and-forget child UI.
    pub fn take_plain_notify_rx(&self) -> Option<std::sync::mpsc::Receiver<Value>> {
        self.plain_notify_rx.lock().unwrap().take()
    }

    /// The session id every envelope must name.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// One host→child state request over the bridge command. `disposition:
    /// "handled"` alone is NOT success — the promise resolves only on the
    /// child's `{ok, result}` envelope.
    pub fn request(
        &self,
        op: &str,
        args: Option<Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, BridgeError> {
        let timeout = timeout.unwrap_or(self.timeout);
        let request_id = format!(
            "pwb-rust-{}-{}",
            self.request_counter.fetch_add(1, Ordering::Relaxed) + 1,
            uuid::Uuid::new_v4()
        );
        // The op and the session nonce are the host's, not the caller's: they
        // are written AFTER the args spread so no argument can retarget the
        // operation or replay another session's request.
        let mut payload = match args {
            Some(value) if value.is_object() => value,
            _ => json!({}),
        };
        payload["op"] = json!(op);
        payload["nonce"] = json!(self.nonce);
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).expect("payload is serializable"));
        let message = format!("/{BRIDGE_COMMAND} {request_id} {token}");

        let (tx, rx) = std::sync::mpsc::channel::<Result<Value, BridgeError>>();
        {
            let mut state = self.state.lock().unwrap();
            if let Some(error) = &state.transport_fatal {
                return Err(BridgeError::Transport(error.clone()));
            }
            state.pending.insert(request_id.clone(), BridgePending { op: op.to_string(), tx });
        }

        // Two settling sources: the result envelope and the prompt ack. The
        // ack only says the message was an extension command; the result is
        // the operation's answer. Whichever settles first decides (core.ts's
        // race); the loser is discarded.
        enum Event {
            Result(Result<Value, BridgeError>),
            Ack(Result<Value, PiRpcError>),
        }
        let (event_tx, event_rx) = std::sync::mpsc::channel::<Event>();
        let result_event_tx = std::sync::mpsc::Sender::clone(&event_tx);
        let result_forward = std::thread::Builder::new()
            .name("pi-bridge-result".into())
            .spawn({
                let rx = rx;
                move || {
                    if let Ok(result) = rx.recv() {
                        let _ = result_event_tx.send(Event::Result(result));
                    }
                }
            })
            .expect("pi bridge result thread");
        let _ = result_forward;
        let ack_client = Arc::clone(&self.client);
        let ack_event_tx = std::sync::mpsc::Sender::clone(&event_tx);
        let ack_forward = std::thread::Builder::new()
            .name("pi-bridge-ack".into())
            .spawn(move || {
                let ack = ack_client.command("prompt", json!({ "message": message }), Some(timeout + ACK_HEADROOM));
                let _ = ack_event_tx.send(Event::Ack(ack));
            })
            .expect("pi bridge ack thread");
        let _ = ack_forward;

        let deadline = Instant::now() + timeout;
        loop {
            // core.ts's result timer is the floor for every wait below: the
            // deadline settles the request even after a handled ack.
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.remove_pending(&request_id);
                return Err(BridgeError::Transport(PiRpcError::timeout(format!(
                    "pi-web bridge '{op}' did not answer within {} ms",
                    timeout.as_millis()
                ))));
            }
            let event = match event_rx.recv_timeout(remaining) {
                Ok(event) => event,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    self.remove_pending(&request_id);
                    return Err(BridgeError::protocol(format!(
                        "pi-web bridge '{op}' did not answer within {} ms",
                        timeout.as_millis()
                    )));
                }
            };
            match event {
                Event::Result(result) => {
                    self.remove_pending(&request_id);
                    return result;
                }
                Event::Ack(Ok(response)) => {
                    let disposition = response.get("disposition").and_then(Value::as_str);
                    if disposition != Some("handled") {
                        self.remove_pending(&request_id);
                        return Err(BridgeError::protocol(format!(
                            "pi-web bridge '{op}': the child did not treat the message as an extension command (disposition {disposition:?}); refusing to guess the result"
                        )));
                    }
                    // A handled ack with no reply yet: the result deadline (or
                    // child exit) is the floor. The child normally notifies
                    // before the ack.
                }
                Event::Ack(Err(error)) => {
                    // The ack broke before any reply. A result that arrived
                    // meanwhile still explains itself first; otherwise the
                    // ack error is the diagnosable reason.
                    if let Ok(Event::Result(result)) = event_rx.try_recv() {
                        self.remove_pending(&request_id);
                        return result;
                    }
                    self.remove_pending(&request_id);
                    return Err(BridgeError::Transport(error));
                }
            }
        }
    }

    fn remove_pending(&self, request_id: &str) {
        self.state.lock().unwrap().pending.remove(request_id);
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // Pending requests must not wait for their timers: everything still
        // in flight gets an immediate, diagnosable reject.
        let mut state = self.state.lock().unwrap();
        for (_, pending) in state.pending.drain() {
            let _ = pending.tx.send(Err(BridgeError::protocol(format!(
                "pi-web bridge '{}' was cancelled: the session is being disposed",
                pending.op
            ))));
        }
    }
}

fn handle_bridge_envelope(state: &Mutex<BridgeState>, session_id: &str, nonce: &str, body: &str) {
    let fail = |state: &Mutex<BridgeState>, request_id: &str, error: BridgeError| {
        let mut state = state.lock().unwrap();
        if let Some(pending) = state.pending.remove(request_id) {
            let _ = pending.tx.send(Err(error));
        }
    };
    let parsed: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        // An unparseable result carries no rid to correlate: drop it (never
        // a user-facing notification, never a success for anyone). The
        // request's own timer is the floor.
        Err(_) => return,
    };
    if !parsed.is_object() {
        return;
    }
    let request_id = parsed.get("rid").and_then(Value::as_str).map(str::to_string);
    let Some(request_id) = request_id else { return };
    let Some(pending) = state.lock().unwrap().pending.get(&request_id).map(|p| p.op.clone()) else {
        // Not ours (a stale reply, or a user typing the command by hand):
        // never a user-facing notification, and never a success for anyone.
        return;
    };
    if parsed.get("nonce").and_then(Value::as_str) != Some(nonce) {
        fail(
            state,
            &request_id,
            BridgeError::protocol(format!(
                "pi-web bridge '{pending}' answered with the wrong session nonce"
            )),
        );
        return;
    }
    if parsed.get("sid").and_then(Value::as_str) != Some(session_id) {
        fail(
            state,
            &request_id,
            BridgeError::protocol(format!(
                "pi-web bridge '{pending}' answered for session {} instead of {session_id}",
                serde_json::to_string(&parsed.get("sid").cloned().unwrap_or(Value::Null))
                    .unwrap_or_else(|_| "\"?\"".to_string())
            )),
        );
        return;
    }
    let mut state = state.lock().unwrap();
    if let Some(pending) = state.pending.remove(&request_id) {
        if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
            let result = parsed.get("result").cloned().unwrap_or(Value::Null);
            let _ = pending.tx.send(Ok(result));
        } else {
            let message = parsed
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string();
            let code = parsed.get("code").and_then(Value::as_str).map(str::to_string);
            let _ = pending.tx.send(Err(BridgeError::Op(BridgeOpError {
                op: pending.op.clone(),
                message,
                code,
            })));
        }
    }
}

/// Whether a command list attributes the bridge command to the SHIPPED asset
/// (by source path, not just the name — a same-named command from any other
/// extension is NOT the bridge).
pub fn find_bridge_commands(commands: &Value, asset_path: &std::path::Path) -> Vec<String> {
    let mut names = Vec::new();
    let Some(list) = commands.get("commands").and_then(Value::as_array) else { return names };
    for command in list {
        let Some(name) = command.get("name").and_then(Value::as_str) else { continue };
        if !name.starts_with("pi-web:") {
            continue;
        }
        if command.get("source").and_then(Value::as_str) != Some("extension") {
            continue;
        }
        let Some(path) = command.get("sourceInfo").and_then(|info| info.get("path")).and_then(Value::as_str)
        else {
            continue;
        };
        if same_extension_path(path, asset_path) {
            names.push(name.to_string());
        }
    }
    names
}

/// Compare an extension source path with the shipped asset, tolerating the
/// platform's separator/case rules and symlinked module layouts.
pub fn same_extension_path(reported: &str, shipped: &std::path::Path) -> bool {
    let normalize = |value: &str| -> String {
        let candidate = value.replace('\\', "/");
        let candidate = std::fs::canonicalize(&candidate)
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .unwrap_or(candidate);
        if cfg!(windows) {
            candidate.to_lowercase()
        } else {
            candidate
        }
    };
    normalize(reported) == normalize(&shipped.to_string_lossy())
}
