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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// Host-side login-flow + subscription ids (correlation keys, not security
/// tokens — the handshake tokens are crypto-random inside the extension).
static LOGIN_ID_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Handle that ends one login-stream relay on unsubscribe.
pub(crate) struct LoginRelayHandle {
    pub stop: Arc<AtomicBool>,
    /// The flow this relay drives (unsubscribe cancels it host-side too).
    pub flow_id: String,
    /// The management task handle for cooperative cancellation and activity guard.
    pub task_handle: String,
    pub tokens: std::collections::HashSet<String>,
}

/// The login-stream relays by subscription id (pi_ipc's event_relays
/// pattern, this domain's own map so the shared one stays untouched).
#[derive(Default)]
pub(crate) struct LoginRelays {
    pub(crate) relays: Mutex<BTreeMap<String, LoginRelayHandle>>,
}

impl LoginRelays {
    pub fn cancel(&self, subscription_id: &str) -> Option<LoginRelayHandle> {
        self.relays.lock().unwrap().remove(subscription_id)
    }

    fn insert(&self, subscription_id: &str, handle: LoginRelayHandle) {
        self.relays.lock().unwrap().insert(subscription_id.to_string(), handle);
    }

    fn remove(&self, subscription_id: &str) {
        self.relays.lock().unwrap().remove(subscription_id);
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
        // Cancel a login flow (the user closed the panel / the stream
        // unsubscribed): a cooperative, extension-side abort — the shared
        // instance is never killed, and a request is not a confirmation.
        "auth.loginCancel" => {
            if let Some(subscription_id) = args.get("subscriptionId").and_then(Value::as_str) {
                if !subscription_id.is_empty() {
                    let cancelled = unsubscribe_login_stream(state, subscription_id);
                    return Some(crate::pi_ipc::protocol_ok(id, json!({ "cancelled": cancelled })));
                }
            }
            if let Some(task_handle) = args.get("taskHandle").and_then(Value::as_str) {
                if !task_handle.is_empty() {
                    let config = state.management_config.lock().unwrap().clone();
                    if let Some(config) = config {
                        if let Ok(instance) = state.management.instance("global", &config) {
                            let res = instance.cancel_task(task_handle);
                            return Some(crate::pi_ipc::protocol_ok(id, json!({ "cancelled": res.is_ok() })));
                        }
                    }
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

/// The login-stream relay: polls the flow's buffered events out of the
/// management instance and forwards each as a Channel frame.
/// The task holds a real management activity guard for the flow's lifetime;
/// unsubscription or WebView exit triggers cooperative cancel_task host-side.
fn login_relay(
    state: &Arc<IpcHostState>,
    subscription_id: String,
    flow_id: String,
    task_handle: String,
    instance: Arc<management_host::ManagementInstance>,
    on_event: Channel<Value>,
) {
    let stop = Arc::new(AtomicBool::new(false));
    state.login_relays.insert(
        &subscription_id,
        LoginRelayHandle {
            stop: Arc::clone(&stop),
            flow_id: flow_id.clone(),
            task_handle: task_handle.clone(),
            tokens: Default::default(),
        },
    );
    let relays = Arc::clone(&state.login_relays);
    let th = task_handle.clone();
    std::thread::Builder::new()
        .name(format!("ipc-login-{subscription_id}"))
        .spawn(move || {
            let mut frame_seq: u64 = 0;
            let mut since: u64 = 0;
            let mut failures: u32 = 0;
            let send = |frame_seq: &mut u64, kind: &str, payload: Value| -> bool {
                *frame_seq += 1;
                on_event
                    .send(crate::pi_ipc::stream_frame(
                        &subscription_id,
                        1,
                        *frame_seq,
                        kind,
                        payload,
                    ))
                    .is_ok()
            };
            loop {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(LOGIN_POLL_INTERVAL);
                if stop.load(Ordering::SeqCst) {
                    break;
                }

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
                    Ok(snapshot) => {
                        failures = 0;
                        if let Some(events) = snapshot.get("events").and_then(Value::as_array) {
                            for queued in events {
                                let Some(event) = queued.get("event") else { continue };
                                if let Some(token) = event.get("token").and_then(Value::as_str) {
                                    if let Some(relay) = relays.relays.lock().unwrap().get_mut(&subscription_id) {
                                        relay.tokens.insert(token.to_string());
                                    }
                                }
                                if !send(&mut frame_seq, "event", event.clone()) {
                                    // The WebView is gone: cancel and detach.
                                    stop.store(true, Ordering::SeqCst);
                                    break;
                                }
                            }
                        }
                        if let Some(last) = snapshot.get("lastSeq").and_then(Value::as_u64) {
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

                // 3. Act on task terminal state from management host:
                match snapshot.status {
                    management_host::TaskStatus::Unknown => {
                        let _ = send(&mut frame_seq, "event", json!({ "type": "error", "message": "Login timed out; outcome unknown" }));
                        break;
                    }
                    management_host::TaskStatus::Cancelled => {
                        let _ = send(&mut frame_seq, "event", json!({ "type": "cancelled" }));
                        break;
                    }
                    management_host::TaskStatus::Failed => {
                        let msg = snapshot.error.unwrap_or_else(|| "Login failed".to_string());
                        let _ = send(&mut frame_seq, "event", json!({ "type": "error", "message": msg }));
                        break;
                    }
                    management_host::TaskStatus::Succeeded => {
                        if let Some(res) = snapshot.result.as_ref() {
                            if res.get("started").and_then(Value::as_bool) == Some(false) {
                                let msg = res.get("message").and_then(Value::as_str).unwrap_or("Unknown provider");
                                let _ = send(&mut frame_seq, "event", json!({ "type": "error", "message": msg }));
                                break;
                            }
                        }
                        let _ = send(&mut frame_seq, "event", json!({ "type": "success" }));
                        break;
                    }
                    management_host::TaskStatus::Running => {}
                }
            }

            // If relay is ending because of stop or unsubscription, cancel the task cooperatively:
            if stop.load(Ordering::SeqCst) {
                let _ = instance.cancel_task(&th);
            }
            relays.remove(&subscription_id);
        })
        .expect("the login relay thread spawns");
}

/// Open the OAuth login stream (the static transport's auth.loginStream):
/// starts the flow in the management instance as a bounded task with a hard
/// 10-minute deadline, guarded by ManagementInstance activity for the flow's
/// real lifetime. Streams its events over a Tauri Channel.
#[tauri::command]
pub fn pi_ipc_login_stream(
    state: State<'_, Arc<IpcHostState>>,
    provider: String,
    on_event: Channel<Value>,
) -> Value {
    if provider.is_empty() || provider.len() > 200 {
        return crate::pi_ipc::protocol_error("?", "invalid_args", "provider is required");
    }
    let config = state.management_config.lock().unwrap().clone();
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
    let flow_id = format!("loginflow-{number}");

    // Start the flow with a 10-minute hard deadline, holding an activity guard:
    let task_start = instance.start_task(
        "auth.loginStart",
        json!({ "flowId": flow_id, "provider": provider }),
        LOGIN_FLOW_DEADLINE,
        management_host::TaskKind::Mutation,
    );
    match task_start {
        Ok(task_handle) => {
            login_relay(
                &state,
                subscription_id.clone(),
                flow_id.clone(),
                task_handle.clone(),
                instance,
                on_event,
            );
            json!({ "subscriptionId": subscription_id, "flowId": flow_id, "taskHandle": task_handle })
        }
        Err(error) => {
            let (code, message) = crate::pi_ipc::management_error_code(&error);
            crate::pi_ipc::protocol_error("?", &code, &message)
        }
    }
}

/// The unsubscribe half for login streams (pi_ipc's agent.unsubscribeEvents
/// arm delegates here): stop the relay and cancel the flow host-side via cancel_task.
pub(crate) fn unsubscribe_login_stream(state: &IpcHostState, subscription_id: &str) -> bool {
    let Some(handle) = state.login_relays.cancel(subscription_id) else {
        return false;
    };
    handle.stop.store(true, Ordering::SeqCst);
    if let Some(config) = state.management_config.lock().unwrap().clone() {
        if let Ok(instance) = state.management.instance("global", &config) {
            let _ = instance.cancel_task(&handle.task_handle);
        }
    }
    true
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    /// A running OAuth login task can accept input via submit_task_input even when
    /// another mutation in the same management scope has an Unknown outcome (which
    /// blocks ordinary new mutations like auth.apiKeyStore). Also verifies that
    /// wrong handle, bad/repeated token, and submission after cancel all reject.
    #[test]
    fn login_input_bypasses_scope_mutation_isolation_and_enforces_task_guards() {
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
        write_fixture_auth(&agent_dir, "sk-test-key-scope");
        std::fs::create_dir_all(agent_dir.join("extensions")).unwrap();
        std::fs::write(agent_dir.join("extensions/fixture.js"), r#"
export default function(pi) {
  for (const id of ['fixture-oauth', 'fixture-stuck']) pi.registerProvider({
    id, name: id, auth: { oauth: {
      name: id,
      login: async (interaction) => {
        if (id === 'fixture-stuck') return await new Promise(() => {});
        interaction.notify({ type: 'auth_url', url: 'https://example.invalid/?state=fixture', instructions: 'Fixture' });
        const code = await interaction.prompt({ type: 'manual_code', message: 'Fixture code' });
        if (code === 'bad') throw new Error('Fixture rejected');
        return { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 };
      },
      refresh: async () => ({ access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 }),
      toAuth: async (cred) => ({ apiKey: cred.access }),
    } }, getModels: () => [{ id: 'fixture', name: 'Fixture' }], models: [{ id: 'fixture', name: 'Fixture' }],
  });
}
"#).unwrap();
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

        let config = state.management_config.lock().unwrap().clone().unwrap();
        let instance = state.management.instance("global", &config).unwrap();

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
        assert!(instance.submit_task_input(&login_task, json!({"data":"x".repeat(4096)})).is_err());
        let other = state.management.instance("other", &config).unwrap();
        assert!(other.submit_task_input(&login_task, json!({})).is_err());

        // Two further fixture flows exercise provider error and cooperative cancel.
        for (flow, answer) in [("flow-error", Some("bad")), ("flow-cancel", None)] {
            let handle = instance.start_task("auth.loginStart", json!({"flowId":flow, "provider":"fixture-oauth"}), LOGIN_FLOW_DEADLINE, management_host::TaskKind::Mutation).unwrap();
            let until = std::time::Instant::now() + Duration::from_secs(10);
            let prompt_token = loop {
                let poll = instance.management_call_kind("auth.loginPoll", json!({"flowId":flow}), Duration::from_secs(5), management_host::TaskKind::ReadOnly).unwrap();
                if let Some(token) = poll["events"].as_array().unwrap().iter().find_map(|e| e["event"]["token"].as_str()) { break token.to_string(); }
                assert!(std::time::Instant::now() < until, "fixture prompt missing");
                std::thread::sleep(Duration::from_millis(20));
            };
            if let Some(code) = answer {
                assert_eq!(instance.submit_task_input(&handle, json!({"provider":"fixture-oauth", "token":prompt_token, "code":code})).unwrap()["status"], "accepted");
            } else {
                instance.cancel_task(&handle).unwrap();
            }
            while instance.task_snapshot(&handle).unwrap().status == management_host::TaskStatus::Running && std::time::Instant::now() < until { std::thread::sleep(Duration::from_millis(20)); }
            assert_eq!(instance.task_snapshot(&handle).unwrap().status, if answer.is_some() { management_host::TaskStatus::Failed } else { management_host::TaskStatus::Cancelled });
            assert!(instance.submit_task_input(&handle, json!({"provider":"fixture-oauth", "token":prompt_token, "code":"fixture"})).is_err());
        }

        // 2. Introduce an Unknown-outcome mutation task in the SAME management scope:
        // A bounded synchronous call expires while its fixture login is still running.
        let timeout_error = instance.management_call(
            "auth.loginStart",
            json!({ "flowId": "flow-timeout-fake", "provider": "fixture-stuck" }),
            Duration::from_millis(1),
        ).unwrap_err();
        let unknown_task = timeout_error.split("(task ").nth(1).unwrap().trim_end_matches(')').to_string();
        assert_eq!(
            instance.task_snapshot(&unknown_task).unwrap().status,
            management_host::TaskStatus::Unknown,
            "the scope now has an Unknown outcome"
        );

        // 3. Verify that ordinary new mutations are blocked by the Unknown task in the scope:
        let blocked_mutation = instance.start_task(
            "auth.apiKeyStore",
            json!({ "provider": "openai", "apiKey": "sk-new" }),
            Duration::from_secs(60),
            management_host::TaskKind::Mutation,
        );
        assert!(blocked_mutation.is_err(), "ordinary mutations are blocked by scope write isolation");
        assert_eq!(blocked_mutation.unwrap_err(), "management scope has an unknown outcome");
        let poll = instance.management_call_kind("auth.loginPoll", json!({"flowId":"flow-input-test-1"}), Duration::from_secs(5), management_host::TaskKind::ReadOnly).unwrap();
        assert!(poll["events"].as_array().unwrap().iter().any(|event| event["event"]["url"].as_str() == Some("https://example.invalid/?state=fixture")));

        // Input is delivered through the same dispatch used by the WebView, despite unknown isolation.
        let input_res = dispatch(&state, "auth.loginManualCode", "input", &json!({"provider":"fixture-oauth", "token":token, "code":"fixture-code"})).unwrap();
        assert_eq!(input_res["ok"], true, "{input_res}");
        let repeated = dispatch(&state, "auth.loginManualCode", "repeat", &json!({"provider":"fixture-oauth", "token":token, "code":"fixture-code"})).unwrap();
        assert_eq!(repeated["ok"], false);

        // 5. Wrong handle is rejected:
        let wrong_handle_res = instance.submit_task_input(
            "task-nonexistent-handle",
            json!({ "provider": "anthropic", "token": "t", "code": "c" }),
        );
        assert!(wrong_handle_res.is_err());
        assert_eq!(wrong_handle_res.unwrap_err(), "management task not found");

        // 6. Unknown/terminal target task is rejected:
        let unknown_target_res = instance.submit_task_input(
            &unknown_task,
            json!({ "provider": "anthropic", "token": "t", "code": "c" }),
        );
        assert!(unknown_target_res.is_err());
        let unknown_err = unknown_target_res.unwrap_err();
        assert!(
            unknown_err.contains("terminal") || unknown_err.contains("not running"),
            "unknown_err: {unknown_err}"
        );

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
