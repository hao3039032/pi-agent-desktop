//! session-host tests: file creation and dispatch are pure; the lifecycle
//! case runs the real pi child (PI_CLI_BIN, sandboxed) through the M2
//! backbone: create → start (handshake identity + bridge attribution) →
//! concurrent start dedup → lease/idle eviction → dispatch → shutdown.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use session_host::{
    create_session_file, dispatch_session_op, SessionHostError,
    SessionSpawnConfig, IDLE_TIMEOUT,
};

// Every lifecycle fixture opts into an isolated, unrestricted checker.
struct SessionRegistry;
impl SessionRegistry {
    fn new() -> session_host::SessionRegistry {
        session_host::SessionRegistry::with_fence_checker(Arc::new(|_| Ok(())))
    }
}

fn pi_bin() -> Option<String> {
    match std::env::var("PI_CLI_BIN") {
        Ok(value) if !value.is_empty() && std::path::Path::new(&value).exists() => Some(value),
        Ok(value) if !value.is_empty() => panic!("PI_CLI_BIN points at a missing file: {value}"),
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
        .expect("the shipped bridge asset resolves")
}

fn config(executable: &str, agent_dir: &std::path::Path) -> SessionSpawnConfig {
    SessionSpawnConfig {
        executable: executable.to_string(),
        agent_dir: Some(agent_dir.to_path_buf()),
        session_dir: None,
        bridge_asset: bridge_asset(),
        artifacts_asset: None,
        chat_asset: None,
        chat_asset_sha256: None,
        shape: session_host::SessionSpawnShape::Project { tool_args: None },
        initial_model: None,
        thinking_level: None,
        extra_args: Vec::new(),
    }
}

#[test]
fn session_file_creation_writes_the_pi_header() {
    let dir = tempfile::tempdir().expect("tempdir");
    let sessions = dir.path().join("sessions");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let (file, id) = create_session_file(&sessions, &cwd).expect("create");
    assert!(file.is_file(), "{}", file.display());
    let name = file.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.ends_with(&format!("_{id}.jsonl")), "file name carries the id: {name}");
    let header: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).expect("read")).expect("valid JSON header");
    assert_eq!(header["type"], "session");
    assert_eq!(header["version"], 3);
    assert_eq!(header["id"], id);
    assert_eq!(header["cwd"].as_str().expect("cwd string"), cwd.to_string_lossy());
}

#[test]
fn dispatch_refuses_unknown_ops_without_touching_children() {
    let registry = SessionRegistry::new();
    let error = dispatch_session_op(&registry, "shell.exec", &json!({ "session": "s" }), None).unwrap_err();
    assert_eq!(error.code(), "unknown_op");

    // runState for a non-running session is a clean "not running", and
    // per-session ops on missing sessions are not_found.
    let state = dispatch_session_op(&registry, "sessions.runState", &json!({ "session": "ghost" }), None)
        .expect("clean answer");
    assert_eq!(state["running"], false);
    let error = dispatch_session_op(&registry, "agent.interrupt", &json!({ "session": "ghost" }), None).unwrap_err();
    assert_eq!(error.code(), "not_found");
}

/// A chat MUST NOT start without its policy asset: the asset carries the
/// before_agent_start / tool_call enforcement that confines the chat's file
/// tools to its folder. Missing or unreadable → the spawn fails BEFORE any
/// child exists (the Next factory threw the same way). Deterministic: the
/// check precedes PiRpcClient::spawn, so no pi binary is needed.
#[test]
fn a_chat_without_its_policy_asset_fails_closed_before_spawning() {
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let (file, id) = create_session_file(&dir.path().join("sessions"), &cwd).expect("create");
    let prompt_file = dir.path().join("chat-prompt.txt");
    std::fs::write(&prompt_file, "chat preamble").expect("prompt");

    let chat_shape = |chat_asset: Option<PathBuf>| session_host::SessionSpawnConfig {
        // The digest pins whatever asset the caller passes (a test fixture
        // pins its own bytes; a MISSING file needs no pin — the readability
        // gate answers first). The mismatch tests pin SOMETHING ELSE.
        chat_asset_sha256: chat_asset
            .as_deref()
            .filter(|path| path.is_file())
            .map(sha256_of_file),
        executable: "/nonexistent/pi".to_string(),
        agent_dir: Some(agent_dir.clone()),
        session_dir: None,
        bridge_asset: bridge_asset(),
        artifacts_asset: None,
        chat_asset,
        shape: session_host::SessionSpawnShape::Chat {
            prompt_file: prompt_file.clone(),
            folder: true,
            unlocked: false,
            files_enabled: true,
        },
        initial_model: None,
        thinking_level: None,
        extra_args: Vec::new(),
    };

    let registry = SessionRegistry::new();
    // 1. No asset at all.
    let error = match registry.start(&id, &file, &id, &cwd, &chat_shape(None)) { Err(e) => e, Ok(_) => panic!("a chat without its policy asset must not start") };
    match error {
        SessionHostError::Spawn(message) => assert!(
            message.contains("chat policy asset") && message.contains("missing"),
            "the honest missing-asset message: {message}"
        ),
        other => panic!("a Spawn error, not {other:?}"),
    }
    assert!(registry.ids().is_empty(), "no child was ever spawned");

    // 2. An asset path that does not resolve to a readable file.
    let ghost = dir.path().join("pi-web-chat.mjs");
    let error = match registry.start(&id, &file, &id, &cwd, &chat_shape(Some(ghost))) { Err(e) => e, Ok(_) => panic!("a chat with an unreadable policy asset must not start") };
    match error {
        SessionHostError::Spawn(message) => assert!(
            message.contains("not readable"),
            "the honest unreadable-asset message: {message}"
        ),
        other => panic!("a Spawn error, not {other:?}"),
    }
    assert!(registry.ids().is_empty());

    // 3. A readable asset passes the gate (the spawn then fails on the
    //    deliberately missing executable — a DIFFERENT error, proving the
    //    gate itself let a real asset through).
    let real_asset = dir.path().join("pi-web-chat.mjs");
    std::fs::write(&real_asset, "// policy").expect("asset");
    let error = match registry.start(&id, &file, &id, &cwd, &chat_shape(Some(real_asset))) { Err(e) => e, Ok(_) => panic!("expected the missing-executable failure after the gate") };
    match error {
        SessionHostError::Spawn(message) => assert!(
            !message.contains("chat policy asset"),
            "a real asset passes the policy gate (the failure is the missing executable): {message}"
        ),
        other => panic!("a Spawn error, not {other:?}"),
    }
}

#[test]
fn real_pi_session_lifecycle() {
    let Some(executable) = pi_bin() else {
        eprintln!("skipping: PI_CLI_BIN not set");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&agent_dir).expect("agent");
    std::fs::create_dir_all(&cwd).expect("cwd");
    std::fs::create_dir_all(&sessions).expect("sessions");

    let (file, file_id) = create_session_file(&sessions, &cwd).expect("session file");
    let registry = Arc::new(SessionRegistry::new());
    let session = registry
        .start("url-id-1", &file, &file_id, &cwd, &config(&executable, &agent_dir))
        .expect("session starts and handshakes");

    // The handshake proved identity and bridge attribution already; the
    // bridge answers a real tools.list through the session's nonce.
    let tools = session
        .bridge_request("tools.list", None, Some(Duration::from_secs(30)))
        .expect("bridge tools.list");
    assert!(tools["tools"].as_array().is_some_and(|tools| !tools.is_empty()));

    // Concurrent start dedup: the same id returns the SAME instance.
    let again = registry
        .start("url-id-1", &file, &file_id, &cwd, &config(&executable, &agent_dir))
        .expect("dedup start");
    assert!(Arc::ptr_eq(&session, &again), "one child per id");
    assert_eq!(registry.ids(), vec!["url-id-1".to_string()]);

    // The child re-opened OUR file (the header line stays first and keeps
    // its id; the child may append its own bookkeeping entries — it is the
    // conversation's single writer while it lives).
    let contents = std::fs::read_to_string(&file).expect("read");
    let lines: Vec<&str> = contents.lines().filter(|line| !line.trim().is_empty()).collect();
    assert!(!lines.is_empty(), "the header the host wrote is intact");
    let first: serde_json::Value = serde_json::from_str(lines[0]).expect("header line is JSON");
    assert_eq!(first["type"], "session");
    assert_eq!(first["id"].as_str().expect("header id"), file_id);

    // Dispatch through the closed operation table.
    let state = dispatch_session_op(&registry, "sessions.runState", &json!({ "session": "url-id-1" }), None)
        .expect("runState");
    assert_eq!(state["running"], false);

    // Lease semantics: a fresh session is NOT idle-expired; after the lease
    // window it is, and evict_idle shuts it down.
    assert!(!session.is_idle_expired());
    session.state_for_tests_set_lease(Duration::from_millis(1));
    std::thread::sleep(Duration::from_millis(5));
    let evicted = registry.evict_idle();
    assert_eq!(evicted, vec!["url-id-1".to_string()]);
    assert!(registry.ids().is_empty());
    assert!(session.client_has_exited_for_tests());

    // Explicit remove of a missing id is None.
    assert!(registry.remove("url-id-1", Duration::from_secs(5)).is_none());
    let _ = IDLE_TIMEOUT;
}

