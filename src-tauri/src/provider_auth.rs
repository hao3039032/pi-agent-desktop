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

use crate::pi_ipc::IpcHostState;

/// How long the API-key store's login dance may take: the provider's own
/// `apiKey.login()` (offline prompt shim) plus the credential write. The
/// default management minute would cut a slow provider validation in half.
const API_KEY_STORE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

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
        _ => None,
    }
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
