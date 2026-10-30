//! Real-pi integration tests, gated on `PI_CLI_BIN` (the same convention as
//! lib/pi-rpc/*.smoke.test.mjs; skipped with a notice when unset).
//!
//! Everything is sandboxed: the cwd, the agent dir (`PI_CODING_AGENT_DIR`)
//! and the session dir live under one tempfile, the child is spawned with
//! `--no-extensions --no-skills --no-prompt-templates --no-themes
//! --no-context-files` so the host's own ~/.pi configuration cannot pollute
//! the listing, and the only extra extension is the file under test. No
//! model, no auth, no network: these tests freeze the M0 handshake/bridge/
//! exit behaviors of the plan's highest-risk verification item.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use pi_host::bridge::{find_bridge_commands, Bridge, BridgeError};
use pi_host::client::PiRpcClient;
use pi_host::{EnvPolicy, SpawnOptions};

const HANDSHAKE: Duration = Duration::from_secs(30);
const CLOSE_GRACE: Duration = Duration::from_secs(10);

fn pi_bin() -> Option<String> {
    match std::env::var("PI_CLI_BIN") {
        Ok(value) if !value.is_empty() && Path::new(&value).exists() => Some(value),
        Ok(value) if !value.is_empty() => {
            panic!("PI_CLI_BIN points at a missing file: {value}");
        }
        _ => None,
    }
}

fn bridge_asset() -> PathBuf {
    if let Ok(path) = std::env::var("PI_HOST_BRIDGE_ASSET") {
        return PathBuf::from(path);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../lib/pi-rpc/assets/pi-web-bridge.mjs")
        .canonicalize()
        .expect("the shipped bridge asset resolves from the checkout")
}

/// A fresh session header line: `{"type":"session","version":3,...}`.
fn write_session_header(file: &Path, cwd: &Path) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let header = json!({
        "type": "session",
        "version": 3,
        "id": id,
        "timestamp": iso_now(),
        "cwd": cwd.to_string_lossy(),
    });
    std::fs::create_dir_all(file.parent().expect("session file has a parent"))
        .expect("session dir");
    std::fs::write(file, format!("{header}\n")).expect("session header");
    id
}

/// UTC ISO-8601 with millisecond precision (the header's timestamp format).
fn iso_now() -> String {
    let since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after the epoch");
    let millis = since_epoch.as_millis();
    let days = (millis / 86_400_000) as i64;
    let rest = (millis % 86_400_000) as u64;
    let (year, month, day) = civil_from_days(days);
    let hour = rest / 3_600_000;
    let minute = (rest % 3_600_000) / 60_000;
    let second = (rest % 60_000) / 1_000;
    let ms = rest % 1_000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z")
}

/// Howard Hinnant's civil_from_days.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
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

struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "pi-host-real-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("work")).expect("work dir");
        std::fs::create_dir_all(root.join("agent")).expect("agent dir");
        std::fs::create_dir_all(root.join("sessions")).expect("sessions dir");
        Self { root }
    }

    fn work(&self) -> PathBuf {
        self.root.join("work")
    }

    fn agent(&self) -> PathBuf {
        self.root.join("agent")
    }

    fn sessions(&self) -> PathBuf {
        self.root.join("sessions")
    }

    fn session_file(&self) -> PathBuf {
        self.sessions().join("session.jsonl")
    }

    fn spawn_pi(&self, extra_args: &[String], env_extra: &[(&str, String)]) -> Arc<PiRpcClient> {
        let executable = pi_bin().expect("PI_CLI_BIN");
        let mut args: Vec<String> = vec![
            "--session".into(),
            self.session_file().to_string_lossy().into_owned(),
            "--session-dir".into(),
            self.sessions().to_string_lossy().into_owned(),
            // -ne/-ns/-np keep discovered resources out; explicit --extension
            // paths are the only extensions, so the listing cannot be polluted
            // by the host's own ~/.pi configuration.
            "--no-extensions".into(),
            "--no-skills".into(),
            "--no-prompt-templates".into(),
            "--no-themes".into(),
            "--no-context-files".into(),
        ];
        args.extend_from_slice(extra_args);
        let mut env = EnvPolicy::inherit().set(
            "PI_CODING_AGENT_DIR",
            self.agent().to_string_lossy().into_owned(),
        );
        for (key, value) in env_extra {
            env = env.set(*key, value.clone());
        }
        PiRpcClient::spawn(
            &executable,
            SpawnOptions {
                args,
                cwd: Some(self.work()),
                env,
                ..SpawnOptions::default()
            },
        )
        .expect("pi spawns")
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        // Best effort; a lingering child holds the cwd on Windows.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn get_state(client: &PiRpcClient) -> Value {
    client.command("get_state", json!({}), Some(HANDSHAKE)).expect("get_state answers")
}