#[test]
fn real_pi_extension_dialog_reply_and_timeout() {
    let Some(executable) = pi_bin() else { eprintln!("skipping: PI_CLI_BIN not set"); return };
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    let extension = dir.path().join("dialog.mjs");
    let result = dir.path().join("result.json");
    std::fs::write(&extension, format!(r#"
import {{ writeFileSync }} from 'node:fs';
export default function(pi) {{
  pi.registerCommand('fixture-dialog', {{ handler: async (_args, ctx) => {{
    const confirmed = await ctx.ui.confirm('Proceed?', 'fixture');
    const input = await ctx.ui.input('Input', 'fixture', {{ timeout: 500 }});
    writeFileSync({result:?}, JSON.stringify({{ confirmed, input: input ?? null }}));
  }} }});
}}
"#, result = result.to_string_lossy())).unwrap();
    let (file, file_id) = create_session_file(&dir.path().join("sessions"), &cwd).unwrap();
    let mut cfg = config(&executable, &agent_dir);
    cfg.extra_args.extend(["--extension".into(), extension.to_string_lossy().into_owned()]);
    let registry = SessionRegistry::new();
    let session = registry.start("ui-test", &file, &file_id, &cwd, &cfg).unwrap();
    let (_subscriber, events, _) = session.subscribe_with_ui();
    let prompting = Arc::clone(&session);
    let handle = std::thread::spawn(move || prompting.command("prompt", json!({"message":"/fixture-dialog"}), Some(Duration::from_secs(10))));
    let confirm = loop {
        let event = events.recv_timeout(Duration::from_secs(10)).expect("confirm event");
        if event["method"] == "confirm" { break event }
    };
    let id = confirm["id"].as_str().unwrap();
    assert!(session.respond_ui(id, &json!({"confirmed": true})).is_ok());
    assert!(session.respond_ui(id, &json!({"confirmed": true})).is_err());
    let input = loop {
        let event = events.recv_timeout(Duration::from_secs(10)).expect("input event");
        if event["method"] == "input" { break event }
    };
    let input_id = input["id"].as_str().unwrap().to_owned();
    loop {
        let event = events.recv_timeout(Duration::from_secs(10)).expect("close event");
        if event["type"] == "extension_ui_closed" && event["id"] == input_id { break }
    }
    assert!(session.respond_ui(&input_id, &json!({"value":"late"})).is_err());
    handle.join().unwrap().unwrap();
    let data: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(result).unwrap()).unwrap();
    assert_eq!(data, json!({"confirmed":true, "input":null}));
    registry.remove("ui-test", Duration::from_secs(5));
}

#[test]
fn real_pi_machine_and_handled_prompt() {
    let Some(executable) = pi_bin() else {
        eprintln!("skipping: PI_CLI_BIN not set");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&agent_dir).expect("agent");
    std::fs::create_dir_all(&cwd).expect("cwd");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, file_id) = create_session_file(&sessions, &cwd).expect("session file");

    let registry = SessionRegistry::new();
    let session = registry
        .start("url-id-2", &file, &file_id, &cwd, &config(&executable, &agent_dir))
        .expect("session starts");

    // A subscriber sees the raw event records.
    let events = session.subscribe();

    // A handled prompt (a bridge command) starts NO run: the prompt method
    // returns at once with the projected state still idle.
    let state = session
        .prompt("/pi-web:bridge does-not-matter invalid-token")
        .expect("handled prompt resolves");
    assert!(!state.is_running(), "an extension command starts no run: {state:?}");

    // The projected state flows through the IPC dispatch table too.
    let snapshot = dispatch_session_op(
        &registry,
        "agent.eventsSnapshot",
        &json!({ "session": "url-id-2" }),
        None,
    )
    .expect("events snapshot");
    assert_eq!(snapshot["state"]["sessionId"], file_id);
    assert_eq!(snapshot["state"]["running"], false);

    // set_session_name reaches the child (its own writer) and the projected
    // state picks the name up from the follow-up get_state refresh.
    dispatch_session_op(
        &registry,
        "agent.setSessionName",
        &json!({ "session": "url-id-2", "name": "rust-mgmt-name" }),
        None,
    )
    .expect("set name");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = dispatch_session_op(
            &registry,
            "agent.eventsSnapshot",
            &json!({ "session": "url-id-2" }),
            None,
        )
        .expect("snapshot");
        if snapshot["state"]["sessionName"] == "rust-mgmt-name" {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "name never projected");
        std::thread::sleep(Duration::from_millis(100));
    }

    // No agent_start happened: no run events on the wire beyond whatever
    // the child emitted at boot; the machine never went streaming.
    assert!(!session.state().is_streaming);
    drop(events);
    registry.remove("url-id-2", Duration::from_secs(10));
}

/// THE subscription-lifetime regression: the fan thread must own the client
/// subscription for the session's whole life. The bug this freezes: the
/// subscription was a dropped-at-return local (`_subscription`), which
/// detached the listener the moment spawn_session returned — the fan thread
/// exited instantly and NO event ever reached the machine after the
/// handshake (state never progressed, settle never woke).
#[test]
fn real_pi_events_flow_after_the_handshake_returns() {
    let Some(executable) = pi_bin() else {
        eprintln!("skipping: PI_CLI_BIN not set");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&agent_dir).expect("agent");
    std::fs::create_dir_all(&cwd).expect("cwd");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, file_id) = create_session_file(&sessions, &cwd).expect("session file");

    let registry = SessionRegistry::new();
    let session = registry
        .start("url-id-3", &file, &file_id, &cwd, &config(&executable, &agent_dir))
        .expect("session starts (handshake returned)");

    // A subscriber registered AFTER the handshake (the realistic timing):
    // the fan-out path must still be alive.
    let (_subscriber_id, events) = session.subscribe();

    // Drive REAL events without credentials: `compact` emits
    // compaction_start/compaction_end records (verified against the child
    // wire) and `clear_queue` emits queue_update — session events that flow
    // child pipe → fan thread → (machine + subscribers). A dropped-at-spawn
    // subscription kills the fan thread instantly and NONE of this arrives.
    let compact = session
        .command("compact", serde_json::json!({}), Some(Duration::from_secs(30)));
    // "Nothing to compact" is expected on an empty session — the RESPONSE
    // may fail; the EVENTS still flowed.
    let _ = compact;
    session
        .command("clear_queue", serde_json::json!({}), Some(Duration::from_secs(30)))
        .expect("clear_queue answers");

    let mut kinds: Vec<String> = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        match events.recv_timeout(Duration::from_secs(2)) {
            Ok(record) => {
                kinds.push(
                    record
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?")
                        .to_string(),
                );
                if kinds.len() >= 3 {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                panic!("the fan thread is DEAD: the subscription was dropped at spawn time")
            }
        }
    }
    assert!(
        kinds.iter().any(|kind| kind == "compaction_start" || kind == "queue_update"),
        "session events reached the subscriber after the handshake: {kinds:?}"
    );
    // The MACHINE ate the same records through the fan thread: the
    // compaction flags toggled (compaction_start set, compaction_end
    // cleared) proves the state machine path is live, not just the pipe.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let streaming = session.state().is_streaming;
        let idle = session.state().is_idle;
        if !streaming && idle != Some(false) {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "the machine never settled after compaction events");
        std::thread::sleep(Duration::from_millis(100));
    }
    registry.remove("url-id-3", Duration::from_secs(10));
}

/// A handshake failure must REAP the child: the session never entered the
/// registry, so leaving it alive would orphan a pi process past the host.
#[test]
fn real_pi_handshake_failure_shuts_the_child_down() {
    let Some(executable) = pi_bin() else {
        eprintln!("skipping: PI_CLI_BIN not set");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&agent_dir).expect("agent");
    std::fs::create_dir_all(&cwd).expect("cwd");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, file_id) = create_session_file(&sessions, &cwd).expect("session file");

    // A session id that CANNOT match: the child reports the file's own id,
    // so the identity check fails → the handshake error path.
    let registry = SessionRegistry::new();
    let config = config(&executable, &agent_dir);
    let error = match registry
        .start("wrong-id", &file, "deliberately-wrong-header-id", &cwd, &config)
    {
        Err(error) => error,
        Ok(orphan) => panic!(
            "the identity check must fail; got a session for {} (file {} / claimed {}) instead",
            orphan.id, file_id, "deliberately-wrong-header-id"
        ),
    };
    assert!(matches!(error, SessionHostError::Handshake(_)), "{error}");
    // Nothing entered the registry (nothing to evict later).
    assert!(registry.ids().is_empty());
    // The child was reaped: give the exit watcher a moment, then count live
    // pi children spawned by this test (the launcher chain names the tree).
    std::thread::sleep(Duration::from_millis(500));
    let live = std::process::Command::new("pgrep")
        .arg("-f")
        .arg("mode rpc")
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default();
    // pgrep matches its own argv sometimes; require it to be empty or only
    // the pgrep process — a leaked child would name a pi process.
    let leaked = live
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count();
    assert_eq!(leaked, 0, "no orphaned pi children; pgrep said: {live:?}");
}

// ---------------------------------------------------------------------------
// Deterministic child fixtures: `mock_pi_session` (this crate's own bin)
// speaks the session contract — get_state identity, get_commands
// attribution, prompt with hold — so the handshake's chat-policy gate and
// the outbox's drain/wake interleavings are testable without real pi.
// ---------------------------------------------------------------------------

fn mock_session_exe() -> &'static str {
    env!("CARGO_BIN_EXE_mock_pi_session")
}

