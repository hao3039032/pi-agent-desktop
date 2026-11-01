//! Explicit branch actions. Live leaf changes run in the owning child; copies
//! are made by a separate SDK manager and never replace that child.
use std::time::Duration;
use serde_json::{json, Value};
use crate::pi_ipc::{dispatch_with_resume, management_call, IpcHostState};

pub(crate) fn export(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let _policy = state.policy_gate.try_read().map_err(|_| ("busy".into(), "Session policy change is in progress".into()))?;
    let id = args.get("session").and_then(Value::as_str).filter(|id| !id.is_empty())
        .ok_or_else(|| ("invalid_args".into(), "session is required".into()))?;
    dispatch_with_resume(state, "agent.command", &json!({"session": id, "type": "get_state"}))?;
    let session = state.registry.get(id).ok_or_else(|| ("not_found".into(), "session not found".into()))?;
    let _guard = session.try_branch_activity().map_err(|message| ("busy".into(), message.into()))?;
    if session.run_state().is_running() || !session.composer_outbox.snapshot().0.is_empty() {
        return Err(("busy".into(), "Wait for the current response and queued messages before exporting.".into()));
    }
    session.bridge_request("tree.assertIdle", None, Some(Duration::from_secs(30)))
        .map_err(|error| ("op_failed".into(), error.to_string()))?;
    let root = state.agent_dir().join("sessions").canonicalize().map_err(|error| ("io".into(), error.to_string()))?;
    let file = session.session_file.canonicalize().map_err(|error| ("io".into(), error.to_string()))?;
    if !file.starts_with(root) { return Err(("access_denied".into(), "Session file is outside the session storage directory.".into())); }
    let directory = tempfile::Builder::new().prefix("pi-session-export-").tempdir()
        .map_err(|error| ("io".into(), error.to_string()))?;
    let output = directory.path().join("session.html");
    // The management instance receives only host-resolved paths; the private
    // temp directory is retained until eviction or host shutdown.
    management_call(state, "session.export", json!({"file": file.to_string_lossy(), "output": output.to_string_lossy()}))?;
    if !output.is_file() { return Err(("op_failed".into(), "Exporter produced no HTML file".into())); }
    let mut exports = state.session_exports.lock().unwrap();
    exports.push_back(directory);
    while exports.len() > 20 { exports.pop_front(); }
    Ok(json!({"path": output.to_string_lossy()}))
}

pub(crate) fn rename(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let _policy = state.policy_gate.try_read().map_err(|_| ("busy".into(), "Session policy change is in progress".into()))?;
    let id = args.get("session").and_then(Value::as_str).filter(|id| !id.is_empty())
        .ok_or_else(|| ("invalid_args".into(), "session is required".into()))?;
    let name = args.get("name").and_then(Value::as_str)
        .ok_or_else(|| ("invalid_args".into(), "name is required".into()))?;
    dispatch_with_resume(state, "agent.command", &json!({"session": id, "type": "get_state"}))?;
    let session = state.registry.get(id).ok_or_else(|| ("not_found".into(), "session not found".into()))?;
    let _guard = session.try_branch_activity().map_err(|message| ("busy".into(), message.into()))?;
    if session.run_state().is_running() || !session.composer_outbox.snapshot().0.is_empty() {
        return Err(("busy".into(), "Wait for the current response and queued messages before renaming.".into()));
    }
    session.bridge_request_with_activity(&_guard, "session.rename", Some(json!({"name": name})), Some(Duration::from_secs(30)))
        .map_err(|error| ("op_failed".into(), format!("Rename failed or its outcome is unknown; refresh the session list before trying again: {error}")))
}

