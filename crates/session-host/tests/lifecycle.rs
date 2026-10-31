//! session-host tests: file creation and dispatch are pure; the lifecycle
//! case runs the real pi child (PI_CLI_BIN, sandboxed) through the M2
//! backbone: create → start (handshake identity + bridge attribution) →
//! concurrent start dedup → lease/idle eviction → dispatch → shutdown.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use session_host::{
    create_session_file, dispatch_session_op, SessionRegistry, SessionSpawnConfig,
    IDLE_TIMEOUT,
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