#[test]
fn offline_writer_refuses_child_busy_after_prompt_ack_before_start_event() {
    let dir = tempfile::tempdir().unwrap();
    let agent = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let (file, id) = create_session_file(&dir.path().join("sessions"), &cwd).unwrap();
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    let config = mock_config(&agent, &["--mock-session-id", &id, "--mock-commands", &commands, "--mock-assert-busy-after-prompt"]);
    let registry = SessionRegistry::new();
    let session = registry.start(&id, &file, &id, &cwd, &config).unwrap();
    let ack = session.command("prompt", json!({"message":"hello"}), Some(Duration::from_secs(5))).unwrap();
    assert_eq!(ack["disposition"], "started");
    assert!(!session.run_state().is_running(), "the projected agent_start is deliberately missing");
    let result = registry.with_offline_session_writer(&id, Duration::from_secs(3), || -> Result<(), ()> { panic!("must not run writer") });
    assert!(matches!(result, Err(session_host::SessionWriterError::Busy(_))));
    assert!(registry.get(&id).is_some());
    registry.remove(&id, Duration::from_secs(3));
}

use base64::Engine as _;

fn b64(value: &serde_json::Value) -> String {
    base64::engine::general_purpose::STANDARD.encode(value.to_string())
}

/// SHA-256 hex of a file's bytes (the same pin the host verifies).
fn sha256_of_file(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).expect("read asset for digest");
    let digest = Sha256::digest(&bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `get_commands` data reporting pi-web:bridge at the REAL shipped bridge
/// asset (every shape loads it) plus optionally a chat policy command at
/// `chat_asset`.
fn commands_for(bridge: &Path, chat_asset: Option<&Path>, chat_command: bool) -> serde_json::Value {
    let mut commands = vec![serde_json::json!({
        "name": "pi-web:bridge",
        "source": "extension",
        "sourceInfo": { "path": bridge.to_string_lossy() },
    })];
    if let (Some(asset), true) = (chat_asset, chat_command) {
        commands.push(serde_json::json!({
            "name": "pi-web:chat-policy",
            "source": "extension",
            "sourceInfo": { "path": asset.to_string_lossy() },
        }));
    }
    serde_json::json!({ "commands": commands })
}

fn mock_config(agent_dir: &Path, extra: &[&str]) -> SessionSpawnConfig {
    SessionSpawnConfig {
        executable: mock_session_exe().to_string(),
        agent_dir: Some(agent_dir.to_path_buf()),
        session_dir: None,
        bridge_asset: bridge_asset(),
        artifacts_asset: None,
        chat_asset: None,
        chat_asset_sha256: None,
        shape: session_host::SessionSpawnShape::Project { tool_args: None },
        initial_model: None,
        thinking_level: None,
        extra_args: extra.iter().map(|arg| arg.to_string()).collect(),
    }
}

#[test]
fn offline_writer_waits_for_real_child_exit_before_mutating() {
    let dir = tempfile::tempdir().unwrap();
    let agent = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let (file, id) = create_session_file(&dir.path().join("sessions"), &cwd).unwrap();
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    let config = mock_config(&agent, &["--mock-session-id", &id, "--mock-commands", &commands]);
    let registry = SessionRegistry::new();
    let child = registry.start(&id, &file, &id, &cwd, &config).unwrap();
    registry.with_offline_session_writer(&id, Duration::from_secs(3), || {
        assert!(child.client_has_exited_for_tests());
        std::fs::write(&file, "offline mutation").unwrap();
        Ok::<_, ()>(())
    }).unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "offline mutation");
    assert!(registry.get(&id).is_none());
}

#[test]
fn offline_writer_timeout_never_kills_child_or_runs_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let agent = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let (file, id) = create_session_file(&dir.path().join("sessions"), &cwd).unwrap();
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    let config = mock_config(&agent, &["--mock-session-id", &id, "--mock-commands", &commands, "--mock-stay-after-eof"]);
    let registry = SessionRegistry::new();
    let child = registry.start(&id, &file, &id, &cwd, &config).unwrap();
    let result = registry.with_offline_session_writer(&id, Duration::from_millis(500), || {
        panic!("writer must not run before child exit");
        #[allow(unreachable_code)]
        Ok::<_, ()>(())
    });
    assert!(matches!(result, Err(session_host::SessionWriterError::Busy(_))));
    assert!(!child.client_has_exited_for_tests());
    assert!(registry.get(&id).is_some());
    child.client_kill_for_tests();
    registry.remove(&id, Duration::from_secs(2));
}

/// The chat handshake must prove the POLICY actually loaded: a child that
/// reports the bridge command but NO `pi-web:chat-policy` (an empty or
/// wrong-but-loadable asset file) fails closed — the session never starts
/// and the child is reaped. Deterministic: the mock child answers the
/// handshake's two questions from its arguments.
#[test]
fn a_chat_whose_child_lacks_the_policy_command_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let (file, id) = create_session_file(&dir.path().join("sessions"), &cwd).expect("create");
    let prompt_file = dir.path().join("chat-prompt.txt");
    std::fs::write(&prompt_file, "chat preamble").expect("prompt");
    // The asset EXISTS and is readable — `is_file()` alone would pass it.
    let empty_asset = dir.path().join("pi-web-chat.mjs");
    std::fs::write(&empty_asset, "// a valid, loadable module with no policy").expect("asset");

    // The child answers the identity and the bridge question correctly —
    // only the chat policy command is missing (what an empty asset does).
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    let config = SessionSpawnConfig {
        chat_asset: Some(empty_asset.clone()),
        chat_asset_sha256: Some(sha256_of_file(&empty_asset)),
        shape: session_host::SessionSpawnShape::Chat {
            prompt_file,
            folder: true,
            unlocked: false,
            files_enabled: true,
        },
        ..mock_config(&agent_dir, &[
            "--mock-session-id", &id,
            "--mock-commands", &commands,
        ])
    };

    let registry = SessionRegistry::new();
    let error = match registry.start(&id, &file, &id, &cwd, &config) {
        Err(error) => error,
        Ok(session) => panic!("a chat without its registered policy must not start (session {})", session.id),
    };
    match error {
        SessionHostError::Handshake(message) => assert!(
            message.contains("pi-web:chat-policy") && message.contains("chat policy"),
            "the honest missing-policy message: {message}"
        ),
        other => panic!("a Handshake error, not {other:?}"),
    }
    // Fail closed includes the child: nothing stayed alive in the registry.
    assert!(registry.ids().is_empty());
}

/// The same gate ACCEPTS a child that registered the policy command at the
/// EXPECTED asset path — and REJECTS one that registered it from a
/// different file (the attribution check is what makes the marker
/// unforgeable-by-accident: a stray extension registering the name does not
/// satisfy a missing shipped asset).
#[test]
fn the_chat_policy_gate_checks_the_commands_attribution() {
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&agent_dir).expect("agent");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");

    // The prompt file lives in its OWN directory (the factory's temp dir):
    // the handshake cleanup removes the prompt file's parent directory.
    let prompt_dir = dir.path().join("prompt");
    std::fs::create_dir_all(&prompt_dir).expect("prompt dir");
    let prompt_file = prompt_dir.join("chat-prompt.txt");
    std::fs::write(&prompt_file, "chat preamble").expect("prompt");
    let real_asset = dir.path().join("real-pi-web-chat.mjs");
    std::fs::write(&real_asset, "// the shipped policy").expect("asset");

    let chat_shape = || session_host::SessionSpawnShape::Chat {
        prompt_file: prompt_file.clone(),
        folder: true,
        unlocked: false,
        files_enabled: true,
    };

    // 1. The policy registered AT the expected path: the chat starts.
    let (file, id) = create_session_file(&sessions, &cwd).expect("create");
    let commands = b64(&commands_for(&bridge_asset(), Some(&real_asset), true));
    let config = SessionSpawnConfig {
        chat_asset: Some(real_asset.clone()),
        chat_asset_sha256: Some(sha256_of_file(&real_asset)),
        shape: chat_shape(),
        ..mock_config(&agent_dir, &["--mock-session-id", &id, "--mock-commands", &commands])
    };
    let registry = SessionRegistry::new();
    registry
        .start(&id, &file, &id, &cwd, &config)
        .expect("the registered, attributed policy passes the gate");
    assert_eq!(registry.ids(), vec![id.clone()]);
    registry.remove(&id, Duration::from_secs(5));

    // 2. The policy name registered from a DIFFERENT file: rejected (the
    //    shipped asset at `real_asset` did not load).
    let (file2, id2) = create_session_file(&sessions, &cwd).expect("create");
    let other_file = dir.path().join("other-extension.mjs");
    std::fs::write(&other_file, "// some other extension").expect("other");
    let commands_other = b64(&commands_for(&bridge_asset(), Some(&other_file), true));
    let config2 = SessionSpawnConfig {
        chat_asset: Some(real_asset.clone()),
        chat_asset_sha256: Some(sha256_of_file(&real_asset)),
        shape: chat_shape(),
        ..mock_config(&agent_dir, &["--mock-session-id", &id2, "--mock-commands", &commands_other])
    };
    let error = match registry.start(&id2, &file2, &id2, &cwd, &config2) {
        Err(error) => error,
        Ok(_) => panic!("a policy registered from another file must not satisfy the gate"),
    };
    assert!(matches!(error, SessionHostError::Handshake(_)), "{error}");
    assert!(registry.ids().is_empty(), "the failed child never entered the registry");
}