#[test]
fn real_pi_handshake_identity_and_orderly_exit() {
    let Some(_) = pi_bin() else {
        eprintln!("skipping: PI_CLI_BIN not set");
        return;
    };
    let sandbox = Sandbox::new("handshake");
    let header_id = write_session_header(&sandbox.session_file(), &sandbox.work());
    let client = sandbox.spawn_pi(&[], &[]);

    let state = get_state(&client);
    // Session identity: the child reopened OUR session file and reports its
    // header id and file back.
    assert_eq!(state["sessionId"].as_str().expect("sessionId"), header_id);
    assert_eq!(
        state["sessionFile"].as_str().expect("sessionFile"),
        sandbox.session_file().to_string_lossy(),
    );
    assert_eq!(state["isStreaming"], false);
    assert_eq!(state["isCompacting"], false);
    // get_state reports no autoRetryEnabled field (docs/rpc-commands.md);
    // the host must treat retry policy as unknown until an event proves it.
    assert!(state.get("autoRetryEnabled").is_none());
    assert!(state.get("isIdle").is_none(), "isIdle is not part of get_state");

    // A second spawn on the same file reports the same identity (resume).
    assert_eq!(client.close(CLOSE_GRACE), Some(0), "orderly exit on stdin EOF");
    let resumed = sandbox.spawn_pi(&[], &[]);
    let state_two = get_state(&resumed);
    assert_eq!(state_two["sessionId"].as_str().expect("sessionId"), header_id);
    assert_eq!(resumed.close(CLOSE_GRACE), Some(0));
}

#[test]
fn real_pi_bridge_tools_list_over_the_shipped_asset() {
    let Some(_) = pi_bin() else {
        eprintln!("skipping: PI_CLI_BIN not set");
        return;
    };
    let sandbox = Sandbox::new("bridge");
    let header_id = write_session_header(&sandbox.session_file(), &sandbox.work());
    let asset = bridge_asset();
    // The bridge nonce travels through the environment (PI_WEB_BRIDGE_NONCE).
    let nonce = uuid::Uuid::new_v4().to_string();
    let client = sandbox.spawn_pi(
        &["--extension".into(), asset.to_string_lossy().into_owned()],
        &[("PI_WEB_BRIDGE_NONCE", nonce.clone())],
    );

    let state = get_state(&client);
    assert_eq!(state["sessionId"].as_str().expect("sessionId"), header_id);

    // 1. The bridge command is attributed to the SHIPPED asset (source path,
    //    not just the name) by the child's own get_commands.
    let commands = client
        .command("get_commands", json!({}), Some(HANDSHAKE))
        .expect("get_commands answers");
    let bridge_commands = find_bridge_commands(&commands, &asset);
    assert!(
        bridge_commands.contains(&"pi-web:bridge".to_string()),
        "pi-web:bridge attributed to the shipped asset: {bridge_commands:?}"
    );
    assert!(bridge_commands.contains(&"pi-web:navigate".to_string()));

    // 2. tools.list over the bridge, with nonce/session verification.
    let bridge = Bridge::attach(Arc::clone(&client), header_id.clone(), nonce.clone());
    let result = bridge
        .request("tools.list", None, Some(Duration::from_secs(30)))
        .expect("tools.list answers");
    let tools = result["tools"].as_array().expect("tools array");
    assert!(
        tools.iter().any(|tool| tool["name"] == "read"),
        "the built-in tools are listed"
    );
    let active = result["active"].as_array().expect("active array");
    assert!(!active.is_empty(), "an active set is reported");
    drop(bridge);

    // 3. A wrong nonce never reaches success: the impostor bridge expects
    //    `wrong-nonce`, the child's envelope carries the real one, and the
    //    HOST-side verification rejects the mismatched envelope (exactly
    //    core.ts's "answered with the wrong session nonce" — never a
    //    success, never silent).
    let impostor = Bridge::attach(Arc::clone(&client), header_id.clone(), "wrong-nonce".to_string());
    match impostor.request("tools.list", None, Some(Duration::from_secs(30))) {
        Err(BridgeError::Protocol(message)) => {
            assert!(message.contains("nonce"), "refusal names the nonce: {message}");
        }
        Err(BridgeError::Op(error)) => {
            assert!(error.message.contains("nonce"), "refusal names the nonce: {error}");
        }
        other => panic!("wrong nonce must be refused, got {other:?}"),
    }
    drop(impostor);

    // 4. Orderly shutdown.
    assert_eq!(client.close(CLOSE_GRACE), Some(0));
}

