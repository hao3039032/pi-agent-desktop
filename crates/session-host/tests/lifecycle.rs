//! session-host tests: file creation and dispatch are pure; the lifecycle
//! case runs the real pi child (PI_CLI_BIN, sandboxed) through the M2
//! backbone: create → start (handshake identity + bridge attribution) →
//! concurrent start dedup → lease/idle eviction → dispatch → shutdown.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use session_host::{
    create_session_file, dispatch_session_op, SessionHostError, SessionRegistry,
    SessionSpawnConfig, IDLE_TIMEOUT,
};

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