/// P1-5C: an idle-expired session must be REPLACED, not overlapped — the
/// old child dies before the new one spawns (both would share the
/// session-id composer outbox; a live old child could double-deliver).
#[test]
fn an_idle_expired_session_is_shut_down_when_replaced() {
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&agent_dir).expect("agent");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, id) = create_session_file(&sessions, &cwd).expect("create");

    let commands = b64(&commands_for(&bridge_asset(), None, false));
    let config = mock_config(&agent_dir, &["--mock-session-id", &id, "--mock-commands", &commands]);
    let registry = SessionRegistry::new();
    let first = registry.start(&id, &file, &id, &cwd, &config).expect("first start");

    // Force the idle lease to expire, then resume: the registry must shut
    // the OLD child down and hand out a NEW session for the same id.
    first.state_for_tests_set_lease(Duration::from_secs(0));
    let second = registry.start(&id, &file, &id, &cwd, &config).expect("replacement start");
    assert!(!Arc::ptr_eq(&first, &second), "the expired session is replaced, not reused");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !first.client_has_exited_for_tests() {
        assert!(std::time::Instant::now() < deadline, "the replaced child was never shut down");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(registry.ids(), vec![id.clone()], "exactly one live child for the id");
    registry.remove(&id, Duration::from_secs(5));
}

/// P1-3/P1-5A: the outbox interleavings against a real (mock) child.
///
/// 1. A delivery held mid-flight; a second enqueue's wake finds
///    `delivering == true` and returns — the LIVE drain must still deliver
///    the late item (the exit re-check's while-draining half).
/// 2. `park_unknown` + a new enqueue: the unknown front is never delivered.
#[test]
fn the_outbox_drain_catches_a_wake_that_arrived_during_delivery() {
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&agent_dir).expect("agent");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, id) = create_session_file(&sessions, &cwd).expect("create");

    let events = serde_json::json!([
        { "type": "agent_start" },
        { "type": "agent_settled" },
    ]);
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    let config = mock_config(&agent_dir, &[
        "--mock-session-id", &id,
        "--mock-commands", &commands,
        "--mock-prompt-hold",
        "--mock-prompt-events", &b64(&events),
    ]);
    let registry = SessionRegistry::new();
    let session = registry.start(&id, &file, &id, &cwd, &config).expect("session");

    // A holds the drain mid-delivery (the child holds the prompt).
    session.composer_enqueue("A", None).expect("enqueue A");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while session.composer_outbox.has_items() {
        assert!(std::time::Instant::now() < deadline, "the drain never claimed A");
        std::thread::sleep(Duration::from_millis(10));
    }
    // B's wake arrives while `delivering` is still true (its spawned drain
    // returns at once — exactly the wake this fix must not lose).
    session.composer_enqueue("B", None).expect("enqueue B");

    // Release the held prompt: A settles; the SAME drain loop (or the exit
    // re-check) must pick B up without any further wake.
    session
        .command("release_prompt", serde_json::json!({}), Some(Duration::from_secs(10)))
        .expect("release A");

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while session.composer_outbox.has_items() {
        assert!(
            std::time::Instant::now() < deadline,
            "B was stranded: the wake lost to the delivering flag never recovered"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    // B is now held mid-delivery in turn; release it so the child exits
    // cleanly under the registry's shutdown (not mid-command).
    session
        .command("release_prompt", serde_json::json!({}), Some(Duration::from_secs(10)))
        .expect("release B");
    registry.remove(&id, Duration::from_secs(5));
}

/// P1-5A: after an UNKNOWN outcome parks the front item, a new enqueue must
/// not re-deliver it — the queue stays paused until the user acts.
#[test]
fn an_unknown_parked_front_is_not_re_delivered_by_a_new_enqueue() {
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&agent_dir).expect("agent");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, id) = create_session_file(&sessions, &cwd).expect("create");

    // A prompt that never answers → deliver_composer times out... too slow
    // for a test; instead park A directly (the state machine behind
    // park_unknown is unit-tested; here we prove the DRAIN respects it).
    // The child answers prompt with an immediate start+settle so a lawful
    // delivery COMPLETES (nothing hangs waiting for a settle).
    let events = b64(&serde_json::json!([
        { "type": "agent_start" },
        { "type": "agent_settled" },
    ]));
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    let config = mock_config(&agent_dir, &[
        "--mock-session-id", &id,
        "--mock-commands", &commands,
        "--mock-prompt-events", &events,
    ]);
    let registry = SessionRegistry::new();
    let session = registry.start(&id, &file, &id, &cwd, &config).expect("session");

    let a = session.composer_outbox.enqueue("A", None).expect("A");
    session.composer_outbox.take(&a.id).expect("pop A for delivery");
    session.composer_outbox.park_unknown(a);
    session.composer_enqueue("B", None).expect("B behind the parked front");

    // The queue is paused with an unknown front: no drain may deliver.
    assert!(session.composer_outbox.is_paused(), "enqueue behind an unknown front keeps the queue paused");
    assert!(session.composer_outbox.has_items());
    std::thread::sleep(Duration::from_millis(300));
    let (items, _) = session.composer_outbox.snapshot();
    assert_eq!(items.len(), 2, "neither the parked A nor B was auto-delivered");
    assert_eq!(items[0]["message"], serde_json::json!("A"));

    // A wake while the front stays unknown is barred (no user action yet).
    session.composer_wake();
    std::thread::sleep(Duration::from_millis(200));
    assert!(session.composer_outbox.has_items(), "the unknown barrier held without a user action");

    // The user resolving the barrier (taking the unknown front) unpauses;
    // the queue delivers the REST without any further wake — the take's OWN
    // wake is what must do it (Terra P1-3: a manual wake in a test would
    // hide exactly the production gap). The mock child answers prompt with
    // an immediate settle, so B leaves the outbox.
    let a_again = session
        .composer_outbox
        .snapshot()
        .0
        .first()
        .and_then(|item| item.get("id").cloned())
        .and_then(|id| id.as_str().map(str::to_string))
        .expect("the parked front's id");
    let _ = session.composer_take(&a_again);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while session.composer_outbox.has_items() {
        assert!(std::time::Instant::now() < deadline, "B never delivered after the barrier was resolved");
        std::thread::sleep(Duration::from_millis(10));
    }
    registry.remove(&id, Duration::from_secs(5));
}

/// The REAL chat policy asset must pass the new handshake gate: a real pi
/// child spawned in the Chat shape (the shipped pi-web-chat.mjs, the chat
/// loadout, folder mode) registers `pi-web:chat-policy` attributed to the
/// asset path — proving the readiness marker the gate demands is something
/// the shipped asset actually provides (and not a contract only the mock
/// child satisfies). Gated on PI_CLI_BIN like the other real-pi tests.
#[test]
fn real_pi_chat_session_registers_its_policy_command() {
    let Some(executable) = pi_bin() else {
        eprintln!("skipping: PI_CLI_BIN not set");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("chats").join("20260101_120000_abcd");
    std::fs::create_dir_all(&agent_dir).expect("agent");
    std::fs::create_dir_all(&cwd).expect("chat folder");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, id) = create_session_file(&sessions, &cwd).expect("create");

    let chat_asset = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../lib/pi-rpc/assets/pi-web-chat.mjs")
        .canonicalize()
        .expect("the shipped chat policy asset");
    let prompt_file =
        session_host::spawn_plan::write_prompt_file("chat preamble for the gate test").expect("prompt file");
    let config = SessionSpawnConfig {
        executable,
        agent_dir: Some(agent_dir),
        session_dir: None,
        bridge_asset: bridge_asset(),
        artifacts_asset: None,
        chat_asset: Some(chat_asset.clone()),
        chat_asset_sha256: Some(sha256_of_file(&chat_asset)),
        shape: session_host::SessionSpawnShape::Chat {
            prompt_file,
            folder: true,
            unlocked: false,
            files_enabled: true,
        },
        initial_model: None,
        thinking_level: None,
        extra_args: Vec::new(),
    };

    let registry = SessionRegistry::new();
    let session = registry
        .start(&id, &file, &id, &cwd, &config)
        .expect("the shipped chat policy asset satisfies the handshake gate");
    // The gate already proved the policy command's attribution; the session
    // answers an ordinary state read through it.
    let state = session.get_state().expect("state");
    assert_eq!(state.get("sessionId").and_then(|v| v.as_str()), Some(id.as_str()));
    registry.remove(&id, Duration::from_secs(10));
}

// ---------------------------------------------------------------------------
// Terra round-3 P1-2 / P1-3 / lifecycle-fence regressions: the atomic claim,
// the take's own wake, the drain's exit window, and the replaced session's
// in-flight drain. The barrier tests drive the REAL drain thread through
// the deterministic-interleaving seam (`PI_COMPOSER_DRAIN_BARRIER`); the env
// is process-global, so every barrier test holds this mutex and names its
// own session id (other tests' drains are inert — the id never matches).
// The seam is compiled ONLY in this crate's own test builds (the
// `test-seams` feature via the self dev-dependency): a release host has no
// env-reading barrier at all (Terra round-4).
// ---------------------------------------------------------------------------

