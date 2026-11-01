//! # provider_auth — the provider sign-in domain's host wiring
//!
//! The IPC arms for the Models panel's provider authentication surface
//! (the api-inventory mapping's `auth.*` ops). The COMPOSITIONS live in the
//! management instance — the repo's own
//! `lib/provider-auth-service.server.ts`, bundled by
//! `scripts/migration/build-management-modules.mjs` — exactly what the Next
//! `/api/auth/*` routes serve; this module only gates the closed envelope
//! (provider / apiKey shapes, with the seam's own error vocabulary) and
//! routes the call to the GLOBAL management instance (the routes read no
//! cwd scope; extension-registered providers load from the agent dir).
//!
//! Shaped refusals ride the error message verbatim (the routes' 400/409
//! bodies): the code enum stays the extension's reason
//! (`credential_type_mismatch` etc.), which the host carries because the UI
//! renders the message, never a status code.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;

use crate::pi_ipc::IpcHostState;

/// How long the API-key store's login dance may take: the provider's own
/// `apiKey.login()` (offline prompt shim) plus the credential write. The
/// default management minute would cut a slow provider validation in half.
const API_KEY_STORE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

// --- the OAuth login stream -------------------------------------------------
//
// The old GET /api/auth/login/[provider] SSE stream, over a Tauri Channel:
// the login runs detached INSIDE the management instance (its prompts and
// notifications buffer as the SSE event shapes — see
// lib/provider-auth-login.server.ts), and this relay polls them out by
// sequence and forwards every frame. Events and the stream contract are the
// plan's §四 stream rules: monotonic seq per subscription, an atomic first
// frame, and release on unsubscribe/page reload.

/// The login relay's cadence. Each poll is a full management call whose
/// end-of-call touch keeps the instance lease fresh for the flow's whole
/// lifetime — that IS the login's activity lease (no shared-crates change).
const LOGIN_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// One poll's bound. A poll is an idempotent READ, so a stolen result
/// envelope (the known on_ui single-slot race between concurrent management
/// calls — see the notify-router work) costs one 5s gap and a retry, never a
/// false failure and never a resent mutation. Raise once the router lands.
const LOGIN_POLL_TIMEOUT: Duration = Duration::from_secs(5);

/// Consecutive failed polls before the stream reports "Connection lost"
/// (the old SSE stream's error semantics when the server dropped).
const LOGIN_POLL_MAX_FAILURES: u32 = 3;

/// The whole flow's backstop deadline (the old SSE stream lived as long as
/// the login did; a stuck provider flow still ends).
const LOGIN_FLOW_DEADLINE: Duration = Duration::from_secs(600);
const LOGIN_ACK_TIMEOUT: Duration = Duration::from_secs(15);
const LOGIN_HEARTBEAT: Duration = Duration::from_secs(10);
const LOGIN_MAX_RELAYS: usize = 8;
const LOGIN_MAX_TASKS: usize = 128;
const LOGIN_MAX_FRAME_BYTES: usize = 64 * 1024;

/// Host-side login-flow + subscription ids (correlation keys, not security
/// tokens — the handshake tokens are crypto-random inside the extension).
static LOGIN_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Handle that ends one login-stream relay on unsubscribe.
pub(crate) struct LoginRelayHandle {
    pub stop: Arc<AtomicBool>,
    /// The flow this observer follows.
    pub flow_id: String,
    /// The management task handle for explicit cancellation and input.
    pub task_handle: String,
    pub tokens: std::collections::HashSet<String>,
    ack: Arc<crate::pi_ipc::SessionRelayAck>,
}

struct LoginTask {
    provider: String,
    task_handle: String,
    instance: Arc<management_host::ManagementInstance>,
}

struct FrameSize(usize);
impl std::io::Write for FrameSize {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.checked_add(bytes.len()).filter(|size| *size <= LOGIN_MAX_FRAME_BYTES)
            .ok_or_else(|| std::io::Error::other("login frame too large"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

fn recovery_interactions(snapshot: &Value) -> Option<(Vec<Value>, std::collections::HashSet<String>, u64)> {
    let events = snapshot.get("currentInteraction")?.as_array()?;
    let last = snapshot.get("lastSeq")?.as_u64()?;
    if events.len() > 16 { return None; }
    let payload = json!({ "events": events });
    let mut counter = FrameSize(4 * 1024);
    if serde_json::to_writer(&mut counter, &payload).is_err() { return None; }
    let mut tokens = std::collections::HashSet::new();
    for event in events {
        match event.get("type")?.as_str()? {
            "auth" | "prompt_request" | "select_request" => {
                let token = event.get("token")?.as_str()?;
                if token.is_empty() || token.len() > 512 { return None; }
                let shape_ok = match event["type"].as_str()? {
                    "auth" => event.get("url").is_some_and(Value::is_string) && event.get("instructions").is_some_and(|v| v.is_null() || v.is_string()),
                    "prompt_request" => event.get("message").is_some_and(Value::is_string) && event.get("placeholder").is_some_and(|v| v.is_null() || v.is_string()),
                    "select_request" => event.get("message").is_some_and(Value::is_string) && event.get("options").and_then(Value::as_array)
                        .is_some_and(|options| options.iter().all(|option| option.get("id").is_some_and(Value::is_string) && option.get("label").is_some_and(Value::is_string))),
                    _ => false,
                };
                if !shape_ok { return None; }
                tokens.insert(token.to_string());
            }
            "device_code" if event.get("userCode").is_some_and(Value::is_string) && event.get("verificationUri").is_some_and(Value::is_string) => {}
            _ => return None,
        }
    }
    Some((events.clone(), tokens, last))
}

struct RelaySlot(Arc<AtomicUsize>);
impl Drop for RelaySlot {
    fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); }
}

// Retain the reservation through registration cleanup, including unwinding and
// failed thread creation. A poisoned registry remains uninspectable to reports.
struct LoginRegistration {
    relays: Arc<LoginRelays>,
    id: String,
    _slot: RelaySlot,
    _permit: Arc<tokio::sync::OwnedSemaphorePermit>,
}
impl Drop for LoginRegistration {
    fn drop(&mut self) {
        let mut relays = match self.relays.relays.lock() {
            Ok(relays) => relays,
            Err(poisoned) => poisoned.into_inner(),
        };
        relays.remove(&self.id);
    }
}

/// The login-stream relays by subscription id (pi_ipc's event_relays
/// pattern, this domain's own map so the shared one stays untouched).
pub(crate) struct LoginRelays {
    pub(crate) relays: Mutex<BTreeMap<String, LoginRelayHandle>>,
    tasks: Mutex<BTreeMap<String, LoginTask>>,
    alive: Arc<AtomicUsize>,
    gate: Arc<tokio::sync::Semaphore>,
    shutdown: Arc<AtomicBool>,
}

impl Default for LoginRelays {
    fn default() -> Self {
        Self { relays: Mutex::new(BTreeMap::new()), tasks: Mutex::new(BTreeMap::new()),
            alive: Arc::new(AtomicUsize::new(0)), gate: Arc::new(tokio::sync::Semaphore::new(LOGIN_MAX_RELAYS)),
            shutdown: Arc::new(AtomicBool::new(false)) }
    }
}

impl LoginRelays {
    pub(crate) fn begin_shutdown(&self) {
        self.gate.close();
        self.shutdown.store(true, Ordering::SeqCst);
    }
    pub(crate) fn shutdown_status(&self) -> crate::pi_ipc::RelayShutdownStatus {
        crate::pi_ipc::RelayShutdownStatus {
            in_flight: LOGIN_MAX_RELAYS - self.gate.available_permits(),
            registry_busy: self.relays.try_lock().is_err() || self.tasks.try_lock().is_err(),
        }
    }
    fn reserve(&self) -> Result<Arc<tokio::sync::OwnedSemaphorePermit>, String> {
        Arc::clone(&self.gate).try_acquire_owned().map(Arc::new)
            .map_err(|_| "login observer capacity exhausted or closed".to_string())
    }
    pub fn cancel(&self, subscription_id: &str) -> Option<LoginRelayHandle> {
        self.relays.lock().unwrap().remove(subscription_id)
    }

    fn insert(&self, subscription_id: &str, handle: LoginRelayHandle) {
        self.relays.lock().unwrap().insert(subscription_id.to_string(), handle);
    }