/// A fixture extension registering a provider, the way custom providers
/// (mirrors, proxies) register in real setups.
const PROVIDER_FIXTURE: &str = r#"
export default function providerFixture(pi) {
  pi.registerProvider("poc-fixture", {
    name: "PoC Fixture Provider",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "$POC_UNUSED_KEY",
    api: "openai-chat",
    models: [{
      id: "poc-fixture-model",
      name: "PoC Fixture Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    }],
  });
}
"#;

#[test]
fn real_pi_management_instance_enumerates_extension_providers() {
    let Some(_) = pi_bin() else {
        eprintln!("skipping: PI_CLI_BIN not set");
        return;
    };
    let sandbox = Sandbox::new("mgmt-providers");
    // The management-instance shape: --mode rpc --no-session, discovery off,
    // only the explicit fixture extension — no user session file is created
    // and no model is ever called.
    let fixture = sandbox.root.join("provider-fixture.mjs");
    std::fs::write(&fixture, PROVIDER_FIXTURE).expect("fixture");
    let executable = pi_bin().expect("PI_CLI_BIN");
    let client = PiRpcClient::spawn(
        &executable,
        SpawnOptions {
            args: vec![
                "--no-session".into(),
                "--no-extensions".into(),
                "--no-skills".into(),
                "--no-prompt-templates".into(),
                "--no-themes".into(),
                "--no-context-files".into(),
                "--extension".into(),
                fixture.to_string_lossy().into_owned(),
            ],
            cwd: Some(sandbox.work()),
            env: EnvPolicy::inherit()
                .set("PI_CODING_AGENT_DIR", sandbox.agent().to_string_lossy().into_owned())
                .set("POC_UNUSED_KEY", "x"),
            ..SpawnOptions::default()
        },
    )
    .expect("management-shaped pi spawns");

    // Provider enumeration is the child's own registry over the standard RPC:
    // extension-registered providers appear exactly like built-ins.
    let result = client
        .command("get_available_models", json!({}), Some(HANDSHAKE))
        .expect("get_available_models answers");
    let models = result["models"].as_array().expect("models array");
    let fixture_model = models
        .iter()
        .find(|model| model["provider"] == "poc-fixture")
        .expect("the extension-registered provider is enumerated");
    assert_eq!(fixture_model["id"], "poc-fixture-model");
    assert_eq!(fixture_model["api"], "openai-chat");

    // The management shape wrote no session file into the sandbox.
    assert_eq!(client.close(CLOSE_GRACE), Some(0));
    let sessions: Vec<_> = std::fs::read_dir(sandbox.sessions())
        .map(|entries| entries.filter_map(|entry| entry.ok()).collect())
        .unwrap_or_default();
    assert!(sessions.is_empty(), "--no-session created no session files: {sessions:?}");
}

#[test]
fn real_pi_bridge_rejects_unknown_ops() {
    let Some(_) = pi_bin() else {
        eprintln!("skipping: PI_CLI_BIN not set");
        return;
    };
    let sandbox = Sandbox::new("unknown-op");
    let header_id = write_session_header(&sandbox.session_file(), &sandbox.work());
    let asset = bridge_asset();
    let nonce = uuid::Uuid::new_v4().to_string();
    let client = sandbox.spawn_pi(
        &["--extension".into(), asset.to_string_lossy().into_owned()],
        &[("PI_WEB_BRIDGE_NONCE", nonce.clone())],
    );

    let state = get_state(&client);
    assert_eq!(state["sessionId"].as_str().expect("sessionId"), header_id);

    let bridge = Bridge::attach(Arc::clone(&client), header_id, nonce);
    match bridge.request("no.such.op", None, Some(Duration::from_secs(30))) {
        Err(BridgeError::Op(error)) => {
            assert!(error.message.contains("unknown bridge op"), "message: {error}");
        }
        other => panic!("unknown op must be refused, got {other:?}"),
    }
    assert_eq!(client.close(CLOSE_GRACE), Some(0));
}