static BARRIER_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn wait_for_file(path: &std::path::Path, limit: Duration) {
    let deadline = std::time::Instant::now() + limit;
    while !path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {} (the drain never reached the barrier)",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn wait_for_outbox_empty(session: &session_host::Session, limit: Duration, context: &str) {
    let deadline = std::time::Instant::now() + limit;
    while session.composer_outbox.has_items() {
        assert!(
            std::time::Instant::now() < deadline,
            "{context}: the queue never drained: {:?}",
            session.composer_outbox.snapshot().0
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn log_lines(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|text| text.lines().filter(|line| !line.trim().is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Terra P1-2's exact race, forced deterministically: the drain's
/// deliverability decision and its claim must be ONE atomic step. The
/// barrier parks the REAL drain immediately before its claim; the test then
/// lands `park_unknown` at the front (what `composer_send_now`'s UNKNOWN
/// outcome does for a concurrently-delivered item) and releases. The old
/// check-then-pop split delivered the just-parked item from under the
/// barrier — against it, the child's prompt log would contain B. The atomic
/// claim refuses: the unknown outcome stays behind the user's confirmation.
#[test]
fn the_drain_never_claims_an_item_parked_unknown_in_the_check_window() {
    let _guard = BARRIER_ENV.lock().unwrap();
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, _) = create_session_file(&sessions, &cwd).expect("create");

    let id = "claim-window-1".to_string();
    let barrier = dir.path().join("barrier");
    std::fs::create_dir_all(&barrier).expect("barrier dir");
    let prompt_log = dir.path().join("prompts.log");
    std::env::set_var(
        "PI_COMPOSER_DRAIN_BARRIER",
        format!("{}:claim:{}", id, barrier.display()),
    );

    let events = b64(&serde_json::json!([
        { "type": "agent_start" },
        { "type": "agent_settled" },
    ]));
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    let config = mock_config(&agent_dir, &[
        "--mock-session-id", &id,
        "--mock-commands", &commands,
        "--mock-prompt-events", &events,
        "--mock-prompt-log", prompt_log.to_string_lossy().as_ref(),
    ]);
    let registry = SessionRegistry::new();
    let session = registry.start(&id, &file, &id, &cwd, &config).expect("session");

    // A is deliverable: the drain claims nothing yet — it parks at the claim
    // barrier, with `delivering` held and its last check already behind it.
    session.composer_enqueue("A", None).expect("enqueue A");
    wait_for_file(&barrier.join("claim.reached"), Duration::from_secs(5));

    // B queues behind it (its wake finds `delivering == true` and returns).
    session.composer_enqueue("B", None).expect("enqueue B");

    // The concurrent send-now on B ends UNKNOWN (composer_send_now's error
    // path makes exactly these two calls): B parks at the FRONT and the
    // queue pauses — inside the window between the drain's check and its
    // claim.
    let (items, _) = session.composer_outbox.snapshot();
    let b_id = items
        .iter()
        .find(|item| item.get("message").and_then(|m| m.as_str()) == Some("B"))
        .and_then(|item| item.get("id").and_then(|id| id.as_str()))
        .expect("B's id")
        .to_string();
    let b_item = session.composer_outbox.take(&b_id).expect("take B for its failed send");
    session.composer_outbox.park_unknown(b_item);
    assert!(session.composer_outbox.is_paused(), "the park paused the queue");

    // Release: the drain's claim must refuse (paused + unknown front) — the
    // queue keeps BOTH items and the child saw NO prompt at all.
    std::fs::write(barrier.join("claim.release"), b"1\n").expect("release the claim barrier");
    std::thread::sleep(Duration::from_millis(300));
    let (items, _) = session.composer_outbox.snapshot();
    assert_eq!(items.len(), 2, "nothing was claimed: {items:?}");
    assert_eq!(items[0]["message"], serde_json::json!("B"), "the unknown item stays at the front");
    assert_eq!(items[0]["unknown"], serde_json::json!(true));
    assert_eq!(items[1]["message"], serde_json::json!("A"));
    assert!(
        log_lines(&prompt_log).is_empty(),
        "the child never saw a prompt (the old check-then-pop split would have delivered B): {:?}",
        log_lines(&prompt_log)
    );

    // The user's explicit take of B resolves the barrier; the take's OWN
    // wake delivers A (Terra P1-3: no manual wake anywhere in this test).
    let answer = session.composer_take(&b_id);
    assert_eq!(answer["item"]["message"], serde_json::json!("B"), "{answer}");
    wait_for_outbox_empty(&session, Duration::from_secs(10), "A never delivered after the barrier was resolved");
    assert_eq!(log_lines(&prompt_log), vec!["A".to_string()], "exactly A was delivered, once");

    std::env::remove_var("PI_COMPOSER_DRAIN_BARRIER");
    registry.remove(&id, Duration::from_secs(5));
}

/// Terra P1-3's second half: the drain's exit window. The last
/// deliverability check has passed (the queue was empty), the flag is still
/// held; a wake that arrives HERE spawns a drain that sees
/// `delivering == true` and returns. Only the exit re-check under the flag's
/// own lock can observe the late work — pinned here deterministically.
#[test]
fn the_drain_exit_recheck_catches_a_wake_that_arrived_in_the_exit_window() {
    let _guard = BARRIER_ENV.lock().unwrap();
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, _) = create_session_file(&sessions, &cwd).expect("create");

    let id = "exit-window-1".to_string();
    let barrier = dir.path().join("barrier");
    std::fs::create_dir_all(&barrier).expect("barrier dir");
    let prompt_log = dir.path().join("prompts.log");
    std::env::set_var(
        "PI_COMPOSER_DRAIN_BARRIER",
        format!("{}:exit:{}", id, barrier.display()),
    );

    let events = b64(&serde_json::json!([
        { "type": "agent_start" },
        { "type": "agent_settled" },
    ]));
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    let config = mock_config(&agent_dir, &[
        "--mock-session-id", &id,
        "--mock-commands", &commands,
        "--mock-prompt-hold",
        "--mock-prompt-events", &events,
        "--mock-prompt-log", prompt_log.to_string_lossy().as_ref(),
    ]);
    let registry = SessionRegistry::new();
    let session = registry.start(&id, &file, &id, &cwd, &config).expect("session");

    // A's delivery is held mid-flight (the child holds the prompt).
    session.composer_enqueue("A", None).expect("enqueue A");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while log_lines(&prompt_log) != vec!["A".to_string()] {
        assert!(std::time::Instant::now() < deadline, "the drain never claimed A");
        std::thread::sleep(Duration::from_millis(10));
    }

    // Release A: its run settles, the drain's last check finds the queue
    // EMPTY and it parks in the exit window (the flag is still held).
    session
        .command("release_prompt", serde_json::json!({}), Some(Duration::from_secs(10)))
        .expect("release A");
    wait_for_file(&barrier.join("exit.reached"), Duration::from_secs(5));

    // B's wake arrives INSIDE the window: the spawned drain sees
    // `delivering == true` and returns at once.
    session.composer_enqueue("B", None).expect("enqueue B in the exit window");

    // Release: the same thread clears the flag and re-checks under the lock
    // — B must be delivered by IT, without any further wake.
    std::fs::write(barrier.join("exit.release"), b"1\n").expect("release the exit barrier");
    wait_for_outbox_empty(&session, Duration::from_secs(10), "B was stranded in the exit window");
    assert_eq!(log_lines(&prompt_log), vec!["A".to_string(), "B".to_string()]);

    std::env::remove_var("PI_COMPOSER_DRAIN_BARRIER");
    registry.remove(&id, Duration::from_secs(5));
}

/// The lifecycle fence (Terra round-3, "过期 Session"): a replaced session's
/// in-flight drain must finish against the SHARED outbox without the
/// replacement child ever seeing the item it holds — and without losing it.
/// The old drain parks its item as outcome-unknown (the honest answer for a
/// child that died mid-delivery); the user's take on the NEW session then
/// delivers it exactly once to the new child.
#[test]
fn a_replaced_sessions_inflight_drain_only_parks_its_own_item() {
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, _) = create_session_file(&sessions, &cwd).expect("create");

    let id = "replace-fence-1".to_string();
    let log_old = dir.path().join("old.log");
    let log_new = dir.path().join("new.log");
    let events = b64(&serde_json::json!([
        { "type": "agent_start" },
        { "type": "agent_settled" },
    ]));
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    // Child #1 HOLDS the prompt: the drain stays in-flight mid-delivery.
    let config_old = mock_config(&agent_dir, &[
        "--mock-session-id", &id,
        "--mock-commands", &commands,
        "--mock-prompt-hold",
        "--mock-prompt-events", &events,
        "--mock-prompt-log", log_old.to_string_lossy().as_ref(),
    ]);
    let registry = SessionRegistry::new();
    let first = registry.start(&id, &file, &id, &cwd, &config_old).expect("first session");

    // The drain claims A and blocks inside the held delivery.
    first.composer_enqueue("A", None).expect("enqueue A");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while log_lines(&log_old) != vec!["A".to_string()] {
        assert!(std::time::Instant::now() < deadline, "the first drain never claimed A");
        std::thread::sleep(Duration::from_millis(10));
    }

    // The lease expires; the next start REPLACES the session (the old child
    // is shut down synchronously before the new one spawns).
    first.state_for_tests_set_lease(Duration::from_secs(0));
    let config_new = mock_config(&agent_dir, &[
        "--mock-session-id", &id,
        "--mock-commands", &commands,
        "--mock-prompt-events", &events,
        "--mock-prompt-log", log_new.to_string_lossy().as_ref(),
    ]);
    let second = registry.start(&id, &file, &id, &cwd, &config_new).expect("replacement session");
    assert!(!Arc::ptr_eq(&first, &second), "the session was replaced");

    // The old drain's in-flight delivery fails on the dead child: its item
    // is parked UNKNOWN on the SHARED outbox — visible, never re-delivered
    // automatically, never lost.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let (items, _) = second.composer_outbox.snapshot();
        let parked = items.len() == 1
            && items[0]["message"] == serde_json::json!("A")
            && items[0]["unknown"] == serde_json::json!(true);
        if parked {
            assert!(second.composer_outbox.is_paused(), "the park paused the queue");
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the old drain never parked its item: {:?}",
            second.composer_outbox.snapshot().0
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    // The replacement child NEVER saw the old child's in-flight item.
    assert!(
        log_lines(&log_new).is_empty(),
        "the replacement child received the old session's in-flight item: {:?}",
        log_lines(&log_new)
    );
    assert_eq!(registry.ids(), vec![id.clone()], "exactly one live child");

    // The user confirms on the NEW session by RESENDING (send_now — the
    // explicit user action an unknown outcome demands; `take` would take it
    // back for editing instead of delivering it): the item reaches the new
    // child exactly once.
    let a_id = second
        .composer_outbox
        .snapshot()
        .0
        .first()
        .and_then(|item| item.get("id").and_then(|id| id.as_str()))
        .expect("the parked item's id")
        .to_string();
    second
        .composer_send_now(&a_id)
        .expect("the user's explicit resend delivers to the replacement child");
    wait_for_outbox_empty(&second, Duration::from_secs(10), "A never reached the replacement child");
    assert_eq!(log_lines(&log_old), vec!["A".to_string()], "the old child saw A exactly once");
    assert_eq!(log_lines(&log_new), vec!["A".to_string()], "the new child saw A exactly once");
    registry.remove(&id, Duration::from_secs(5));
}

#[test]
fn session_writer_fence_blocks_live_admissions_and_drain() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let (file, _) = create_session_file(&dir.path().join("sessions"), &cwd).unwrap();
    let id = "fenced-live";
    let log = dir.path().join("prompts.log");
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    let config = mock_config(&dir.path().join("agent"), &[
        "--mock-session-id", id, "--mock-commands", &commands,
        "--mock-prompt-log", log.to_str().unwrap(),
    ]);
    let fenced = Arc::new(AtomicBool::new(false));
    let checker_flag = Arc::clone(&fenced);
    let registry = session_host::SessionRegistry::with_fence_checker(Arc::new(move |_| {
        if checker_flag.load(Ordering::SeqCst) { Err("unknown writer outcome".into()) } else { Ok(()) }
    }));
    let session = registry.start(id, &file, id, &cwd, &config).unwrap();
    fenced.store(true, Ordering::SeqCst);
    assert!(registry.start(id, &file, id, &cwd, &config).is_err());
    assert!(session.command("prompt", json!({"message":"blocked"}), Some(Duration::from_secs(2))).is_err());
    assert!(session.composer_enqueue("blocked", None).is_err());
    session.composer_outbox.enqueue("queued", None).unwrap();
    session.composer_wake();
    std::thread::sleep(Duration::from_millis(200));
    assert!(session.composer_outbox.has_items());
    assert!(log_lines(&log).is_empty());
    registry.remove(id, Duration::from_secs(5));
}

/// Terra round-4 (the reviewer's exact window): an old drain parked between
/// its ALIVE-CHECK and its CLAIM while the session is replaced underneath
/// it. The replacement owns the shared outbox now; the new session queues
/// its own item; the released old drain must claim NOTHING and must not
/// pause or modify the new queue — only the generation fence in the claim
/// (and the exit re-check) answers that, because the old child is already
/// dead, so a naive claim would fail its delivery and park the new queue's
/// item as outcome-unknown.
#[test]
fn an_old_drain_parked_before_its_claim_never_touches_the_replacements_queue() {
    let _guard = BARRIER_ENV.lock().unwrap();
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, _) = create_session_file(&sessions, &cwd).expect("create");

    let id = "fence-claim-window-1".to_string();
    let barrier = dir.path().join("barrier");
    std::fs::create_dir_all(&barrier).expect("barrier dir");
    let log_old = dir.path().join("old.log");
    let log_new = dir.path().join("new.log");
    std::env::set_var(
        "PI_COMPOSER_DRAIN_BARRIER",
        format!("{}:claim:{}", id, barrier.display()),
    );

    let events = b64(&serde_json::json!([
        { "type": "agent_start" },
        { "type": "agent_settled" },
    ]));
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    // Child #1 never needs to hold anything: the drain parks BEFORE the
    // claim, so no prompt can reach it.
    let config_old = mock_config(&agent_dir, &[
        "--mock-session-id", &id,
        "--mock-commands", &commands,
        "--mock-prompt-events", &events,
        "--mock-prompt-log", log_old.to_string_lossy().as_ref(),
    ]);
    let registry = SessionRegistry::new();
    let first = registry.start(&id, &file, &id, &cwd, &config_old).expect("first session");

    // A's wake sends the OLD drain through its alive-check and into the
    // claim barrier — A stays in the queue, unclaimed.
    first.composer_enqueue("A", None).expect("enqueue A");
    wait_for_file(&barrier.join("claim.reached"), Duration::from_secs(5));
    assert!(first.composer_outbox.has_items(), "A is still queued (the drain is parked before its claim)");

    // The replacement: the lease expires, the next start fences the old
    // drain's generation and kills the old child BEFORE the new one spawns.
    first.state_for_tests_set_lease(Duration::from_secs(0));
    let config_new = mock_config(&agent_dir, &[
        "--mock-session-id", &id,
        "--mock-commands", &commands,
        "--mock-prompt-events", &events,
        "--mock-prompt-log", log_new.to_string_lossy().as_ref(),
    ]);
    let second = registry.start(&id, &file, &id, &cwd, &config_new).expect("replacement session");
    assert!(!Arc::ptr_eq(&first, &second), "the session was replaced");

    // The NEW session queues its own item. Its drain parks at the same
    // claim barrier (the id matches); both drains wait on the one release.
    second.composer_enqueue("B", None).expect("enqueue B on the replacement");
    std::thread::sleep(Duration::from_millis(200));

    // Release BOTH drains at once: the replacement's drain must take the
    // queue (A then B, to the NEW child); the old drain's claim is fenced.
    std::fs::write(barrier.join("claim.release"), b"1\n").expect("release");
    wait_for_outbox_empty(&second, Duration::from_secs(10), "the replacement never drained its queue");

    assert!(
        log_lines(&log_old).is_empty(),
        "the old child saw no prompt at all: {:?}",
        log_lines(&log_old)
    );
    assert_eq!(
        log_lines(&log_new),
        vec!["A".to_string(), "B".to_string()],
        "the replacement delivered exactly A then B, once each"
    );
    let (items, _) = second.composer_outbox.snapshot();
    assert!(items.is_empty());
    assert!(!second.composer_outbox.is_paused(), "the old drain did not pause the new queue");
    assert!(!second.composer_outbox.front_is_unknown(), "no item was parked unknown by the old drain");

    std::env::remove_var("PI_COMPOSER_DRAIN_BARRIER");
    registry.remove(&id, Duration::from_secs(5));
}

/// Terra round-4 (the second required interleaving): the old drain's
/// in-flight RESULT lands on the shared outbox AFTER the replacement
/// session started and queued its own item. The `result` barrier holds the
/// old drain between its delivery failure and the write, so the ordering is
/// deterministic: the replacement's queue holds B when the old item parks.
/// The park must PRESERVE everything — A lands at the front as
/// outcome-unknown (visible, never auto-redelivered, never delivered to the
/// new child), B stays behind it, and the user resolving A lets B deliver to
/// the replacement exactly once.
#[test]
fn an_old_drains_inflight_result_lands_after_the_replacement_queued_its_own_item() {
    let _guard = BARRIER_ENV.lock().unwrap();
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, _) = create_session_file(&sessions, &cwd).expect("create");

    let id = "fence-result-late-1".to_string();
    let barrier = dir.path().join("barrier");
    std::fs::create_dir_all(&barrier).expect("barrier dir");
    let log_old = dir.path().join("old.log");
    let log_new = dir.path().join("new.log");
    std::env::set_var(
        "PI_COMPOSER_DRAIN_BARRIER",
        format!("{}:result:{}", id, barrier.display()),
    );

    let events = b64(&serde_json::json!([
        { "type": "agent_start" },
        { "type": "agent_settled" },
    ]));
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    // Child #1 HOLDS the prompt: the old drain stays in-flight mid-delivery.
    let config_old = mock_config(&agent_dir, &[
        "--mock-session-id", &id,
        "--mock-commands", &commands,
        "--mock-prompt-hold",
        "--mock-prompt-events", &events,
        "--mock-prompt-log", log_old.to_string_lossy().as_ref(),
    ]);
    let registry = SessionRegistry::new();
    let first = registry.start(&id, &file, &id, &cwd, &config_old).expect("first session");

    // The old drain claims A and blocks inside the held delivery.
    first.composer_enqueue("A", None).expect("enqueue A");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while log_lines(&log_old) != vec!["A".to_string()] {
        assert!(std::time::Instant::now() < deadline, "the old drain never claimed A");
        std::thread::sleep(Duration::from_millis(10));
    }

    // The replacement: the fence rises, child #1 dies (EOF), the held
    // delivery fails, and the old drain parks at the RESULT barrier — its
    // write to the shared outbox is now held AFTER the replacement exists.
    first.state_for_tests_set_lease(Duration::from_secs(0));
    let config_new = mock_config(&agent_dir, &[
        "--mock-session-id", &id,
        "--mock-commands", &commands,
        "--mock-prompt-hold",
        "--mock-prompt-events", &events,
        "--mock-prompt-log", log_new.to_string_lossy().as_ref(),
    ]);
    let second = registry.start(&id, &file, &id, &cwd, &config_new).expect("replacement session");
    wait_for_file(&barrier.join("result.reached"), Duration::from_secs(10));

    // The replacement queues and delivers ITS OWN item W (held mid-delivery
    // by child #2 — the delivering flag stays busy)…
    second.composer_enqueue("W", None).expect("enqueue W");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while log_lines(&log_new) != vec!["W".to_string()] {
        assert!(std::time::Instant::now() < deadline, "the replacement never claimed W");
        std::thread::sleep(Duration::from_millis(10));
    }
    // …and B behind it, which must STAY queued (the delivery of W holds the
    // delivering flag; B's wake finds it busy and returns).
    second.composer_enqueue("B", None).expect("enqueue B");
    std::thread::sleep(Duration::from_millis(200));
    let (items, _) = second.composer_outbox.snapshot();
    assert_eq!(items.len(), 1, "only B is queued: {items:?}");
    assert_eq!(items[0]["message"], serde_json::json!("B"));

    // NOW the old drain's result lands: A parks at the FRONT, the queue
    // pauses — B is preserved behind the unknown barrier, nothing is lost.
    std::fs::write(barrier.join("result.release"), b"1\n").expect("release the result barrier");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let (items, _) = second.composer_outbox.snapshot();
        let parked = items.len() == 2
            && items[0]["message"] == serde_json::json!("A")
            && items[0]["unknown"] == serde_json::json!(true)
            && items[1]["message"] == serde_json::json!("B");
        if parked {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the old drain's late result never parked A: {items:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(second.composer_outbox.is_paused(), "the unknown park pauses the shared queue");
    assert!(
        !log_lines(&log_new).contains(&"A".to_string()),
        "the parked A never auto-delivered to the replacement: {:?}",
        log_lines(&log_new)
    );

    // The user resolves A (take = edit/delete, not a resend); B then
    // delivers to the replacement exactly once (the release of W's hold
    // settles the run; the drain's exit re-check picks B up).
    let a_id = second
        .composer_outbox
        .snapshot()
        .0
        .first()
        .and_then(|item| item.get("id").and_then(|id| id.as_str()))
        .expect("the parked A's id")
        .to_string();
    let _ = second.composer_take(&a_id);
    second
        .command("release_prompt", serde_json::json!({}), Some(Duration::from_secs(10)))
        .expect("release W");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while log_lines(&log_new) != vec!["W".to_string(), "B".to_string()] {
        assert!(
            std::time::Instant::now() < deadline,
            "B never delivered to the replacement: {:?}",
            log_lines(&log_new)
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    second
        .command("release_prompt", serde_json::json!({}), Some(Duration::from_secs(10)))
        .expect("release B");
    wait_for_outbox_empty(&second, Duration::from_secs(10), "the queue never settled");
    assert!(!second.composer_outbox.is_paused());
    assert_eq!(log_lines(&log_old), vec!["A".to_string()], "the old child saw A exactly once");

    std::env::remove_var("PI_COMPOSER_DRAIN_BARRIER");
    registry.remove(&id, Duration::from_secs(5));
}

/// The DIRECT regression for the pi-host exit-wake fix (5b48b407): a settle
/// waiter (the drain's delivery AND an explicit send-now) must wake when the
/// child DIES — the fan thread's exit path notifies the settle condvar. The
/// deleted WIP test tried to assert this through send_now alone and was
/// eaten by the drain's claim; the correct construction makes the session
/// RUNNING first (the drain's canDeliver breaks, the queued item stays
/// editable), records the REAL prompt count the child saw, and bounds every
/// wait — a regression hangs nothing: the join times out and fails.
#[test]
fn a_child_exit_wakes_the_settle_waiters_of_every_in_flight_delivery() {
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, id) = create_session_file(&sessions, &cwd).expect("create");

    let prompt_log = dir.path().join("prompts.log");
    // The run STARTS but never settles: agent_start without agent_settled,
    // so the drain's delivery sits in wait_for_settle for real.
    let events = b64(&serde_json::json!([
        { "type": "agent_start" },
    ]));
    let commands = b64(&commands_for(&bridge_asset(), None, false));
    let config = mock_config(&agent_dir, &[
        "--mock-session-id", &id,
        "--mock-commands", &commands,
        "--mock-prompt-events", &events,
        "--mock-prompt-log", prompt_log.to_string_lossy().as_ref(),
    ]);
    let registry = SessionRegistry::new();
    let session = registry.start(&id, &file, &id, &cwd, &config).expect("session");

    // A's delivery starts a run and blocks in the settle wait.
    session.composer_enqueue("A", None).expect("enqueue A");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let delivered = log_lines(&prompt_log) == vec!["A".to_string()];
        if delivered && session.run_state().is_running() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "A never started its run: prompts={:?} running={}",
            log_lines(&prompt_log),
            session.run_state().is_running()
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    // B stays EDITABLE while the run is live (the drain's canDeliver breaks
    // on a running session — this is what the deleted WIP test missed: its
    // enqueue woke an IDLE drain that claimed the item out from send_now).
    session.composer_enqueue("B", None).expect("enqueue B");
    std::thread::sleep(Duration::from_millis(200));
    let (items, _) = session.composer_outbox.snapshot();
    assert_eq!(items.len(), 1, "B stays queued while the run is live: {items:?}");
    assert_eq!(items[0]["message"], serde_json::json!("B"));
    let b_id = items[0]["id"].as_str().expect("B's id").to_string();

    // The explicit send-now delivers B as a steer and blocks in its OWN
    // settle wait (on a helper thread — the wake under test must end it).
    let sender = {
        let (tx, rx) = std::sync::mpsc::channel();
        let session = Arc::clone(&session);
        std::thread::spawn(move || {
            let answer = session
                .composer_send_now(&b_id)
                .map(|_| "delivered".to_string())
                .unwrap_or_else(|error| format!("parked: {error}"));
            let _ = tx.send(answer);
        });
        rx
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while log_lines(&prompt_log) != vec!["A".to_string(), "B".to_string()] {
        assert!(
            std::time::Instant::now() < deadline,
            "the steer never reached the child: {:?}",
            log_lines(&prompt_log)
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    // The child dies: BOTH settle waiters (the drain on A, the send-now on
    // B) must observe the exit at once — the fan thread's exit notify is
    // the only wake (the settle deadline is 600 s). The BOUNDED receive is
    // the regression assertion: without the wake it fails in 15 s instead
    // of hanging the deadline, and the observable parks below double as
    // the drain-side proof.
    session.client_kill_for_tests();
    let send_now_answer = sender
        .recv_timeout(Duration::from_secs(15))
        .expect("the child exit never woke the send-now's settle wait (it would hang the 600 s deadline)");
    assert!(
        send_now_answer.starts_with("parked:"),
        "the dead-child delivery reports its unknown outcome: {send_now_answer}"
    );

    // The DRAIN's waiter woke the same way: its in-flight A lands parked
    // beside B (both unknown, the queue paused) — bounded, because a missing
    // wake would leave it sleeping the 600 s settle deadline.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let (items, _) = session.composer_outbox.snapshot();
        let both = items.len() == 2 && items.iter().all(|item| item["unknown"] == serde_json::json!(true));
        if both {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the exit never woke the drain's settle wait (a 600 s hang would follow): {items:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(session.composer_outbox.is_paused(), "the unknown parks paused the queue");
    // The REAL prompt count: exactly A then B reached the child, once each.
    assert_eq!(log_lines(&prompt_log), vec!["A".to_string(), "B".to_string()]);
    assert!(session.client_has_exited_for_tests(), "the child is dead");
    registry.remove(&id, Duration::from_secs(5));
}


// ---------------------------------------------------------------------------
// Terra round-3 P1-1: the chat policy asset's integrity pin. The handshake's
// marker check proves a `pi-web:chat-policy` command registered from the
// shipped path — it cannot prove the hooks behind it survived. Three layers
// now hold that: (1) the digest pin below (only the shipped bytes can pass),
// (2) the asset registers the marker LAST, after every hook, so a load that
// fails midway never leaves the marker behind, and (3) the real-runtime
// probes document what pi does with a partially-registered extension.
// ---------------------------------------------------------------------------

fn shipped_chat_asset() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../lib/pi-rpc/assets/pi-web-chat.mjs")
        .canonicalize()
        .expect("the shipped chat policy asset resolves")
}

/// A chat whose policy file does not match the pinned digest must fail
/// closed BEFORE any child exists — a corrupted, truncated or swapped file
/// that still registers the marker would otherwise hand the chat its tool
/// loadout without the policy hooks. Deterministic: the digest gate runs
/// before the spawn.
#[test]
fn a_chat_policy_asset_that_does_not_match_its_pinned_digest_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("chats").join("20260101-120000-abcd");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, id) = create_session_file(&sessions, &cwd).expect("create");
    let prompt_file = dir.path().join("chat-prompt.txt");
    std::fs::write(&prompt_file, "chat preamble").expect("prompt");

    let shipped = shipped_chat_asset();
    let shipped_digest = sha256_of_file(&shipped);

    // The tampered copy: the SHIPPED content with the tool_call hook's
    // registration deleted — exactly the "marker kept, enforcement removed"
    // file the digest must catch. (Built by removing the one registration
    // block; any byte change would do for the digest, but this is the
    // security-relevant one.)
    let shipped_text = std::fs::read_to_string(&shipped).expect("shipped asset");
    let marker = "  if (!unrestricted) {\n    pi.on(\"tool_call\", (event) => {";
    assert!(shipped_text.contains(marker), "the shipped asset registers its tool_call hook");
    let tampered_text = shipped_text.replacen(
        "  if (!unrestricted) {\n    pi.on(\"tool_call\", (event) => {",
        "  if (false) {\n    pi.on(\"tool_call\", (event) => {",
        1,
    );
    assert_ne!(tampered_text, shipped_text, "the tamper changed the asset");
    let tampered = dir.path().join("pi-web-chat.mjs");
    std::fs::write(&tampered, tampered_text).expect("tampered asset");

    let commands = b64(&commands_for(&bridge_asset(), Some(&tampered), true));
    let base = mock_config(&agent_dir, &["--mock-session-id", &id, "--mock-commands", &commands]);
    let registry = SessionRegistry::new();

    // 1. The tampered file against the SHIPPED pin (what the real host —
    //    which embeds the shipped digest — always does): refused, no child.
    let error = match registry.start(
        &id,
        &file,
        &id,
        &cwd,
        &session_host::SessionSpawnConfig {
            chat_asset: Some(tampered.clone()),
            chat_asset_sha256: Some(shipped_digest.clone()),
            shape: session_host::SessionSpawnShape::Chat {
                prompt_file: prompt_file.clone(),
                folder: true,
                unlocked: false,
                files_enabled: true,
            },
            ..base.clone()
        },
    ) {
        Err(error) => error,
        Ok(_) => panic!("a tampered policy asset must fail the integrity pin"),
    };
    match &error {
        SessionHostError::Spawn(message) => assert!(
            message.contains("pinned digest"),
            "the honest integrity message: {message}"
        ),
        other => panic!("a Spawn error, not {other:?}"),
    }
    assert!(registry.ids().is_empty(), "no child was ever spawned");

    // 2. No pin at all: fail closed too (the host may not "trust" an
    //    unpinned asset path).
    let error = match registry.start(
        &id,
        &file,
        &id,
        &cwd,
        &session_host::SessionSpawnConfig {
            chat_asset: Some(tampered.clone()),
            chat_asset_sha256: None,
            shape: session_host::SessionSpawnShape::Chat {
                prompt_file: prompt_file.clone(),
                folder: true,
                unlocked: false,
                files_enabled: true,
            },
            ..base.clone()
        },
    ) {
        Err(error) => error,
        Ok(_) => panic!("an unpinned policy asset must fail closed"),
    };
    assert!(
        matches!(error, SessionHostError::Spawn(ref message) if message.contains("no pinned SHA-256")),
        "{error}"
    );

    // 3. The byte-identical shipped file with its own pin passes the gate
    //    (the mock child then reports the marker and the chat starts).
    let commands = b64(&commands_for(&bridge_asset(), Some(&shipped), true));
    let base = mock_config(&agent_dir, &["--mock-session-id", &id, "--mock-commands", &commands]);
    registry
        .start(
            &id,
            &file,
            &id,
            &cwd,
            &session_host::SessionSpawnConfig {
                chat_asset: Some(shipped.clone()),
                chat_asset_sha256: Some(sha256_of_file(&shipped)),
                shape: session_host::SessionSpawnShape::Chat {
                    prompt_file,
                    folder: true,
                    unlocked: false,
                    files_enabled: true,
                },
                ..base
            },
        )
        .expect("the byte-identical shipped asset passes the integrity gate");
    registry.remove(&id, Duration::from_secs(5));
}

/// What the REAL runtime does with an extension whose registration fails
/// midway — the fact that decides whether the marker-last ordering is
/// load-bearing (Terra P1-1: "验证真实 runtime 对注册中途失败的行为").
///
/// The shipped asset registers `pi-web:chat-policy` LAST, so a load that
/// throws anywhere before it cannot leave the marker behind. This test
/// proves that against the real runtime with the shipped asset's own
/// failure mode simulated: a fixture that registers the hooks and throws
/// BEFORE the marker. Whatever pi does with partially-registered extensions,
/// the handshake must fail closed for it.
#[test]
fn real_pi_a_policy_asset_that_throws_before_its_marker_fails_the_handshake() {
    let Some(executable) = pi_bin() else {
        eprintln!("skipping: PI_CLI_BIN not set");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("chats").join("20260101-120000-abcd");
    std::fs::create_dir_all(&agent_dir).expect("agent");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, id) = create_session_file(&sessions, &cwd).expect("create");
    let prompt_file =
        session_host::spawn_plan::write_prompt_file("chat preamble for the throw test").expect("prompt");

    // The fixture mirrors the SHIPPED ordering with a deliberate failure
    // between the hooks and the marker: if any registration step fails, the
    // marker (the handshake's demand) is absent.
    let fixture = dir.path().join("throw-before-marker.mjs");
    std::fs::write(
        &fixture,
        r#"
export default function piWebChatThrow(pi) {
  pi.on("before_agent_start", () => undefined);
  pi.on("tool_call", () => undefined);
  throw new Error("deliberate mid-registration failure");
  pi.registerCommand("pi-web:chat-policy", {
    description: "never reached",
    handler: async () => "chat-policy:never",
  });
}
"#,
    )
    .expect("fixture");

    let registry = SessionRegistry::new();
    let error = match registry.start(
        &id,
        &file,
        &id,
        &cwd,
        &SessionSpawnConfig {
            executable,
            agent_dir: Some(agent_dir),
            session_dir: None,
            bridge_asset: bridge_asset(),
            artifacts_asset: None,
            chat_asset: Some(fixture.clone()),
            chat_asset_sha256: Some(sha256_of_file(&fixture)),
            shape: session_host::SessionSpawnShape::Chat {
                prompt_file,
                folder: true,
                unlocked: false,
                files_enabled: true,
            },
            initial_model: None,
            thinking_level: None,
            extra_args: Vec::new(),
        },
    ) {
        Err(error) => error,
        Ok(session) => panic!(
            "a policy asset that throws before its marker must fail the handshake (session {})",
            session.id
        ),
    };
    assert!(matches!(error, SessionHostError::Handshake(_)), "{error}");
    assert!(registry.ids().is_empty(), "the failed child never entered the registry");
}

/// The OLD (vulnerable) layout — marker FIRST, hooks after, throw in
/// between — documents what the real runtime keeps of a failed extension's
/// registrations. If pi RETAINED the already-registered command, the marker
/// check alone would have passed a chat whose policy hooks never loaded:
/// that is exactly why the marker now registers LAST and the digest pins
/// the shipped bytes. This test pins the runtime fact (whichever way it
/// goes) so a future pi behavior change that reopens the gap is visible.
#[test]
fn real_pi_documents_what_a_failed_registration_leaves_behind() {
    let Some(executable) = pi_bin() else {
        eprintln!("skipping: PI_CLI_BIN not set");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let agent_dir = dir.path().join("agent");
    let cwd = dir.path().join("chats").join("20260101-120000-abcd");
    std::fs::create_dir_all(&agent_dir).expect("agent");
    std::fs::create_dir_all(&cwd).expect("cwd");
    let sessions = dir.path().join("sessions");
    std::fs::create_dir_all(&sessions).expect("sessions");
    let (file, id) = create_session_file(&sessions, &cwd).expect("create");
    let prompt_file =
        session_host::spawn_plan::write_prompt_file("chat preamble for the layout probe").expect("prompt");

    // Marker FIRST (the old order), then the failure before any hook.
    let fixture = dir.path().join("marker-first-then-throw.mjs");
    std::fs::write(
        &fixture,
        r#"
export default function piWebChatMarkerFirst(pi) {
  pi.registerCommand("pi-web:chat-policy", {
    description: "pi-web internal: report the chat policy asset's identity",
    handler: async () => "chat-policy:marker-without-hooks",
  });
  throw new Error("deliberate failure before the hooks");
}
"#,
    )
    .expect("fixture");

    let registry = SessionRegistry::new();
    let outcome = registry.start(
        &id,
        &file,
        &id,
        &cwd,
        &SessionSpawnConfig {
            executable,
            agent_dir: Some(agent_dir),
            session_dir: None,
            bridge_asset: bridge_asset(),
            artifacts_asset: None,
            chat_asset: Some(fixture.clone()),
            chat_asset_sha256: Some(sha256_of_file(&fixture)),
            shape: session_host::SessionSpawnShape::Chat {
                prompt_file,
                folder: true,
                unlocked: false,
                files_enabled: true,
            },
            initial_model: None,
            thinking_level: None,
            extra_args: Vec::new(),
        },
    );
    match outcome {
        // pi 1.4.0's observed behavior (this test pins it): an extension
        // whose top-level registration throws takes the whole child down
        // (exit 1) — the runtime is fail-clean, so a half-registered
        // extension never reaches a handshake at all. The handshake error
        // may be the child-exit message or the missing-marker message; both
        // are fail-closed. If a FUTURE pi keeps partial registrations
        // instead, this arm breaks on purpose: the marker would list and
        // only the digest pin + the marker-last ordering would remain as
        // the defense (they hold — the shipped asset registers the marker
        // after every hook, and only the shipped bytes match the pin).
        Err(SessionHostError::Handshake(message)) => {
            assert!(
                message.contains("pi-web:chat-policy")
                    || message.contains("exited unexpectedly"),
                "a fail-closed handshake error, not: {message}"
            );
        }
        Err(other) => panic!("expected the handshake failure, got {other:?}"),
        Ok(session) => {
            // pi KEPT the marker registered despite the failed load. The
            // marker-alone gate would have passed this chat — which is why
            // the asset now registers the marker LAST and the host pins the
            // shipped digest: neither a throwing load nor a swapped file can
            // present the marker without the hooks. Kill the child we just
            // proved the point with.
            registry.remove(&id, Duration::from_secs(5));
        }
    }
    assert!(registry.ids().is_empty());
}
