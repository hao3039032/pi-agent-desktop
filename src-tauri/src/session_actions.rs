//! Explicit branch actions. Live leaf changes run in the owning child; copies
//! are made by a separate SDK manager and never replace that child.
use std::time::Duration;
use serde_json::{json, Value};
use crate::pi_ipc::{dispatch_with_resume, management_call, IpcHostState};

pub(crate) fn branch(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let kind = args.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "navigate_tree" && args.get("summarize").is_some_and(|value| !value.is_boolean()) {
        return Err(("invalid_args".into(), "summarize must be a boolean".into()));
    }
    if kind == "navigate_tree" && args.get("summarize").and_then(Value::as_bool) == Some(true) {
        return Err(("not_supported".into(), "Branch summarization and its Stop action are not available in the desktop session host.".into()));
    }
    let id = args.get("session").and_then(Value::as_str).filter(|id| !id.is_empty())
        .ok_or_else(|| ("invalid_args".into(), "session is required".into()))?;
    if kind == "navigate_tree" && args.get("targetId").and_then(Value::as_str).filter(|v| !v.is_empty()).is_none() {
        return Err(("invalid_args".into(), "targetId is required".into()));
    }
    if matches!(kind, "fork" | "fork_branch") && args.get("entryId").and_then(Value::as_str).filter(|v| !v.is_empty()).is_none() {
        return Err(("invalid_args".into(), "entryId is required".into()));
    }
    if kind == "clone" && args.get("leafId").is_some_and(|value| !value.is_null() && !value.as_str().is_some_and(|v| !v.is_empty())) {
        return Err(("invalid_args".into(), "leafId must be a non-empty string".into()));
    }
    // Existing resume logic remains the sole authority for spawn policy and chat confinement.
    dispatch_with_resume(state, "agent.command", &json!({"session": id, "type": "get_state"}))?;
    let session = state.registry.get(id).ok_or_else(|| ("not_found".into(), "session not found".into()))?;
    let _guard = session.try_branch_activity().map_err(|message| ("busy".into(), message.into()))?;
    if session.run_state().is_running() || !session.composer_outbox.snapshot().0.is_empty() {
        return Err(("busy".into(), "Wait for the current response and queued messages before changing branches.".into()));
    }
    session.bridge_request("tree.assertIdle", None, Some(Duration::from_secs(30)))
        .map_err(|error| {
            let code = if matches!(&error, pi_host::bridge::BridgeError::Op(_)) { "busy" } else { "op_failed" };
            (code.into(), error.to_string())
        })?;
    if kind == "navigate_tree" {
        let target = args.get("targetId").and_then(Value::as_str).filter(|v| !v.is_empty())
            .ok_or_else(|| ("invalid_args".into(), "targetId is required".into()))?;
        return session.bridge_request("tree.navigate", Some(json!({"targetId": target})), Some(Duration::from_secs(120)))
            .map_err(|error| ("op_failed".into(), format!("Navigation failed or its outcome is unknown; refresh the session before trying again: {error}")));
    }
    let entry = if kind == "clone" {
        if let Some(leaf) = args.get("leafId").and_then(Value::as_str) { leaf.to_string() }
        else {
            let snapshot = session.command("get_entries", json!({}), Some(Duration::from_secs(30)))
                .map_err(|error| ("op_failed".into(), error.to_string()))?;
            match snapshot.get("leafId").and_then(Value::as_str) {
                Some(leaf) => leaf.to_string(),
                None => return Ok(json!({"cancelled": true})),
            }
        }
    } else {
        args.get("entryId").and_then(Value::as_str).filter(|v| !v.is_empty())
            .ok_or_else(|| ("invalid_args".into(), "entryId is required".into()))?.to_string()
    };
    if !session.session_file.is_file() { return Ok(json!({"cancelled": true})); }
    let root = state.agent_dir().join("sessions").canonicalize()
        .map_err(|error| ("io".into(), error.to_string()))?;
    let file = session.session_file.canonicalize().map_err(|error| ("io".into(), error.to_string()))?;
    if !file.starts_with(&root) {
        return Err(("access_denied".into(), "Session file is outside the session storage directory.".into()));
    }
    let result = management_call(state, "session.fork", json!({"file": file.to_string_lossy(), "entryId": entry, "mode": kind}))
        .map_err(|(code, message)| (code, format!("Fork failed or its outcome is unknown; check the session list before trying again: {message}")))?;
    if kind != "fork_branch" && result.get("cancelled").and_then(Value::as_bool) == Some(false) {
        state.registry.remove(id, Duration::from_secs(5));
    }
    Ok(result)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::pi_ipc::{dispatch_envelope, SpawnBase};
    use std::path::Path;

    struct ListenerGuard {
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for ListenerGuard {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Some(thread) = self.thread.take() { let _ = thread.join(); }
        }
    }

    #[test]
    fn real_pi_branch_actions_keep_source_and_project_views() {
        let executable = std::env::var("PI_CLI_BIN").expect("PI_CLI_BIN must name the isolated fixture executable");
        let temp = tempfile::tempdir().unwrap();
        let agent = temp.path().join("agent");
        let cwd = temp.path().join("project");
        let sessions = agent.join("sessions/project");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        let file = sessions.join("branch-source.jsonl");
        let entries = [
            json!({"type":"session","version":3,"id":"branch-source","cwd":cwd,"timestamp":"2026-01-01T00:00:00.000Z"}),
            json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"question"}}),
            json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}),
            json!({"type":"message","id":"ua","parentId":"a1","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"user","content":"branch A"}}),
            json!({"type":"message","id":"aa","parentId":"ua","timestamp":"2026-01-01T00:00:04.000Z","message":{"role":"assistant","content":[{"type":"text","text":"answer A"}]}}),
            json!({"type":"message","id":"ub","parentId":"a1","timestamp":"2026-01-01T00:00:05.000Z","message":{"role":"user","content":"branch B"}}),
            json!({"type":"message","id":"ab","parentId":"ub","timestamp":"2026-01-01T00:00:06.000Z","message":{"role":"assistant","content":[{"type":"text","text":"answer B"}]}}),
        ];
        let original = entries.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n";
        std::fs::write(&file, &original).unwrap();
        // Symlink only the SDK package (read-only); no vendored tree or target is copied.
        let managed = temp.path().join("managed");
        std::fs::create_dir_all(managed.join("@earendil-works")).unwrap();
        std::os::unix::fs::symlink(Path::new("../node_modules/@earendil-works/pi-coding-agent").canonicalize().unwrap(), managed.join("@earendil-works/pi-coding-agent")).unwrap();
        let build = std::process::Command::new("node").arg("../scripts/migration/build-management-modules.mjs").arg("--out").arg(&managed).output().unwrap();
        assert!(build.status.success(), "{}", String::from_utf8_lossy(&build.stderr));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_listener = stop.clone();
        let listener_thread = std::thread::spawn(move || {
            let mut streams = Vec::new();
            while !stop_listener.load(std::sync::atomic::Ordering::Relaxed) {
                if let Ok((stream, _)) = listener.accept() { streams.push(stream); }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        std::fs::write(agent.join("models.json"), json!({"providers":{"stall":{"baseUrl":format!("http://{endpoint}"),"apiKey":"fixture","api":"openai-completions","models":[{"id":"stuck","name":"Stuck","reasoning":false,"input":["text"],"contextWindow":200000,"maxTokens":4096,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}).to_string()).unwrap();
        std::fs::write(agent.join("settings.json"), r#"{"defaultProvider":"stall","defaultModel":"stuck"}"#).unwrap();
        let _listener_guard = ListenerGuard { stop, thread: Some(listener_thread) };
        let state = IpcHostState::new();
        *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
        *state.spawn_base.lock().unwrap() = Some(SpawnBase { executable: executable.clone(), bridge_asset: Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs").canonicalize().unwrap(), artifacts_asset: None, chat_asset: None });
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig { executable, agent_dir: Some(agent), extensions: vec![Path::new("../lib/pi-rpc/assets/pi-web-management.mjs").canonicalize().unwrap()], env: vec![("PI_WEB_MANAGED_MODULES".into(), managed.to_string_lossy().into_owned())] });
        let call = |op: &str, args: Value| dispatch_envelope(&state, json!({"v":1,"id":"test","op":op,"args":args}));
        let nav = call("agent.command", json!({"session":"branch-source","type":"navigate_tree","targetId":"aa"}));
        assert_eq!(nav["ok"], true, "{nav}");
        let live = call("sessions.get", json!({"session":"branch-source"}));
        assert_eq!(live["ok"], true, "{live}");
        assert_eq!(live["data"]["leafId"], "aa");
        assert!(live["data"]["context"].to_string().contains("branch A"));
        assert!(!live["data"]["context"].to_string().contains("branch B"));
        let denied = call("agent.command", json!({"session":"branch-source","type":"navigate_tree","targetId":"ab","summarize":true}));
        assert_eq!(denied["error"]["code"], "not_supported", "{denied}");
        let source = state.registry.get("branch-source").unwrap();
        let queued = source.composer_outbox.enqueue("pending", None).unwrap();
        let blocked = call("agent.command", json!({"session":"branch-source","type":"navigate_tree","targetId":"ab"}));
        assert_eq!(blocked["error"]["code"], "busy", "{blocked}");
        source.composer_outbox.take(&queued.id);
        {
            let guard = source.try_branch_activity().unwrap();
            let blocked = call("agent.command", json!({"session":"branch-source","type":"navigate_tree","targetId":"ab"}));
            assert_eq!(blocked["error"]["code"], "busy", "{blocked}");
            drop(guard);
        }
        let fork = call("agent.command", json!({"session":"branch-source","type":"fork_branch","entryId":"aa"}));
        assert_eq!(fork["ok"], true, "{fork}");
        let fork_id = fork["data"]["newSessionId"].as_str().unwrap();
        let reopened = call("sessions.get", json!({"session":fork_id}));
        assert_eq!(reopened["ok"], true, "{reopened}");
        assert_eq!(reopened["data"]["info"]["parentSessionId"], "branch-source");
        assert!(reopened["data"]["context"].to_string().contains("branch A"));
        assert!(!reopened["data"]["context"].to_string().contains("branch B"));
        assert!(std::fs::read_to_string(&file).unwrap().contains("branch B"));
        let clone = call("agent.command", json!({"session":"branch-source","type":"clone"}));
        assert_eq!(clone["ok"], true, "{clone}");
        let cloned = call("sessions.get", json!({"session":clone["data"]["newSessionId"]}));
        assert_eq!(cloned["ok"], true, "{cloned}");
        assert!(cloned["data"]["context"].to_string().contains("branch A"));
        assert!(!cloned["data"]["context"].to_string().contains("branch B"));
        let fork_before = call("agent.command", json!({"session":"branch-source","type":"fork","entryId":"ua"}));
        assert_eq!(fork_before["ok"], true, "{fork_before}");
        let forked_before = call("sessions.get", json!({"session":fork_before["data"]["newSessionId"]}));
        assert_eq!(forked_before["ok"], true, "{forked_before}");
        assert_eq!(forked_before["data"]["info"]["parentSessionId"], "branch-source");
        assert!(!forked_before["data"]["context"].to_string().contains("branch A"));
        assert!(!forked_before["data"]["context"].to_string().contains("branch B"));
        let prompt = call("agent.command", json!({"session":"branch-source","type":"prompt","message":"hold run"}));
        assert_eq!(prompt["ok"], true, "{prompt}");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !state.registry.get("branch-source").unwrap().run_state().is_running() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(state.registry.get("branch-source").unwrap().run_state().is_running(), "fixture run did not start");
        for kind in ["fork", "fork_branch", "clone", "navigate_tree"] {
            let blocked = call("agent.command", json!({"session":"branch-source","type":kind,"entryId":"aa","targetId":"aa"}));
            assert_eq!(blocked["error"]["code"], "busy", "{kind}: {blocked}");
        }
        state.registry.remove("branch-source", Duration::from_secs(5));
        state.management.shutdown_all(Duration::from_secs(5));

    }
}