    pub fn acknowledge(&self, id: &str, epoch: u64, seq: u64) -> bool {
        epoch == 1 && self.relays.lock().unwrap().get(id)
            .is_some_and(|relay| relay.ack.acknowledge(seq))
    }
}

/// The closed envelope of every `auth.*` op's provider argument: a non-empty
/// string, bounded so a hostile caller cannot smuggle an oversized id into a
/// path or a prompt. (The seam's vocabulary: the composition's own gate.)
fn validated_provider_arg(args: &Value) -> Result<String, String> {
    let provider = args.get("provider").and_then(Value::as_str).unwrap_or("");
    if provider.is_empty() || provider.len() > 200 {
        return Err("provider is required".to_string());
    }
    Ok(provider.to_string())
}

/// The closed envelope of `auth.apiKeyStore`'s key: the route's own 400
/// message ("apiKey is required") for anything unusable, bounded so a key is
/// never an unbounded payload (real keys are far shorter).
fn validated_api_key_arg(args: &Value) -> Result<String, String> {
    let api_key = args.get("apiKey").and_then(Value::as_str).unwrap_or("");
    if api_key.trim().is_empty() || api_key.len() > 8192 {
        return Err("apiKey is required".to_string());
    }
    Ok(api_key.to_string())
}

/// One non-empty, bounded string field (tokens, codes, flow ids — all
/// host-generated or crypto-random strings with no business meaning to
/// validate beyond their shape).
fn string_arg(args: &Value, key: &str) -> Result<String, String> {
    let value = args.get(key).and_then(Value::as_str).unwrap_or("");
    if value.is_empty() || value.len() > 512 {
        return Err(format!("{key} is required"));
    }
    Ok(value.to_string())
}

/// One global-scope management call with the caller's bound.
fn management_call_bounded(
    state: &IpcHostState,
    op: &str,
    args: Value,
    timeout: std::time::Duration,
) -> Result<Value, (String, String)> {
    let config = state.management_config.lock().unwrap().clone();
    let Some(config) = config else {
        return Err((
            "management_unavailable".to_string(),
            "the management instance is not configured (the vendored module tree is missing)"
                .to_string(),
        ));
    };
    let instance = state
        .management
        .instance("global", &config)
        .map_err(|error| ("management_unavailable".to_string(), error))?;
    instance
        .management_call(op, args, timeout)
        .map_err(|error| crate::pi_ipc::management_error_code(&error))
}

/// The `auth.*` request/response arms (`auth.loginStream`'s stream has its
/// own command; see [`login_stream_command`]). Returns `None` for ops this
/// module does not own so the dispatcher can refuse them as unknown.
pub fn dispatch(state: &IpcHostState, op: &str, id: &str, args: &Value) -> Option<Value> {
    match op {
        // GET /api/auth/providers: both auth lists, capability-driven, with
        // no credential material (the composition never emits secrets).
        "auth.providers" => Some(
            match management_call_bounded(state, "auth.providers", json!({}), std::time::Duration::from_secs(60)) {
                Ok(lists) => crate::pi_ipc::protocol_ok(id, lists),
                Err((code, message)) => crate::pi_ipc::protocol_error(id, &code, &message),
            },
        ),
        // POST /api/auth/api-key/[provider]: the headless login + the
        // direct credential store (never the catalog-refresh path).
        "auth.apiKeyStore" => {
            let (provider, api_key) = match (validated_provider_arg(args), validated_api_key_arg(args)) {
                (Ok(provider), Ok(api_key)) => (provider, api_key),
                (Err(message), _) | (_, Err(message)) => {
                    return Some(crate::pi_ipc::protocol_error(id, "invalid_args", &message));
                }
            };
            Some(
                match management_call_bounded(
                    state,
                    "auth.apiKeyStore",
                    json!({ "provider": provider, "apiKey": api_key }),
                    API_KEY_STORE_TIMEOUT,
                ) {
                    Ok(result) => crate::pi_ipc::protocol_ok(id, result),
                    Err((code, message)) => crate::pi_ipc::protocol_error(id, &code, &message),
                },
            )
        }
        // DELETE /api/auth/api-key/[provider]: the type-gated remove — an
        // OAuth credential refuses with the route's 409 message.
        "auth.apiKeyDelete" => {
            let provider = match validated_provider_arg(args) {
                Ok(provider) => provider,
                Err(message) => {
                    return Some(crate::pi_ipc::protocol_error(id, "invalid_args", &message));
                }
            };
            Some(
                match management_call_bounded(
                    state,
                    "auth.apiKeyDelete",
                    json!({ "provider": provider }),
                    std::time::Duration::from_secs(60),
                ) {
                    Ok(result) => crate::pi_ipc::protocol_ok(id, result),
                    Err((code, message)) => crate::pi_ipc::protocol_error(id, &code, &message),
                },
            )
        }
        // POST /api/auth/logout/[provider]: the OAuth-method gate plus the
        // type-gated remove.
        "auth.logout" => {
            let provider = match validated_provider_arg(args) {
                Ok(provider) => provider,
                Err(message) => {
                    return Some(crate::pi_ipc::protocol_error(id, "invalid_args", &message));
                }
            };
            Some(
                match management_call_bounded(
                    state,
                    "auth.logout",
                    json!({ "provider": provider }),
                    std::time::Duration::from_secs(60),
                ) {
                    Ok(result) => crate::pi_ipc::protocol_ok(id, result),
                    Err((code, message)) => crate::pi_ipc::protocol_error(id, &code, &message),
                },
            )
        }
        // POST /api/auth/login/[provider]'s body: deliver code or prompt answer
        // to the active login task via the task-associated control channel (submit_task_input),
        // completely bypassing mutation task admission and unknown-outcome scope isolation.
        "auth.loginManualCode" | "auth.loginSubmit" => {
            let (provider, token, code) =
                match (validated_provider_arg(args), string_arg(args, "token"), string_arg(args, "code")) {
                    (Ok(provider), Ok(token), Ok(code)) => (provider, token, code),
                    _ => {
                        return Some(crate::pi_ipc::protocol_error(
                            id,
                            "invalid_args",
                            "provider, token and code are required",
                        ));
                    }
                };

            let task_handle = {
                let relays = state.login_relays.relays.lock().unwrap();
                relays.values().find(|h| h.tokens.contains(&token)).map(|h| h.task_handle.clone())
            };

            let Some(task_handle) = task_handle else {
                return Some(crate::pi_ipc::protocol_error(
                    id,
                    "not_found",
                    "No active login task for provider",
                ));
            };

            let config = match state.management_config.lock().unwrap().clone() {
                Some(config) => config,
                None => {
                    return Some(crate::pi_ipc::protocol_error(
                        id,
                        "management_unavailable",
                        "the management instance is not configured",
                    ));
                }
            };
            let instance = match state.management.instance("global", &config) {
                Ok(inst) => inst,
                Err(error) => {
                    return Some(crate::pi_ipc::protocol_error(id, "management_unavailable", &error));
                }
            };

            Some(
                match instance.submit_task_input(
                    &task_handle,
                    json!({ "provider": provider, "token": token, "code": code }),
                ) {
                    Ok(result) => {
                        if let Some(status) = result.get("status").and_then(Value::as_str) {
                            if status != "accepted" {
                                let message = result
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Failed to submit code");
                                let code = if status == "no_pending" { "not_found" } else { "invalid_args" };
                                return Some(crate::pi_ipc::protocol_error(id, code, message));
                            }
                        }
                        crate::pi_ipc::protocol_ok(id, result)
                    }
                    Err(error) => {
                        let (code, message) = crate::pi_ipc::management_error_code(&error);
                        crate::pi_ipc::protocol_error(id, &code, &message)
                    }
                },
            )
        }
        // Explicit user cancellation requests cooperative abort; observer
        // detach does not call this operation. It is not a completion proof.
        "auth.loginCancel" => {
            if let Some(subscription_id) = args.get("subscriptionId").and_then(Value::as_str) {
                if !subscription_id.is_empty() {
                    let task = state.login_relays.relays.lock().unwrap().get(subscription_id).map(|h| h.task_handle.clone());
                    let cancelled = task.and_then(|task| state.management_config.lock().unwrap().clone()
                        .and_then(|config| state.management.instance("global", &config).ok())
                        .map(|instance| instance.cancel_task(&task).is_ok())).unwrap_or(false);
                    return Some(crate::pi_ipc::protocol_ok(id, json!({ "cancelled": cancelled })));
                }
            }
            if let Some(task_handle) = args.get("taskHandle").and_then(Value::as_str) {
                if !task_handle.is_empty() {
                    let tasks = state.login_relays.tasks.lock().unwrap();
                    if let Some(entry) = tasks.values().find(|entry| entry.task_handle == task_handle) {
                        let res = entry.instance.cancel_task(task_handle);
                        return Some(crate::pi_ipc::protocol_ok(id, json!({ "cancelled": res.is_ok() })));
                    }
                    return Some(crate::pi_ipc::protocol_error(id, "not_found", "original login task unavailable"));
                }
            }
            let flow_id = match string_arg(args, "flowId") {
                Ok(flow_id) => flow_id,
                Err(message) => {
                    return Some(crate::pi_ipc::protocol_error(id, "invalid_args", &message));
                }
            };
            let task_handle = {
                let relays = state.login_relays.relays.lock().unwrap();
                relays.values().find(|h| h.flow_id == flow_id).map(|h| h.task_handle.clone())
            };
            if let Some(th) = task_handle {
                if let Some(config) = state.management_config.lock().unwrap().clone() {
                    if let Ok(instance) = state.management.instance("global", &config) {
                        let _ = instance.cancel_task(&th);
                    }
                }
            }
            Some(
                match management_call_bounded(
                    state,
                    "auth.loginCancel",
                    json!({ "flowId": flow_id }),
                    std::time::Duration::from_secs(60),
                ) {
                    Ok(result) => crate::pi_ipc::protocol_ok(id, result),
                    Err((code, message)) => crate::pi_ipc::protocol_error(id, &code, &message),
                },
            )
        }
        _ => None,
    }
}

// --- the OAuth login stream (the pi_ipc_login_stream command) -------------

/// Reserve the observer thread before starting a mutation. It waits for a
/// task binding, then polls and forwards one acknowledged frame at a time.
#[cfg(test)]
fn reserve_login_relay(
    state: &Arc<IpcHostState>,
    subscription_id: String,
    on_event: Channel<Value>,
) -> Result<std::sync::mpsc::SyncSender<(String, String, Arc<management_host::ManagementInstance>)>, String> {
    let permit = state.login_relays.reserve()?;
    reserve_login_relay_with_permit(state, subscription_id, on_event, permit)
}

fn reserve_login_relay_with_permit(
    state: &Arc<IpcHostState>, subscription_id: String, on_event: Channel<Value>,
    permit: Arc<tokio::sync::OwnedSemaphorePermit>,
) -> Result<std::sync::mpsc::SyncSender<(String, String, Arc<management_host::ManagementInstance>)>, String> {
    let relays = Arc::clone(&state.login_relays);
    if relays.shutdown.load(Ordering::SeqCst) { return Err("login observer admission closed".into()); }
    relays.alive.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| (n < LOGIN_MAX_RELAYS).then_some(n + 1))
        .map_err(|_| "login observer capacity exhausted".to_string())?;
    let slot = RelaySlot(Arc::clone(&relays.alive));
    let stop = Arc::new(AtomicBool::new(false));
    let ack = Arc::new(crate::pi_ipc::SessionRelayAck::with_shutdown(Arc::clone(&relays.shutdown)));
    relays.insert(&subscription_id, LoginRelayHandle {
        stop: Arc::clone(&stop), flow_id: String::new(), task_handle: String::new(),
        tokens: Default::default(), ack: Arc::clone(&ack),
    });
    let thread_relays = Arc::clone(&relays);
    let thread_id = subscription_id.clone();
    let registration = LoginRegistration { relays: Arc::clone(&relays), id: subscription_id.clone(), _slot: slot, _permit: permit };
    let (tx, rx) = std::sync::mpsc::sync_channel::<(String, String, Arc<management_host::ManagementInstance>)>(1);
    std::thread::Builder::new()
        .name(format!("ipc-login-{subscription_id}"))
        .spawn(move || {
            let _registration = registration;
            let relays = thread_relays;
            let subscription_id = thread_id;
            let (flow_id, th, instance) = loop {
                if relays.shutdown.load(Ordering::SeqCst) || stop.load(Ordering::SeqCst) { return; }
                match rx.recv_timeout(crate::pi_ipc::RELAY_SHUTDOWN_POLL) {
                    Ok(binding) => break binding,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
            };
            let mut frame_seq: u64 = 0;
            let mut since: u64 = 0;
            let mut failures: u32 = 0;
            let send = |frame_seq: &mut u64, kind: &str, payload: Value| -> bool {
                *frame_seq += 1;
                let frame = crate::pi_ipc::stream_frame(&subscription_id, 1, *frame_seq, kind, payload);
                if serde_json::to_writer(&mut FrameSize(0), &frame).is_err() { return false; }
                ack.forward(&on_event, frame, *frame_seq, &stop, LOGIN_ACK_TIMEOUT)
            };
            let mut heartbeat = std::time::Instant::now();
            if !send(&mut frame_seq, "snapshot", json!({ "flowId": flow_id, "taskHandle": th })) { return; }
            loop {
                let wake = std::time::Instant::now() + LOGIN_POLL_INTERVAL;
                while std::time::Instant::now() < wake && !stop.load(Ordering::SeqCst) && !relays.shutdown.load(Ordering::SeqCst) {
                    std::thread::sleep(wake.saturating_duration_since(std::time::Instant::now()).min(crate::pi_ipc::RELAY_SHUTDOWN_POLL));
                }
                if stop.load(Ordering::SeqCst) || relays.shutdown.load(Ordering::SeqCst) { break; }

                // 1. Inspect host task status (authoritative lease and lifecycle):
                let snapshot = match instance.task_snapshot(&th) {
                    Ok(s) => s,
                    Err(_) => break,
                };

                // 2. Poll buffered user-facing events:
                let poll = instance.management_call_kind(
                    "auth.loginPoll",
                    json!({ "flowId": flow_id, "since": since }),
                    LOGIN_POLL_TIMEOUT,
                    management_host::TaskKind::ReadOnly,
                );
                match poll {
                    Ok(poll_snapshot) => {
                        failures = 0;
                        if poll_snapshot.get("missing").and_then(Value::as_bool) == Some(true)
                            && snapshot.status == management_host::TaskStatus::Running && snapshot.progress.is_some() {
                            let _ = send(&mut frame_seq, "event", json!({ "type": "error", "message": "Login observation lost; outcome unknown" }));
                            break;
                        }
                        if poll_snapshot.get("truncated").and_then(Value::as_bool) == Some(true)
                            && snapshot.status == management_host::TaskStatus::Running {
                            let Some((events, tokens, last)) = recovery_interactions(&poll_snapshot) else {
                                let _ = send(&mut frame_seq, "unknown", json!({ "type": "error", "message": "Login recovery unavailable; outcome unknown" }));
                                break;
                            };
                            if let Some(relay) = relays.relays.lock().unwrap().get_mut(&subscription_id) { relay.tokens = tokens; }
                            if !send(&mut frame_seq, "reset", json!({ "events": events })) { break; }
                            since = last;
                            continue;
                        }
                        if let Some(events) = poll_snapshot.get("events").and_then(Value::as_array) {
                            for queued in events {
                                let Some(event) = queued.get("event") else { continue };
                                if let Some(token) = event.get("token").and_then(Value::as_str) {
                                    if let Some(relay) = relays.relays.lock().unwrap().get_mut(&subscription_id) {
                                        if token.len() > 512 || (relay.tokens.len() >= 512 && !relay.tokens.contains(token)) {
                                            stop.store(true, Ordering::SeqCst);
                                            break;
                                        }
                                        relay.tokens.insert(token.to_string());
                                    }
                                }
                                // Terminal truth comes only from the task snapshot.
                                if matches!(event.get("type").and_then(Value::as_str), Some("success" | "error" | "cancelled")) { continue; }
                                if !send(&mut frame_seq, "event", event.clone()) {
                                    // The WebView is gone: detach observation only.
                                    stop.store(true, Ordering::SeqCst);
                                    break;
                                }
                            }
                        }
                        if let Some(last) = poll_snapshot.get("lastSeq").and_then(Value::as_u64) {
                            since = last;
                        }
                    }
                    Err(_) => {
                        failures += 1;
                        // A stolen result envelope (the known concurrent-call
                        // notify race) or a busy child costs one bounded gap;
                        // only a persistent failure is a lost connection —
                        // the old SSE stream's error when the server dropped.
                        if failures >= LOGIN_POLL_MAX_FAILURES || instance.client_has_exited() {
                            let _ = send(&mut frame_seq, "event", json!({ "type": "error", "message": "Connection lost" }));
                            break;
                        }
                    }
                }

                if stop.load(Ordering::SeqCst) || relays.shutdown.load(Ordering::SeqCst) { break; }
                if heartbeat.elapsed() >= LOGIN_HEARTBEAT {
                    if !send(&mut frame_seq, "heartbeat", Value::Null) { break; }
                    heartbeat = std::time::Instant::now();
                }
                // 3. Act on task terminal state from management host:
                match snapshot.status {
                    management_host::TaskStatus::Unknown => {
                        let _ = send(&mut frame_seq, "unknown", json!({ "type": "error", "message": "Login timed out; outcome unknown" }));
                        break;
                    }
                    management_host::TaskStatus::Cancelled => {
                        let _ = send(&mut frame_seq, "terminal", json!({ "type": "cancelled" }));
                        break;
                    }
                    management_host::TaskStatus::Failed => {
                        let _ = send(&mut frame_seq, "terminal", json!({ "type": "error", "message": "Login failed" }));
                        break;
                    }
                    management_host::TaskStatus::Succeeded => {
                        if let Some(res) = snapshot.result.as_ref() {
                            if res.get("started").and_then(Value::as_bool) == Some(false) {
                                let msg = res.get("message").and_then(Value::as_str).unwrap_or("Unknown provider");
                                let _ = send(&mut frame_seq, "terminal", json!({ "type": "error", "message": msg }));
                                break;
                            }
                        }
                        let _ = send(&mut frame_seq, "terminal", json!({ "type": "success" }));
                        break;
                    }
                    management_host::TaskStatus::Running => {}
                }
            }

            // Observer loss is not evidence that the credential writer stopped.
        })
        .map_err(|_| "could not start login observer".to_string())?;
    Ok(tx)
}

/// Open the OAuth login stream (the static transport's auth.loginStream):
/// starts the flow in the management instance as a bounded task with a hard
/// 10-minute deadline, guarded by ManagementInstance activity for the flow's
/// real lifetime. Streams its events over a Tauri Channel.
#[tauri::command]
pub fn pi_ipc_login_stream(
    state: State<'_, Arc<IpcHostState>>,
    provider: String,
    flow_id: Option<String>,
    task_handle: Option<String>,
    on_event: Channel<Value>,
) -> Value {
    open_login_stream(&state, provider, flow_id, task_handle, on_event)
}

fn open_login_stream(
    state: &Arc<IpcHostState>, provider: String, flow_id: Option<String>, task_handle: Option<String>, on_event: Channel<Value>,
) -> Value {
    if provider.is_empty() || provider.len() > 200 {
        return crate::pi_ipc::protocol_error("?", "invalid_args", "provider is required");
    }
    let permit = match state.login_relays.reserve() {
        Ok(permit) => permit,
        Err(message) => return crate::pi_ipc::protocol_error("?", "busy", &message),
    };
    let config = state.management_config.lock().unwrap().clone();
    if state.login_relays.shutdown.load(Ordering::SeqCst) {
        return crate::pi_ipc::protocol_error("?", "busy", "login observer admission closed");
    }
    let Some(config) = config else {
        return crate::pi_ipc::protocol_error(
            "?",
            "management_unavailable",
            "the management instance is not configured (the vendored module tree is missing)",
        );
    };
    let instance = match state.management.instance("global", &config) {
        Ok(instance) => instance,
        Err(error) => {
            return crate::pi_ipc::protocol_error("?", "management_unavailable", &error);
        }
    };
    let number = LOGIN_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let subscription_id = format!("login-{number}");
    let sender = match reserve_login_relay_with_permit(state, subscription_id.clone(), on_event, Arc::clone(&permit)) {
        Ok(sender) => sender,
        Err(message) => return crate::pi_ipc::protocol_error("?", "busy", &message),
    };
    let mut tasks = state.login_relays.tasks.lock().unwrap();
    if state.login_relays.shutdown.load(Ordering::SeqCst) {
        return crate::pi_ipc::protocol_error("?", "busy", "login observer admission closed");
    }
    let (flow_id, task_handle) = match (flow_id, task_handle) {
        (Some(flow), Some(task)) => {
            let valid = tasks.get(&flow).is_some_and(|entry| entry.provider == provider
                && entry.task_handle == task && Arc::ptr_eq(&entry.instance, &instance)
                && instance.task_snapshot(&task).is_ok());
            if !valid {
                return crate::pi_ipc::protocol_error("?", "not_found", "original login task unavailable");
            }
            (flow, task)
        }
        (None, None) => {
            let active = tasks.values().filter(|entry| {
                match entry.instance.task_snapshot(&entry.task_handle) {
                    Ok(snapshot) => matches!(snapshot.status, management_host::TaskStatus::Running | management_host::TaskStatus::Unknown),
                    Err(_) => true,
                }
            }).count();
            if active >= LOGIN_MAX_RELAYS {
                return crate::pi_ipc::protocol_error("?", "busy", "login task capacity exhausted");
            }
            if tasks.len() >= LOGIN_MAX_TASKS {
                let completed = tasks.iter().find_map(|(flow, entry)| {
                    entry.instance.task_snapshot(&entry.task_handle).ok().and_then(|snapshot| {
                        matches!(snapshot.status, management_host::TaskStatus::Succeeded | management_host::TaskStatus::Failed | management_host::TaskStatus::Cancelled).then(|| flow.clone())
                    })
                });
                if let Some(flow) = completed { tasks.remove(&flow); }
            }
            if tasks.len() >= LOGIN_MAX_TASKS {
                return crate::pi_ipc::protocol_error("?", "busy", "login task registry capacity exhausted");
            }
            let flow = format!("loginflow-{number}");
            if state.login_relays.shutdown.load(Ordering::SeqCst) {
                return crate::pi_ipc::protocol_error("?", "busy", "login observer admission closed");
            }
            let task = match instance.start_task("auth.loginStart", json!({ "flowId": flow, "provider": provider }),
                LOGIN_FLOW_DEADLINE, management_host::TaskKind::Mutation) {
                Ok(task) => task,
                Err(error) => {
                    let (code, message) = crate::pi_ipc::management_error_code(&error);
                    return crate::pi_ipc::protocol_error("?", &code, &message);
                }
            };
            tasks.insert(flow.clone(), LoginTask { provider, task_handle: task.clone(), instance: Arc::clone(&instance) });
            (flow, task)
        }
        _ => return crate::pi_ipc::protocol_error("?", "invalid_args", "both original task identifiers are required"),
    };
    drop(tasks);
    if let Some(relay) = state.login_relays.relays.lock().unwrap().get_mut(&subscription_id) {
        relay.flow_id = flow_id.clone();
        relay.task_handle = task_handle.clone();
    }
    if sender.send((flow_id.clone(), task_handle.clone(), instance)).is_err() {
        let mut error = crate::pi_ipc::protocol_error("?", "io", "login observer could not bind; task outcome is independent");
        error["error"]["details"] = json!({ "subscriptionId": subscription_id, "flowId": flow_id, "taskHandle": task_handle });
        return error;
    }
    json!({ "subscriptionId": subscription_id, "flowId": flow_id, "taskHandle": task_handle })
}

/// The unsubscribe half for login streams (pi_ipc's agent.unsubscribeEvents
/// arm delegates here): stop observation without cancelling the task.
pub(crate) fn unsubscribe_login_stream(state: &IpcHostState, subscription_id: &str) -> bool {
    let Some(handle) = state.login_relays.cancel(subscription_id) else {
        return false;
    };
    handle.stop.store(true, Ordering::SeqCst);
    handle.ack.wake();
    true
}


#[cfg(test)]
#[path = "provider_auth_shutdown_tests.rs"]
mod shutdown_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(unix)]
    #[test]
    fn relay_admission_reconnect_ack_and_task_outcome() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::mpsc;
        let dir = tempfile::tempdir().unwrap();
        let child = dir.path().join("fake-provider.py");
        std::fs::write(&child, r##"#!/usr/bin/python3
import sys,json,base64,os
pending=None
root=os.environ['PI_CODING_AGENT_DIR']
def emit(rid,nonce,result):
    body={'rid':rid,'nonce':nonce,'ok':True,'result':result}
    print(json.dumps({'type':'extension_ui_request','id':'notify','method':'notify','message':'PI_WEB_MGMT_V1 '+json.dumps(body)}),flush=True)
for line in sys.stdin:
    r=json.loads(line)
    if r.get('type')!='prompt': continue
    p=r['message'].split(' '); rid=p[1]
    d=json.loads(base64.urlsafe_b64decode(p[2]+'='*((-len(p[2]))%4)))
    print(json.dumps({'type':'response','id':r['id'],'success':True,'data':{'disposition':'handled'}}),flush=True)
    if d['op']=='auth.loginStart':
        open(os.path.join(root,'started'),'a').write('start\n'); pending=(rid,d['nonce'])
    elif d['op']=='auth.loginPoll':
        event={'type':'progress','message':'x'*70000} if os.path.exists(os.path.join(root,'oversize')) else {'type':'auth','url':'https://example.invalid','instructions':None,'token':'fake-token'}
        emit(rid,d['nonce'],{'events':[{'seq':1,'event':event}] if d['args']['since']==0 else [],'lastSeq':1,'done':False})
        if pending and os.path.exists(os.path.join(root,'finish')):
            emit(pending[0],pending[1],{} if os.path.exists(os.path.join(root,'unknown')) else {'success':True}); pending=None
"##).unwrap();
        std::fs::set_permissions(&child, std::fs::Permissions::from_mode(0o700)).unwrap();
        let state = Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable: child.to_string_lossy().into_owned(), agent_dir: Some(dir.path().to_path_buf()), extensions: vec![], env: vec![],
        });
        let mut reservations = Vec::new();
        for i in 0..LOGIN_MAX_RELAYS {
            reservations.push(reserve_login_relay(&state, format!("held-{i}"), Channel::new(|_| Ok(()))).unwrap());
        }
        let denied = open_login_stream(&state, "fixture".into(), None, None, Channel::new(|_| Ok(())));
        assert_eq!(denied["error"]["code"], "busy");
        assert!(!dir.path().join("started").exists(), "saturation must precede mutation");
        drop(reservations);
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while state.login_relays.alive.load(Ordering::SeqCst) != 0 { assert!(std::time::Instant::now() < until); std::thread::sleep(Duration::from_millis(10)); }
        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| { if let tauri::ipc::InvokeResponseBody::Json(s) = body { tx.send(serde_json::from_str::<Value>(&s).unwrap()).unwrap(); } Ok(()) });
        let first = open_login_stream(&state, "fixture".into(), None, None, channel);
        let sub = first["subscriptionId"].as_str().unwrap();
        let flow = first["flowId"].as_str().unwrap();
        let task = first["taskHandle"].as_str().unwrap();
        let snapshot = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(snapshot["kind"], "snapshot");
        assert!(!state.login_relays.acknowledge(sub, 2, 1));
        assert!(!state.login_relays.acknowledge(sub, 1, 2));
        assert!(state.login_relays.acknowledge(sub, 1, 1));
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(event["payload"]["type"], "auth");
        // Leave this observer's event unacknowledged while a second observer
        // attaches to the same task; its single-frame window is independent.
        let config = state.management_config.lock().unwrap().clone().unwrap();
        let instance = state.management.instance("global", &config).unwrap();
        assert_eq!(instance.task_snapshot(task).unwrap().status, management_host::TaskStatus::Running);
        {
            let mut tasks = state.login_relays.tasks.lock().unwrap();
            for i in 0..7 {
                tasks.insert(format!("fixture-active-{i}"), LoginTask { provider: "fixture".into(), task_handle: task.into(), instance: Arc::clone(&instance) });
            }
        }
        let denied = open_login_stream(&state, "fixture".into(), None, None, Channel::new(|_| Ok(())));
        assert_eq!(denied["error"]["code"], "busy");
        assert_eq!(std::fs::read_to_string(dir.path().join("started")).unwrap(), "start\n");
        state.login_relays.tasks.lock().unwrap().retain(|flow, _| !flow.starts_with("fixture-active-"));
        let (tx2, rx2) = mpsc::channel();
        let channel = Channel::new(move |body| { if let tauri::ipc::InvokeResponseBody::Json(s) = body { tx2.send(serde_json::from_str::<Value>(&s).unwrap()).unwrap(); } Ok(()) });
        let reconnected = open_login_stream(&state, "fixture".into(), Some(flow.into()), Some(task.into()), channel);
        assert_eq!(reconnected["taskHandle"], task);
        let sub2 = reconnected["subscriptionId"].as_str().unwrap();
        let second = rx2.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(second["payload"]["flowId"], flow);
        assert!(state.login_relays.acknowledge(sub2, 1, 1));
        let replay = rx2.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(replay["payload"]["type"], "auth");
        assert!(state.login_relays.acknowledge(sub2, 1, 2));
        assert!(unsubscribe_login_stream(&state, sub));
        assert!(!state.login_relays.acknowledge(sub, 1, 2));
        assert_eq!(instance.task_snapshot(task).unwrap().status, management_host::TaskStatus::Running);
        // An oversized frame detaches only its observer, not the writer or the
        // already-acknowledging observer.
        std::fs::write(dir.path().join("oversize"), "ok").unwrap();
        let (big_tx, big_rx) = mpsc::channel();
        let big_channel = Channel::new(move |body| { if let tauri::ipc::InvokeResponseBody::Json(s) = body { big_tx.send(serde_json::from_str::<Value>(&s).unwrap()).unwrap(); } Ok(()) });
        let big = open_login_stream(&state, "fixture".into(), Some(flow.into()), Some(task.into()), big_channel);
        let big_id = big["subscriptionId"].as_str().unwrap();
        big_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(state.login_relays.acknowledge(big_id, 1, 1));
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while state.login_relays.relays.lock().unwrap().contains_key(big_id) { assert!(std::time::Instant::now() < until); std::thread::sleep(Duration::from_millis(10)); }
        assert_eq!(instance.task_snapshot(task).unwrap().status, management_host::TaskStatus::Running);
        std::fs::remove_file(dir.path().join("oversize")).unwrap();
        let (silent_tx, silent_rx) = mpsc::channel();
        let silent_channel = Channel::new(move |body| { if let tauri::ipc::InvokeResponseBody::Json(s) = body { silent_tx.send(s).unwrap(); } Ok(()) });
        let silent = open_login_stream(&state, "fixture".into(), Some(flow.into()), Some(task.into()), silent_channel);
        let silent_id = silent["subscriptionId"].as_str().unwrap();
        silent_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let until = std::time::Instant::now() + LOGIN_ACK_TIMEOUT + Duration::from_secs(5);
        while state.login_relays.relays.lock().unwrap().contains_key(silent_id) { assert!(std::time::Instant::now() < until); std::thread::sleep(Duration::from_millis(20)); }
        assert_eq!(instance.task_snapshot(task).unwrap().status, management_host::TaskStatus::Running);
        // The active observer must ACK its 10-second heartbeat during this wait.
        let heartbeat = rx2.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(heartbeat["kind"], "heartbeat");
        assert!(state.login_relays.acknowledge(sub2, 1, 3));
        std::fs::write(dir.path().join("finish"), "ok").unwrap();
        let terminal = rx2.recv_timeout(Duration::from_secs(8)).unwrap();
        assert_eq!(terminal["kind"], "terminal");
        assert_eq!(terminal["payload"]["type"], "success");
        assert!(state.login_relays.acknowledge(sub2, 1, 4));
        assert_eq!(std::fs::read_to_string(dir.path().join("started")).unwrap(), "start\n");
        std::fs::remove_file(dir.path().join("finish")).unwrap();
        let (tx3, rx3) = mpsc::channel();
        let channel = Channel::new(move |body| { if let tauri::ipc::InvokeResponseBody::Json(s) = body { tx3.send(serde_json::from_str::<Value>(&s).unwrap()).unwrap(); } Ok(()) });
        let third = open_login_stream(&state, "fixture".into(), None, None, channel);
        let sub3 = third["subscriptionId"].as_str().unwrap();
        rx3.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(state.login_relays.acknowledge(sub3, 1, 1));
        rx3.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(state.login_relays.acknowledge(sub3, 1, 2));
        std::fs::write(dir.path().join("unknown"), "ok").unwrap();
        std::fs::write(dir.path().join("finish"), "ok").unwrap();
        let unknown = rx3.recv_timeout(Duration::from_secs(8)).unwrap();
        assert_eq!(unknown["kind"], "unknown");
        assert!(unknown["payload"]["message"].as_str().unwrap().contains("unknown"));
        assert!(state.login_relays.acknowledge(sub3, 1, 3));
        state.management.shutdown_all(Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn truncated_login_snapshot_rebinds_live_token_and_resumes_after_cursor() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::mpsc;
        let dir = tempfile::tempdir().unwrap();
        let child = dir.path().join("recovery-child.py");
        std::fs::write(&child, r##"#!/usr/bin/python3
import sys,json,base64
used=False
def emit(rid,nonce,result):
    body={'rid':rid,'nonce':nonce,'ok':True,'result':result}
    print(json.dumps({'type':'extension_ui_request','id':'notify','method':'notify','message':'PI_WEB_MGMT_V1 '+json.dumps(body)}),flush=True)
for line in sys.stdin:
    r=json.loads(line)
    if r.get('type')!='prompt': continue
    p=r['message'].split(' '); rid=p[1]
    d=json.loads(base64.urlsafe_b64decode(p[2]+'='*((-len(p[2]))%4)))
    print(json.dumps({'type':'response','id':r['id'],'success':True,'data':{'disposition':'handled'}}),flush=True)
    if d['op']=='auth.loginPoll':
        if d['args']['since']==0:
            emit(rid,d['nonce'],{'truncated':True,'lastSeq':520,'events':[],'currentInteraction':[{'type':'prompt_request','message':'Enter fake code','placeholder':None,'token':'fixture-live'}]})
        else:
            emit(rid,d['nonce'],{'truncated':False,'lastSeq':521,'events':[{'seq':521,'event':{'type':'progress','message':'Signing in'}}] if d['args']['since']==520 else []})
    elif d['op']=='__input':
        token=d['args']['data']['token']; ok=token=='fixture-live' and not used
        if ok: used=True
        emit(rid,d['nonce'],{'status':'accepted' if ok else 'no_pending','message':'No pending login for token'})
"##).unwrap();
        std::fs::set_permissions(&child, std::fs::Permissions::from_mode(0o700)).unwrap();
        let state = Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable: child.to_string_lossy().into_owned(), agent_dir: Some(dir.path().to_path_buf()), extensions: vec![], env: vec![],
        });
        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| { if let tauri::ipc::InvokeResponseBody::Json(s) = body { tx.send(serde_json::from_str::<Value>(&s).unwrap()).unwrap(); } Ok(()) });
        let opened = open_login_stream(&state, "fixture".into(), None, None, channel);
        let id = opened["subscriptionId"].as_str().unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap()["kind"], "snapshot");
        assert!(state.login_relays.acknowledge(id, 1, 1));
        let recovered = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(recovered["kind"], "reset");
        assert_eq!(recovered["payload"]["events"][0]["token"], "fixture-live");
        assert!(state.login_relays.acknowledge(id, 1, 2));
        let progress = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(progress["payload"]["type"], "progress");
        assert!(state.login_relays.acknowledge(id, 1, 3));
        let submit = |token| dispatch(&state, "auth.loginManualCode", "input", &json!({"provider":"fixture","token":token,"code":"fake-code"})).unwrap();
        assert_eq!(submit("fixture-live")["ok"], true);
        assert_eq!(submit("fixture-live")["error"]["code"], "not_found");
        assert_eq!(submit("fixture-old")["error"]["code"], "not_found");
        assert!(unsubscribe_login_stream(&state, id));
        state.management.shutdown_all(Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn real_node_login_snapshot_reaches_channel_and_accepts_fake_code() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};
        use std::sync::mpsc;
        let dir = tempfile::tempdir().unwrap();
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(agent.join("extensions")).unwrap();
        std::fs::write(agent.join("extensions/fake-provider.js"), r#"
export default function(pi) {
  pi.registerProvider({ id: 'relay-fake', name: 'Relay fake', auth: { oauth: {
    name: 'Fake', login: async (interaction) => {
      interaction.notify({type:'auth_url', url:'https://example.invalid/authorize', instructions:'fixture'});
      for (let i=0; i<520; i++) interaction.notify({type:'progress', message:'fixture'});
      const code = await interaction.prompt({type:'manual_code', message:'Fake code'});
      if (code !== 'fake-code') throw new Error('fake refusal');
      return {type:'oauth', access:'fake-access', refresh:'fake-refresh', expires:4102444800000};
    }, refresh: async () => ({access:'fake-access',refresh:'fake-refresh',expires:4102444800000}),
    toAuth: async (credential) => ({apiKey:credential.access})
  } }, getModels: () => [{id:'fake',name:'Fake'}], models: [{id:'fake',name:'Fake'}] });
}
"#).unwrap();
        let state = Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable: std::path::Path::new("../lib/__fixtures__/provider-login-relay-child.mjs").canonicalize().unwrap().to_string_lossy().into_owned(),
            agent_dir: Some(agent), extensions: vec![], env: vec![("PI_OFFLINE".into(), "1".into())],
        });
        let mut client = Command::new("node")
            .arg("../static-frontend/src/data/provider-login-client-child.mjs")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut client_in = client.stdin.take().unwrap();
        let client_out = BufReader::new(client.stdout.take().unwrap());
        let (client_tx, client_rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in client_out.lines() {
                let Ok(line) = line else { break };
                if client_tx.send(line).is_err() { break; }
            }
        });
        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| { if let tauri::ipc::InvokeResponseBody::Json(s) = body { tx.send(serde_json::from_str::<Value>(&s).unwrap()).unwrap(); } Ok(()) });
        let opened = open_login_stream(&state, "relay-fake".into(), None, None, channel);
        let id = opened["subscriptionId"].as_str().unwrap();
        let first = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(first["kind"], "snapshot");
        writeln!(client_in, "{first}").unwrap();
        client_in.flush().unwrap();
        assert!(state.login_relays.acknowledge(id, 1, 1));
        let recovered = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        assert_eq!(recovered["kind"], "reset", "{recovered}");
        writeln!(client_in, "{recovered}").unwrap();
        client_in.flush().unwrap();
        let mut token = None;
        for _ in recovered["payload"]["events"].as_array().unwrap() {
            let line = match client_rx.recv_timeout(Duration::from_secs(10)) {
                Ok(line) => line,
                Err(error) => { let _ = client.kill(); let _ = client.wait(); panic!("fake client did not receive recovery: {error}"); }
            };
            let event: Value = serde_json::from_str(&line).unwrap();
            if event["type"] == "prompt_request" { token = event["token"].as_str().map(str::to_string); }
        }
        let token = token.expect("static login service rendered the recovered prompt");
        assert!(state.login_relays.acknowledge(id, 1, 2));
        let submitted = dispatch(&state, "auth.loginManualCode", "submit", &json!({"provider":"relay-fake", "token":token, "code":"fake-code"})).unwrap();
        assert_eq!(submitted["ok"], true, "{submitted}");
        let terminal = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(terminal["kind"], "terminal", "{terminal}");
        assert_eq!(terminal["payload"]["type"], "success");
        assert!(state.login_relays.acknowledge(id, 1, 3));
        drop(client_in);
        assert!(client.wait().unwrap().success());
        reader.join().unwrap();
        state.management.shutdown_all(Duration::from_secs(2));
    }

    #[test]
    fn recovery_rejects_noninteractive_and_oversized_payloads() {
        let good = json!({"lastSeq":7,"currentInteraction":[{"type":"auth","token":"live","url":"https://example.invalid","instructions":null}]});
        assert!(recovery_interactions(&good).is_some());
        assert!(recovery_interactions(&json!({"lastSeq":7,"currentInteraction":[{"type":"success"}]})).is_none());
        assert!(recovery_interactions(&json!({"lastSeq":7,"currentInteraction":[{"type":"auth","token":"live","url":"x".repeat(70_000)}]})).is_none());
        assert!(recovery_interactions(&json!({"lastSeq":7,"currentInteraction":null})).is_none());
    }

    #[test]
    fn provider_argument_gate() {
        for bad in [
            json!({}),
            json!({ "provider": "" }),
            json!({ "provider": 42 }),
            json!({ "provider": "x".repeat(201) }),
        ] {
            assert!(validated_provider_arg(&bad).is_err(), "{bad}");
        }
        assert_eq!(validated_provider_arg(&json!({ "provider": "openai" })).unwrap(), "openai");
    }

    #[test]
    fn api_key_argument_gate_uses_the_routes_message() {
        for bad in [json!({}), json!({ "apiKey": "" }), json!({ "apiKey": "   " }), json!({ "apiKey": 7 })] {
            assert_eq!(
                validated_api_key_arg(&bad).unwrap_err(),
                "apiKey is required",
                "the seam's own vocabulary, not a host-invented message"
            );
        }
        assert_eq!(
            validated_api_key_arg(&json!({ "apiKey": " sk-test " })).unwrap(),
            " sk-test ",
            "trimming is the composition's job (the stored key is trimmed there)"
        );
    }

    /// The envelope gate answers invalid_args BEFORE any child exists: no
    /// management instance is configured in this test's state, so reaching
    /// one would answer management_unavailable instead.
    #[test]
    fn envelope_refusals_precede_the_management_instance() {
        let state = crate::pi_ipc::IpcHostState::new();
        let answer = dispatch(
            &state,
            "auth.apiKeyStore",
            "k1",
            &json!({ "provider": "openai", "apiKey": "" }),
        )
        .expect("the op is owned");
        assert_eq!(answer["ok"], false, "{answer}");
        assert_eq!(answer["error"]["code"], "invalid_args", "{answer}");
        assert_eq!(answer["error"]["message"], "apiKey is required", "{answer}");

        let answer = dispatch(&state, "auth.logout", "k2", &json!({ "provider": "" }))
            .expect("the op is owned");
        assert_eq!(answer["error"]["code"], "invalid_args", "{answer}");

        let answer = dispatch(&state, "auth.loginManualCode", "k3", &json!({ "provider": "openai", "token": "" }))
            .expect("the op is owned");
        assert_eq!(answer["error"]["code"], "invalid_args", "{answer}");

        let answer = dispatch(&state, "auth.loginCancel", "k4", &json!({}))
            .expect("the op is owned");
        assert_eq!(answer["error"]["code"], "invalid_args", "{answer}");
    }

    /// Unknown auth-looking ops are NOT owned here (the dispatcher refuses
    /// them as unknown_op).
    #[test]
    fn unowned_ops_answer_none() {
        let state = crate::pi_ipc::IpcHostState::new();
        assert!(dispatch(&state, "auth.loginStart", "x", &json!({})).is_none());
        assert!(dispatch(&state, "models.list", "x", &json!({})).is_none());
    }

    /// Stage the vendored management tree (the pi_ipc test module's own
    /// helper, invoked through the same script).
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

    /// Build only the local projection; link read-only dependencies instead
    /// of copying the installed SDK closure. This is not standalone evidence.
    fn local_managed_tree(dir: &std::path::Path) -> std::path::PathBuf {
        let managed = dir.join("managed").join("node_modules");
        std::fs::create_dir_all(&managed).unwrap();
        let output = std::process::Command::new("node")
            .arg("../scripts/migration/build-management-modules.mjs")
            .arg("--out").arg(&managed).output().expect("projection builder runs");
        assert!(output.status.success(), "projection failed: {}", String::from_utf8_lossy(&output.stderr));
        let projection = std::fs::metadata(managed.join("pi-web-session-projection.mjs")).unwrap().len();
        let title = std::fs::metadata(managed.join("pi-web-session-title.mjs")).unwrap().len();
        assert!(projection + title < 100 * 1024 * 1024, "fixture projection exceeds source budget");
        let dependencies = std::path::Path::new("../node_modules").canonicalize().unwrap();
        for name in ["@earendil-works", "jiti"] {
            let source = dependencies.join(name);
            let destination = managed.join(name);
            #[cfg(unix)]
            std::os::unix::fs::symlink(source, destination).unwrap();
            #[cfg(windows)]
            std::os::windows::fs::symlink_dir(source, destination).unwrap();
        }
        managed
    }

    struct StopFixtureManagement<'a>(&'a crate::pi_ipc::IpcHostState);
    impl Drop for StopFixtureManagement<'_> {
        fn drop(&mut self) { self.0.management.shutdown_all(Duration::from_secs(2)); }
    }

    /// The fixture auth.json (never a real account, never a real secret).
    fn write_fixture_auth(agent_dir: &std::path::Path, key: &str) {
        std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
        std::fs::write(
            agent_dir.join("auth.json"),
            format!(
                "{{\"openai\":{{\"type\":\"api_key\",\"key\":\"{key}\"}},\"anthropic\":{{\"type\":\"oauth\",\"access\":\"oauth-access-fixture\",\"refresh\":\"oauth-refresh-fixture\",\"expires\":4102444800000}}}}"
            ),
        )
        .expect("auth.json fixture");
    }

    fn read_auth(agent_dir: &std::path::Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(agent_dir.join("auth.json")).expect("auth.json"))
            .expect("auth.json parses")
    }

    /// The provider-auth domain over the REAL pi management instance
    /// (PI_CLI_BIN, sandboxed agent dir + a staged managed tree), through the
    /// FULL dispatch pipeline: the envelope gates, the global-instance
    /// routing, the differential message contract and the models.json
    /// exclusion rule from the listing composition. (The
    /// composition-vs-route differential lives in
    /// scripts/migration/management-extension.test.mjs; this is the host's
    /// dispatch wiring.)
    #[test]
    fn real_pi_auth_ops_answer_through_the_dispatch_pipeline() {
        let Some(executable) = std::env::var("PI_CLI_BIN")
            .ok()
            .filter(|value| !value.is_empty())
        else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let state = crate::pi_ipc::IpcHostState::new();
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let managed = stage_managed_tree(dir.path());
        write_fixture_auth(&agent_dir, "sk-host-fixture-key-9d21be");
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable,
            agent_dir: Some(agent_dir.clone()),
            extensions: vec![
                std::path::Path::new("../lib/pi-rpc/assets/pi-web-management.mjs")
                    .canonicalize()
                    .expect("management asset"),
            ],
            env: vec![
                ("PI_WEB_MANAGED_MODULES".to_string(), managed.display().to_string()),
                ("PI_OFFLINE".to_string(), "1".to_string()),
            ],
        });
        let secret = "sk-host-fixture-key-9d21be";

        let send = |op: &str, args: Value| {
            crate::pi_ipc::dispatch_envelope(
                &state,
                json!({ "v": 1, "id": format!("pa-{op}"), "op": op, "args": args }),
            )
        };

        // 1. The listing: both lists, no secrets, the stored key's provider
        //    reads configured.
        let listed = send("auth.providers", json!({}));
        assert_eq!(listed["ok"], true, "{listed}");
        let oauth: Vec<&str> = listed["data"]["oauthProviders"]
            .as_array()
            .expect("oauth list")
            .iter()
            .map(|provider| provider["id"].as_str().expect("id"))
            .collect();
        let keys: Vec<&str> = listed["data"]["apiKeyProviders"]
            .as_array()
            .expect("api-key list")
            .iter()
            .map(|provider| provider["id"].as_str().expect("id"))
            .collect();
        assert!(oauth.contains(&"anthropic"), "anthropic declares OAuth: {oauth:?}");
        assert!(keys.contains(&"openai"), "openai declares an API-key login: {keys:?}");
        assert!(!listed.to_string().contains(secret), "no stored key in the listing");
        let openai_entry = listed["data"]["apiKeyProviders"]
            .as_array()
            .expect("list")
            .iter()
            .find(|provider| provider["id"] == "openai")
            .expect("openai entry")
            .clone();
        assert_eq!(openai_entry["configured"], true, "{openai_entry}");

        // 2. The envelope gate answers before any child work.
        let gated = send("auth.apiKeyStore", json!({ "provider": "openai", "apiKey": "  " }));
        assert_eq!(gated["ok"], false, "{gated}");
        assert_eq!(gated["error"]["code"], "invalid_args", "{gated}");
        assert_eq!(gated["error"]["message"], "apiKey is required", "{gated}");

        // 3. The type-gated delete carries the route's 409 message and
        //    removes nothing.
        let refused = send("auth.apiKeyDelete", json!({ "provider": "anthropic" }));
        assert_eq!(refused["ok"], false, "{refused}");
        assert_eq!(
            refused["error"]["message"],
            "anthropic is authenticated with OAuth, not an API key",
            "{refused}"
        );
        assert_eq!(read_auth(&agent_dir)["anthropic"]["type"], "oauth", "the refusal removed nothing");

        // 4. The API-key store writes through the provider's own login.
        let stored = send(
            "auth.apiKeyStore",
            json!({ "provider": "openai", "apiKey": format!("{secret}-2") }),
        );
        assert_eq!(stored["ok"], true, "{stored}");
        assert_eq!(read_auth(&agent_dir)["openai"]["key"], format!("{secret}-2"));

        // 5. logout removes only the OAuth credential; the API key survives.
        let logged_out = send("auth.logout", json!({ "provider": "anthropic" }));
        assert_eq!(logged_out["ok"], true, "{logged_out}");
        let after_logout = read_auth(&agent_dir);
        assert_eq!(after_logout.get("anthropic"), None, "the OAuth credential is gone");
        assert_eq!(after_logout["openai"]["type"], "api_key", "the API key survived");

        // 6. The delete removes the key and the refreshed list agrees.
        let removed = send("auth.apiKeyDelete", json!({ "provider": "openai" }));
        assert_eq!(removed["ok"], true, "{removed}");
        let relisted = send("auth.providers", json!({}));
        let openai_relisted = relisted["data"]["apiKeyProviders"]
            .as_array()
            .expect("list")
            .iter()
            .find(|provider| provider["id"] == "openai")
            .expect("openai entry")
            .clone();
        assert_eq!(openai_relisted["configured"], false, "{openai_relisted}");

        // 7. auth.loginManualCode with unknown token surfaces not_found.
        let code_refused = send("auth.loginManualCode", json!({ "provider": "openai", "token": "openai-bad", "code": "123" }));
        assert_eq!(code_refused["ok"], false, "{code_refused}");
        assert_eq!(code_refused["error"]["code"], "not_found", "{code_refused}");

        // 8. auth.loginCancel for unknown flow answers cancelled: false.
        let cancel_res = send("auth.loginCancel", json!({ "flowId": "nonexistent-flow" }));
        assert_eq!(cancel_res["ok"], true, "{cancel_res}");
        assert_eq!(cancel_res["data"]["cancelled"], false, "{cancel_res}");

        // 9. Start a login task via start_task on the real instance, inspect snapshot, and cancel:
        let config = state.management_config.lock().unwrap().clone().unwrap();
        let instance = state.management.instance("global", &config).unwrap();
        let task_handle = instance
            .start_task(
                "auth.loginStart",
                json!({ "flowId": "flow-test-real-1", "provider": "anthropic" }),
                LOGIN_FLOW_DEADLINE,
                management_host::TaskKind::Mutation,
            )
            .expect("login task starts");
        assert!(task_handle.starts_with("task-"), "{task_handle}");
        let snap = instance.task_snapshot(&task_handle).expect("snapshot exists");
        assert!(
            matches!(
                snap.status,
                management_host::TaskStatus::Running
                    | management_host::TaskStatus::Cancelled
                    | management_host::TaskStatus::Succeeded
            ),
            "status: {:?}",
            snap.status
        );
        let _ = instance.cancel_task(&task_handle);
    }

    fn assert_real_login_unknown(executable: &str, managed: &std::path::Path, source: &str, cancel: bool) {
        let state = crate::pi_ipc::IpcHostState::new();
        let dir = tempfile::tempdir().unwrap();
        let _cleanup = StopFixtureManagement(&state);
        let agent = dir.path().join("agent");
        *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
        write_fixture_auth(&agent, "fake-fixture-key");
        std::fs::create_dir_all(agent.join("extensions")).unwrap();
        std::fs::write(agent.join("extensions/fixture.js"), source).unwrap();
        let config = management_host::ManagementSpawnConfig {
            executable: executable.to_string(), agent_dir: Some(agent.clone()),
            extensions: vec![std::path::Path::new("../lib/pi-rpc/assets/pi-web-management.mjs").canonicalize().unwrap()],
            env: vec![("PI_WEB_MANAGED_MODULES".into(), managed.display().to_string()), ("PI_OFFLINE".into(), "1".into())],
        };
        *state.management_config.lock().unwrap() = Some(config.clone());
        let instance = state.management.instance("global", &config).unwrap();
        let task = instance.start_task("auth.loginStart", json!({"flowId":"isolated-flow","provider":"fixture-oauth"}),
            LOGIN_FLOW_DEADLINE, management_host::TaskKind::Mutation).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(20);
        let token = loop {
            let poll = instance.management_call_kind("auth.loginPoll", json!({"flowId":"isolated-flow"}), Duration::from_secs(5), management_host::TaskKind::ReadOnly).unwrap();
            if let Some(token) = poll["events"].as_array().and_then(|events| events.iter().find_map(|e| e["event"]["token"].as_str())) { break token.to_string(); }
            let snapshot = instance.task_snapshot(&task).unwrap();
            assert_eq!(snapshot.status, management_host::TaskStatus::Running, "fake login did not start: {:?}", snapshot.error);
            assert!(std::time::Instant::now() < until, "isolated fake prompt missing");
            std::thread::sleep(Duration::from_millis(20));
        };
        if cancel {
            instance.cancel_task(&task).unwrap();
            assert!(instance.submit_task_input(&task, json!({"provider":"fixture-oauth", "token":token, "code":"fixture"})).is_err(),
                "a cancellation request must close input before outcome is known");
        } else {
            let result = instance.submit_task_input(&task, json!({"provider":"fixture-oauth", "token":token, "code":"fake-rejection-2026"})).unwrap();
            assert_eq!(result["status"], "accepted");
        }
        while instance.task_snapshot(&task).unwrap().status == management_host::TaskStatus::Running {
            assert!(std::time::Instant::now() < until, "fake login outcome did not settle");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(instance.task_snapshot(&task).unwrap().status, management_host::TaskStatus::Unknown,
            "failed/cancelled interaction does not prove the writer stopped");
        assert!(instance.submit_task_input(&task, json!({"provider":"fixture-oauth", "token":token, "code":"fixture"})).is_err());
        assert!(instance.start_task("auth.loginStart", json!({"flowId":"blocked","provider":"fixture-oauth"}),
            LOGIN_FLOW_DEADLINE, management_host::TaskKind::Mutation).is_err());
        assert!(instance.start_task("auth.apiKeyStore", json!({"provider":"openai","apiKey":"sk-new"}),
            LOGIN_FLOW_DEADLINE, management_host::TaskKind::Mutation).is_err());
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(std::fs::read_to_string(agent.join("provider-starts")).unwrap(), "start\n");
        let ledger = agent.join("pi-web/management-operations");
        let records: Vec<_> = std::fs::read_dir(ledger).unwrap().map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap()).collect();
        assert!(records.iter().any(|record| record.contains("\"phase\":\"pending\"")));
        assert!(records.iter().all(|record| !record.contains("fake-rejection-2026") && !record.contains(&token)));
    }

    /// Real local pi: pending/unknown credential ledgers block new mutations,
    /// while task-bound input remains available to the original running login.
    #[test]
    fn login_input_respects_pending_ledger_and_task_guards() {
        let Some(executable) = std::env::var("PI_CLI_BIN")
            .ok()
            .filter(|value| !value.is_empty())
        else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let state = crate::pi_ipc::IpcHostState::new();
        let dir = tempfile::tempdir().expect("tempdir");
        let _cleanup = StopFixtureManagement(&state);
        let agent_dir = dir.path().join("agent");
        *state.task_agent_dir.lock().unwrap() = Some(agent_dir.clone());
        let managed = local_managed_tree(dir.path());
        write_fixture_auth(&agent_dir, "sk-test-key-scope");
        std::fs::create_dir_all(agent_dir.join("extensions")).unwrap();
        std::fs::write(agent_dir.join("extensions/fixture.js"), r#"
import { appendFileSync } from 'node:fs';
export default function(pi) {
  for (const id of ['fixture-oauth']) pi.registerProvider({
    id, name: id, auth: { oauth: {
      name: id,
      login: async (interaction) => {
        appendFileSync(process.env.PI_CODING_AGENT_DIR + '/provider-starts', 'start\n');
        interaction.notify({ type: 'auth_url', url: 'https://example.invalid/?state=fixture', instructions: 'Fixture' });
        const code = await interaction.prompt({ type: 'manual_code', message: 'Fixture code' });
        if (code.startsWith('fake-rejection-')) throw new Error('Fixture rejected');
        return { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 };
      },
      refresh: async () => ({ access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 }),
      toAuth: async (cred) => ({ apiKey: cred.access }),
    } }, getModels: () => [{ id: 'fixture', name: 'Fixture' }], models: [{ id: 'fixture', name: 'Fixture' }],
  });
}
"#).unwrap();
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
                ("PI_OFFLINE".to_string(), "1".to_string()),
            ],
        });

        let config = state.management_config.lock().unwrap().clone().unwrap();
        let instance = state.management.instance("global", &config).unwrap();
        let fixture_source = std::fs::read_to_string(agent_dir.join("extensions/fixture.js")).unwrap();

        // 1. Start a real OAuth login task using the isolated fixture provider:
        let login_task = instance
            .start_task(
                "auth.loginStart",
                json!({ "flowId": "flow-input-test-1", "provider": "fixture-oauth" }),
                LOGIN_FLOW_DEADLINE,
                management_host::TaskKind::Mutation,
            )
            .expect("login task starts");

        // Register the active relay in state:
        state.login_relays.insert(
            "sub-input-1",
            LoginRelayHandle {
                stop: Arc::new(AtomicBool::new(false)),
                flow_id: "flow-input-test-1".to_string(),
                task_handle: login_task.clone(),
                tokens: Default::default(),
                ack: Arc::new(crate::pi_ipc::SessionRelayAck::default()),
            },
        );

        // Verify task is running and has established presence in the child:
        let ready_until = std::time::Instant::now() + Duration::from_secs(10);
        while instance.task_snapshot(&login_task).unwrap().progress.is_none()
            && std::time::Instant::now() < ready_until
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(instance.task_snapshot(&login_task).unwrap().progress.is_some(), "login task has started in child: {:?}", instance.task_snapshot(&login_task).unwrap());
        let snap = instance.task_snapshot(&login_task).unwrap();
        assert_eq!(
            snap.status,
            management_host::TaskStatus::Running,
            "login_task failed with error: {:?}",
            snap.error
        );

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let token = loop {
            let poll = instance.management_call_kind("auth.loginPoll", json!({"flowId":"flow-input-test-1"}), Duration::from_secs(5), management_host::TaskKind::ReadOnly).unwrap();
            if let Some(token) = poll["events"].as_array().unwrap().iter().find_map(|e| e["event"]["token"].as_str()) { break token.to_string(); }
            assert!(std::time::Instant::now() < deadline, "fixture prompt missing");
            std::thread::sleep(Duration::from_millis(20));
        };
        state.login_relays.relays.lock().unwrap().get_mut("sub-input-1").unwrap().tokens.insert(token.clone());
        let invalid = instance.submit_task_input(&login_task, json!({"provider":"fixture-oauth", "token":"wrong", "code":"fixture"})).unwrap();
        assert_eq!(invalid["status"], "no_pending");
        let wrong_provider = instance.submit_task_input(&login_task, json!({"provider":"wrong-provider", "token":token, "code":"fixture"})).unwrap();
        assert_eq!(wrong_provider["status"], "provider_mismatch");
        assert!(instance.submit_task_input(&login_task, json!({"data":"x".repeat(4096)})).is_err());
        let other = state.management.instance("other", &config).unwrap();
        assert!(other.submit_task_input(&login_task, json!({})).is_err());

        // The pending ledger blocks a second credential mutation before it
        // enters the provider, while this task can still accept bound input.
        let blocked_mutation = instance.start_task(
            "auth.loginStart",
            json!({ "flowId": "blocked-flow", "provider": "fixture-oauth" }),
            Duration::from_secs(60),
            management_host::TaskKind::Mutation,
        );
        assert!(blocked_mutation.is_err(), "pending ledger must block another login");
        assert!(instance.start_task("auth.apiKeyStore", json!({ "provider": "openai", "apiKey": "sk-new" }),
            Duration::from_secs(60), management_host::TaskKind::Mutation).is_err());
        let pending_records: Vec<_> = std::fs::read_dir(agent_dir.join("pi-web/management-operations")).unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap()).collect();
        assert!(pending_records.iter().any(|record| record.contains("\"phase\":\"pending\"")));
        assert_eq!(read_auth(&agent_dir)["openai"]["key"], "sk-test-key-scope");
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(std::fs::read_to_string(agent_dir.join("provider-starts")).unwrap(), "start\n");
        let poll = instance.management_call_kind("auth.loginPoll", json!({"flowId":"flow-input-test-1"}), Duration::from_secs(5), management_host::TaskKind::ReadOnly).unwrap();
        assert!(poll["events"].as_array().unwrap().iter().any(|event| event["event"]["url"].as_str() == Some("https://example.invalid/?state=fixture")));

        // Input is delivered through the same dispatch used by the WebView,
        // despite the original task's pending ledger.
        let input_res = dispatch(&state, "auth.loginManualCode", "input", &json!({"provider":"fixture-oauth", "token":token, "code":"fixture-code"})).unwrap();
        assert_eq!(input_res["ok"], true, "{input_res}");
        let repeated = dispatch(&state, "auth.loginManualCode", "repeat", &json!({"provider":"fixture-oauth", "token":token, "code":"fixture-code"})).unwrap();
        assert_eq!(repeated["ok"], false);
        let until = std::time::Instant::now() + Duration::from_secs(10);
        while instance.task_snapshot(&login_task).unwrap().status == management_host::TaskStatus::Running {
            assert!(std::time::Instant::now() < until, "fake provider success did not settle");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(instance.task_snapshot(&login_task).unwrap().status, management_host::TaskStatus::Succeeded);

        // 5. Wrong handle is rejected:
        let wrong_handle_res = instance.submit_task_input(
            "task-nonexistent-handle",
            json!({ "provider": "anthropic", "token": "t", "code": "c" }),
        );
        assert!(wrong_handle_res.is_err());
        assert_eq!(wrong_handle_res.unwrap_err(), "management task not found");

        // 7. Verify subsequent input is rejected after completion or cancellation:
        let _ = instance.cancel_task(&login_task);
        let after_cancel_input = instance.submit_task_input(
            &login_task,
            json!({ "provider": "anthropic", "token": "t", "code": "c" }),
        );
        assert!(after_cancel_input.is_err(), "input after cancel must be rejected");
        let err = after_cancel_input.unwrap_err();
        assert!(
            err.contains("cancel requested") || err.contains("not running") || err.contains("terminal"),
            "err: {err}"
        );
        state.management.shutdown_all(Duration::from_secs(2));
        assert_real_login_unknown(&executable, &managed, &fixture_source, false);
        assert_real_login_unknown(&executable, &managed, &fixture_source, true);
    }

    /// A custom models.json provider stays out of the API-key list even with
    /// a stored auth.json credential (the #309/#311 rule: membership by
    /// models.json provider id, not by credential source) — over the real
    /// management instance.
    #[test]
    fn real_pi_listing_excludes_custom_models_json_providers() {
        let Some(executable) = std::env::var("PI_CLI_BIN")
            .ok()
            .filter(|value| !value.is_empty())
        else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let state = crate::pi_ipc::IpcHostState::new();
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let managed = stage_managed_tree(dir.path());
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable,
            agent_dir: Some(agent_dir.clone()),
            extensions: vec![
                std::path::Path::new("../lib/pi-rpc/assets/pi-web-management.mjs")
                    .canonicalize()
                    .expect("management asset"),
            ],
            env: vec![
                ("PI_WEB_MANAGED_MODULES".to_string(), managed.display().to_string()),
                ("PI_OFFLINE".to_string(), "1".to_string()),
            ],
        });
        std::fs::create_dir_all(agent_dir.join("sessions")).expect("sessions dir");
        std::fs::write(
            agent_dir.join("models.json"),
            "{\"providers\":{\"fixture-gateway\":{\"baseUrl\":\"http://127.0.0.1:9/v1\",\"apiKey\":\"fixture-literal\",\"api\":\"openai-completions\",\"models\":[{\"id\":\"fixture-model\"}]}}}",
        )
        .expect("models.json");
        std::fs::write(
            agent_dir.join("auth.json"),
            "{\"fixture-gateway\":{\"type\":\"api_key\",\"key\":\"stored-anyway\"}}",
        )
        .expect("auth.json");

        let listed = crate::pi_ipc::dispatch_envelope(
            &state,
            json!({ "v": 1, "id": "pa-custom", "op": "auth.providers", "args": {} }),
        );
        assert_eq!(listed["ok"], true, "{listed}");
        let keys = listed["data"]["apiKeyProviders"].as_array().expect("list").clone();
        assert!(
            !keys.iter().any(|provider| provider["id"] == "fixture-gateway"),
            "the custom provider renders from models.json, never the auth list: {keys:?}"
        );
    }
}