pub(crate) fn branch(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let _policy = state.policy_gate.try_read().map_err(|_| ("busy".into(), "Session policy change is in progress".into()))?;
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
    if kind == "navigate_tree" {
        let session = state.registry.get(id).ok_or_else(|| ("not_found".into(), "session not found".into()))?;
        let _guard = session.try_branch_activity().map_err(|message| ("busy".into(), message.into()))?;
        if session.run_state().is_running() || !session.composer_outbox.snapshot().0.is_empty() {
            return Err(("busy".into(), "Wait for the current response and queued messages before changing branches.".into()));
        }
        session.bridge_request("tree.assertIdle", None, Some(Duration::from_secs(30)))
            .map_err(|error| ("busy".into(), error.to_string()))?;
        let target = args.get("targetId").and_then(Value::as_str).filter(|v| !v.is_empty())
            .ok_or_else(|| ("invalid_args".into(), "targetId is required".into()))?;
        return session.bridge_request_with_activity(&_guard, "tree.navigate", Some(json!({"targetId": target})), Some(Duration::from_secs(120)))
            .map_err(|error| ("op_failed".into(), format!("Navigation failed or its outcome is unknown; refresh the session before trying again: {error}")));
    }
    crate::session_fork::copy(state, id, kind, args)
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
            json!({"type":"label","id":"l1","parentId":"a1","timestamp":"2026-01-01T00:00:02.100Z","targetId":"a1","label":"checkpoint"}),
            json!({"type":"compaction","id":"c1","parentId":"l1","timestamp":"2026-01-01T00:00:02.200Z","summary":"earlier context","firstKeptEntryId":"l1","tokensBefore":50}),
            json!({"type":"message","id":"ua","parentId":"c1","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"user","content":"branch A"}}),
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
        std::os::unix::fs::symlink(Path::new("../node_modules").canonicalize().unwrap(), managed.join("node_modules")).unwrap();
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
        let renamed = call("sessions.rename", json!({"session":"branch-source","name":"  fixture title  "}));
        assert_eq!(renamed["ok"], true, "{renamed}");
        let named = call("sessions.get", json!({"session":"branch-source"}));
        assert_eq!(named["data"]["info"]["name"], "fixture title", "{named}");
        let cleared = call("sessions.rename", json!({"session":"branch-source","name":""}));
        assert_eq!(cleared["ok"], true, "clearing the title is supported: {cleared}");
        let exported = call("sessions.export", json!({"session":"branch-source"}));
        assert_eq!(exported["ok"], true, "{exported}");
        let export_path = Path::new(exported["data"]["path"].as_str().unwrap());
        let html = std::fs::read_to_string(export_path).unwrap();
        use base64::Engine;
        let payload = html.split("<script id=\"session-data\" type=\"application/json\">").nth(1).unwrap().split("</script>").next().unwrap();
        let transcript = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(payload).unwrap()).unwrap();
        assert!(transcript.contains("branch A") && transcript.contains("branch B"));
        assert!(!html.contains("node.children.forEach(sortChildren)"));
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
        let invalid_fork = call("agent.command", json!({"session":"branch-source","type":"fork_branch","entryId":"missing"}));
        assert_eq!(invalid_fork["error"]["code"], "invalid_args", "{invalid_fork}");
        assert!(std::sync::Arc::ptr_eq(&source, &state.registry.get("branch-source").unwrap()));
        assert!(crate::session_writer_fence::assert_session_writable(&state.agent_dir(), "branch-source").is_ok());
        let before_fork = std::fs::read(&file).unwrap();
        let live_entries = source.command("get_entries", json!({}), Some(Duration::from_secs(5))).unwrap();
        let reference_source = temp.path().join("reference-source.jsonl");
        let header = std::str::from_utf8(&before_fork).unwrap().lines().next().unwrap();
        let mut snapshot = format!("{header}\n");
        for entry in live_entries["entries"].as_array().unwrap() { snapshot.push_str(&format!("{entry}\n")); }
        std::fs::write(&reference_source, snapshot).unwrap();
        let reference_dir = temp.path().join("reference");
        std::fs::create_dir_all(&reference_dir).unwrap();
        let fork = call("agent.command", json!({"session":"branch-source","type":"fork_branch","entryId":"aa"}));
        assert_eq!(fork["ok"], true, "{fork}");
        assert!(std::sync::Arc::ptr_eq(&source, &state.registry.get("branch-source").unwrap()));
        assert_eq!(source.command("get_entries", json!({}), Some(Duration::from_secs(5))).unwrap()["leafId"], "aa");
        assert_eq!(std::fs::read(&file).unwrap(), before_fork);
        let fork_id = fork["data"]["newSessionId"].as_str().unwrap();
        assert!(crate::session_writer_fence::assert_session_writable(&state.agent_dir(), "branch-source").is_ok());
        assert!(crate::session_writer_fence::assert_session_writable(&state.agent_dir(), fork_id).is_ok());
        assert_eq!(std::fs::read_dir(state.agent_dir().join("pi-web/fork-staging")).unwrap().count(), 0);
        let reopened = call("sessions.get", json!({"session":fork_id}));
        assert_eq!(reopened["ok"], true, "{reopened}");
        assert_eq!(reopened["data"]["info"]["parentSessionId"], "branch-source");
        let copied = Path::new(reopened["data"]["info"]["path"].as_str().unwrap());
        let sdk = Path::new("../node_modules/@earendil-works/pi-coding-agent/dist/index.js").canonicalize().unwrap();
        let compare = std::process::Command::new("node").arg("--input-type=module").arg("-e").arg(r#"
          import assert from 'node:assert/strict';
          import { pathToFileURL } from 'node:url';
          const { SessionManager } = await import(pathToFileURL(process.argv[1]));
          const direct = SessionManager.open(process.argv[2], process.argv[3]);
          const file = direct.createBranchedSession('aa');
          const expected = file && (await import('node:fs')).existsSync(file) ? SessionManager.open(file) : direct;
          const actual = SessionManager.open(process.argv[4]);
          const clean = entries => entries.map(e => { if (e.type !== 'label') return e; const { id, ...rest } = e; return rest; });
          assert.deepEqual(clean(actual.getEntries()), clean(expected.getEntries()));
          assert.equal(actual.getLabel('a1'), expected.getLabel('a1'));
          assert.equal(actual.getEntry('c1').firstKeptEntryId, expected.getEntry('c1').firstKeptEntryId);
        "#).arg(sdk).arg(&reference_source).arg(&reference_dir).arg(copied).output().unwrap();
        assert!(compare.status.success(), "{}", String::from_utf8_lossy(&compare.stderr));
        assert!(reopened["data"]["context"].to_string().contains("branch A"));
        assert!(!reopened["data"]["context"].to_string().contains("branch B"));
        assert!(std::fs::read_to_string(&file).unwrap().contains("branch B"));
        let cancelled = call("agent.command", json!({"session":"branch-source","type":"clone","leafId":"u1"}));
        assert_eq!(cancelled["data"]["cancelled"], true, "{cancelled}");
        assert!(std::sync::Arc::ptr_eq(&source, &state.registry.get("branch-source").unwrap()));
        assert!(crate::session_writer_fence::assert_session_writable(&state.agent_dir(), "branch-source").is_ok());
        let clone = call("agent.command", json!({"session":"branch-source","type":"clone"}));
        assert_eq!(clone["ok"], true, "{clone}");
        assert!(state.registry.get("branch-source").is_none(), "successful clone closes the guarded source");
        assert!(source.is_transport_closing());
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
        let empty = call("agent.command", json!({"session":"branch-source","type":"fork","entryId":"u1"}));
        assert_eq!(empty["ok"], true, "{empty}");
        let empty_view = call("sessions.get", json!({"session":empty["data"]["newSessionId"]}));
        assert_eq!(empty_view["data"]["info"]["parentSessionId"], "branch-source");
        assert!(!empty_view["data"]["context"].to_string().contains("question"));
        let prompt = call("agent.command", json!({"session":"branch-source","type":"prompt","message":"hold run"}));
        assert_eq!(prompt["ok"], true, "{prompt}");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !state.registry.get("branch-source").unwrap().run_state().is_running() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(state.registry.get("branch-source").unwrap().run_state().is_running(), "fixture run did not start");
        let busy_rename = call("sessions.rename", json!({"session":"branch-source","name":"should not write"}));
        assert_eq!(busy_rename["error"]["code"], "busy", "{busy_rename}");
        let busy_export = call("sessions.export", json!({"session":"branch-source"}));
        assert_eq!(busy_export["error"]["code"], "busy", "{busy_export}");
        for kind in ["fork", "fork_branch", "clone", "navigate_tree"] {
            let blocked = call("agent.command", json!({"session":"branch-source","type":kind,"entryId":"aa","targetId":"aa"}));
            assert_eq!(blocked["error"]["code"], "busy", "{kind}: {blocked}");
        }
        let abort = call("agent.command", json!({"session":"branch-source","type":"abort"}));
        assert_eq!(abort["ok"], true, "{abort}");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while state.registry.get("branch-source").is_some_and(|s| s.run_state().is_running()) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let old = state.registry.get("branch-source").unwrap();
        assert!(!old.run_state().is_running());
        use std::os::unix::fs::PermissionsExt;
        let hung = temp.path().join("hung-writer");
        std::fs::write(&hung, r##"#!/usr/bin/python3
import sys,time,json,base64,os
request=json.loads(sys.stdin.readline())
token=request['message'].split()[2]
payload=json.loads(base64.urlsafe_b64decode(token+'='*(-len(token)%4)))
time.sleep(1)
with open(os.path.join(payload['args']['staging'],'late-output.jsonl'),'w') as f:
    f.write('{"late":true}\n')
time.sleep(30)
"##).unwrap();
        std::fs::set_permissions(&hung, std::fs::Permissions::from_mode(0o700)).unwrap();
        state.management_config.lock().unwrap().as_mut().unwrap().executable = hung.to_string_lossy().into_owned();
        *state.session_writer_timeout.lock().unwrap() = Duration::from_millis(200);
        let failed = std::thread::scope(|scope| {
            let worker = scope.spawn(|| call("agent.command", json!({"session":"branch-source","type":"fork_branch","entryId":"aa"})));
            let fence = crate::session_writer_fence::fence_path(&state.agent_dir(), "branch-source");
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !fence.exists() && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(10)); }
            assert!(fence.exists());
            assert!(old.bridge_request("tree.navigate", Some(json!({"targetId":"ab"})), Some(Duration::from_secs(1))).is_err());
            assert!(old.command("prompt", json!({"message":"blocked"}), Some(Duration::from_secs(1))).is_err());
            worker.join().unwrap()
        });
        assert_eq!(failed["error"]["code"], "outcome_unknown", "{failed}");
        assert!(std::sync::Arc::ptr_eq(&old, &state.registry.get("branch-source").unwrap()));
        assert!(old.command("prompt", json!({"message":"blocked"}), Some(Duration::from_secs(2))).is_err());
        assert!(old.bridge_request("tree.navigate", Some(json!({"targetId":"ab"})), Some(Duration::from_secs(1))).is_err());
        assert!(old.composer_enqueue("blocked", None).is_err());
        let agent = state.agent_dir();
        let record: Value = serde_json::from_slice(&std::fs::read(crate::session_writer_fence::fence_path(&agent, "branch-source")).unwrap()).unwrap();
        let target = record["targetId"].as_str().unwrap();
        assert!(crate::session_writer_fence::assert_session_writable(&agent, target).is_err());
        let restart = state.registry.with_idle_session_writer(target, |_| Ok::<_, ()>(()));
        assert!(matches!(restart, Err(session_host::SessionWriterError::Busy(_))));
        let restart = state.registry.start_with_plan(target, &agent.join("sessions/nonexistent.jsonl"), target, &cwd, || unreachable!());
        assert!(restart.is_err());
        let staging = Path::new(record["staging"].as_str().unwrap());
        assert!(staging.join("late-output.jsonl").is_file(), "stalled child wrote only inside private staging");
        assert!(session_host::history::find_session_by_id(&agent, target).is_none(), "unknown writer never published a target");
        assert!(crate::session_writer_fence::assert_session_writable(&agent, "branch-source").is_err());
        state.registry.remove("branch-source", Duration::from_secs(5));
        state.management.shutdown_all(Duration::from_secs(5));

    }
}
