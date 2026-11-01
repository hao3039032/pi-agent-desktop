use super::*;
use crate::pi_ipc::{dispatch_envelope, SpawnBase};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::path::Path;

#[test]
fn real_pi_title_uses_live_session_start_provider() {
    let executable = std::env::var("PI_CLI_BIN").expect("PI_CLI_BIN must name the isolated fixture executable");
    let temp = tempfile::tempdir().unwrap();
    let agent = temp.path().join("agent");
    let cwd = temp.path().join("project");
    let sessions = agent.join("sessions/project");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(agent.join("extensions")).unwrap();
    std::fs::create_dir_all(&sessions).unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let seen = Arc::new(AtomicUsize::new(0));
    let hold = Arc::new(AtomicBool::new(false));
    let reject = Arc::new(AtomicBool::new(false));
    let completed = Arc::new(AtomicUsize::new(0));
    let worker_stop = stop.clone(); let worker_seen = seen.clone(); let worker_hold = hold.clone(); let worker_completed = completed.clone(); let worker_reject = reject.clone();
    let server = std::thread::spawn(move || {
        while !worker_stop.load(Ordering::Relaxed) {
            if let Ok((mut stream, _)) = listener.accept() {
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = Vec::new(); let mut buf = [0; 4096];
                loop {
                    let n = stream.read(&mut buf).unwrap_or(0); if n == 0 { break; } request.extend_from_slice(&buf[..n]);
                    if let Some(end) = request.windows(4).position(|x| x == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let len: usize = headers.lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").and_then(|n| n.trim().parse().ok())).unwrap_or(0);
                        if request.len() >= end + 4 + len { break; }
                    }
                }
                if !request.windows(4).any(|window| window == b"\r\n\r\n") { continue; }
                assert!(String::from_utf8_lossy(&request).to_ascii_lowercase().contains("authorization: bearer live-fixture"));
                worker_seen.fetch_add(1, Ordering::SeqCst);
                while worker_hold.load(Ordering::SeqCst) && !worker_stop.load(Ordering::Relaxed) { std::thread::sleep(Duration::from_millis(10)); }
                let body = "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Live Fixture Title\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
                if worker_reject.load(Ordering::SeqCst) {
                    let body = "{\"error\":{\"message\":\"401 invalid api key\"}}";
                    let _ = write!(stream, "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                } else {
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                }
                worker_completed.fetch_add(1, Ordering::SeqCst);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    struct ServerGuard(Arc<AtomicBool>, Option<std::thread::JoinHandle<()>>);
    impl Drop for ServerGuard { fn drop(&mut self) { self.0.store(true, Ordering::Relaxed); if let Some(t) = self.1.take() { if !std::thread::panicking() { t.join().expect("fake provider thread failed"); } else { let _ = t.join(); } } } }
    let _server = ServerGuard(stop, Some(server));
    let model = json!({"id":"fixture","name":"fixture","reasoning":false,"input":["text"],"contextWindow":200000,"maxTokens":4096,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}});
    std::fs::write(agent.join("models.json"), json!({"providers":{"fixture":{"baseUrl":"http://127.0.0.1:1","apiKey":"wrong-fixture","api":"openai-completions","models":[model.clone()]}}}).to_string()).unwrap();
    std::fs::write(agent.join("settings.json"), r#"{"defaultProvider":"fixture","defaultModel":"fixture"}"#).unwrap();
    let mut other_model = model.clone(); other_model["id"] = json!("other");
    let ext = format!(r#"export default function(pi) {{ pi.on('session_start', async (_event, ctx) => {{ pi.registerProvider('fixture', {{ baseUrl: 'http://{address}', apiKey: 'live-fixture', api: 'openai-completions', models: [{model},{other_model}] }}); pi.registerVirtualModel({{ provider:'router', id:'auto', name:'Auto', route(_request, current) {{ return {{ model: current.modelRegistry.find('fixture','fixture'), thinkingLevel:'off' }}; }} }}); const model = ctx.modelRegistry.find('fixture','fixture'); await pi.setModel(model); }}); }}"#);
    std::fs::write(agent.join("extensions/live.js"), ext).unwrap();
    let file = sessions.join("title.jsonl");
    let entries = [json!({"type":"session","version":3,"id":"title","cwd":cwd,"timestamp":"2026-01-01T00:00:00.000Z"}), json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"Describe the local fixture"}}), json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"fixture answer"}]}})];
    std::fs::write(&file, entries.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();
    let managed = temp.path().join("managed");
    std::fs::create_dir_all(managed.join("@earendil-works")).unwrap();
    std::os::unix::fs::symlink(Path::new("../node_modules/@earendil-works/pi-coding-agent").canonicalize().unwrap(), managed.join("@earendil-works/pi-coding-agent")).unwrap();
    std::os::unix::fs::symlink(Path::new("../node_modules").canonicalize().unwrap(), managed.join("node_modules")).unwrap();
    let build = std::process::Command::new("node").arg("../scripts/migration/build-management-modules.mjs").arg("--out").arg(&managed).output().unwrap();
    assert!(build.status.success(), "{}", String::from_utf8_lossy(&build.stderr));
    let delay_flag = temp.path().join("delay-title-rename");
    let refuse_flag = temp.path().join("refuse-title-rename");
    let bridge_asset = temp.path().join("pi-web-bridge.mjs");
    let source = std::fs::read_to_string("../lib/pi-rpc/assets/pi-web-bridge.mjs").unwrap();
    let needle = "      ctx.sessionManager.appendSessionInfo(payload.name.trim());";
    assert_eq!(source.matches(needle).count(), 2);
    let delayed = format!("      if ((await import('node:fs')).existsSync({})) await new Promise(resolve => setTimeout(resolve, 600));\n{}", json!(delay_flag), needle);
    let precheck = "    if (payload.op === \"title.rename\") {\n      try {";
    assert_eq!(source.matches(precheck).count(), 1);
    let refuse = format!("{}\n        if ((await import('node:fs')).existsSync({})) throw new Error('fixture refusal');", precheck, json!(refuse_flag));
    std::fs::write(&bridge_asset, source.replacen(needle, &delayed, 1).replacen(precheck, &refuse, 1)).unwrap();
    let state = IpcHostState::new();
    *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
    *state.spawn_base.lock().unwrap() = Some(SpawnBase { executable: executable.clone(), bridge_asset, artifacts_asset: None, chat_asset: None });
    *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig { executable, agent_dir: Some(agent.clone()), extensions: vec![Path::new("../lib/pi-rpc/assets/pi-web-management.mjs").canonicalize().unwrap()], env: vec![("PI_WEB_MANAGED_MODULES".into(), managed.to_string_lossy().into_owned())] });
    let call = |op: &str, args: Value| dispatch_envelope(&state, json!({"v":1,"id":"test","op":op,"args":args}));
    let started = call("sessions.autoName", json!({"session":"title"}));
    assert_eq!(started["ok"], true, "{started}");
    let live = state.registry.get("title").unwrap().get_state().unwrap();
    assert_eq!(live["model"]["baseUrl"], format!("http://{address}"));
    let task = started["data"]["task"].as_str().unwrap();
    let duplicate = call("sessions.autoName", json!({"session":"title"}));
    assert_eq!(duplicate["error"]["code"], "busy", "{duplicate}");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let result = call("sessions.autoNameStatus", json!({"session":"title","task":task}));
        assert_eq!(result["ok"], true, "{result}");
        if result["data"]["status"] != "running" { assert_eq!(result["data"]["title"], "Live Fixture Title", "{result}"); break; }
        assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(seen.load(Ordering::SeqCst), 1, "live provider endpoint was not called");
    let wait_seen = |count| { let until = Instant::now() + Duration::from_secs(10); while seen.load(Ordering::SeqCst) < count { assert!(Instant::now() < until, "expected request {count}, observed {}", seen.load(Ordering::SeqCst)); std::thread::sleep(Duration::from_millis(10)); } };
    let poll = |task: &str| { let until = Instant::now() + Duration::from_secs(10); loop { let result = call("sessions.autoNameStatus", json!({"session":"title","task":task})); if result["data"]["status"] != "running" { break result; } assert!(Instant::now() < until); std::thread::sleep(Duration::from_millis(20)); } };
    // A cancelled provider request cannot rename when its late reply arrives.
    hold.store(true, Ordering::SeqCst);
    let started = call("sessions.autoName", json!({"session":"title"}));
    let task = started["data"]["task"].as_str().unwrap(); wait_seen(2);
    let cancelled = call("sessions.autoNameCancel", json!({"session":"title","task":task}));
    assert_eq!(cancelled["data"]["cancelled"], true, "{cancelled}");
    hold.store(false, Ordering::SeqCst);
    let until = Instant::now() + Duration::from_secs(5); while completed.load(Ordering::SeqCst) < 2 { assert!(Instant::now() < until); std::thread::sleep(Duration::from_millis(10)); }
    assert_eq!(call("sessions.autoNameStatus", json!({"session":"title","task":task}))["error"]["code"], "not_found");
    // A branch move while the network request is active invalidates the result.
    hold.store(true, Ordering::SeqCst);
    let started = call("sessions.autoName", json!({"session":"title"}));
    let task = started["data"]["task"].as_str().unwrap(); wait_seen(3);
    let nav = call("agent.command", json!({"session":"title","type":"navigate_tree","targetId":"u1"}));
    assert_eq!(nav["ok"], true, "{nav}");
    let nav = call("agent.command", json!({"session":"title","type":"navigate_tree","targetId":"a1"}));
    assert_eq!(nav["ok"], true, "{nav}");
    hold.store(false, Ordering::SeqCst);
    let stale = poll(task); assert_eq!(stale["error"]["code"], "stale", "{stale}");
    let until = Instant::now() + Duration::from_secs(5); while completed.load(Ordering::SeqCst) < 3 { assert!(Instant::now() < until); std::thread::sleep(Duration::from_millis(10)); }
    // The fence must be checked again after generation and before rename.
    let nav = call("agent.command", json!({"session":"title","type":"navigate_tree","targetId":"a1"}));
    assert_eq!(nav["ok"], true, "{nav}");
    hold.store(true, Ordering::SeqCst);
    let started = call("sessions.autoName", json!({"session":"title"}));
    let task = started["data"]["task"].as_str().unwrap(); wait_seen(4);
    crate::session_writer_fence::begin(&agent, "title", "fixture-op", "test", &file, None, None).unwrap();
    hold.store(false, Ordering::SeqCst);
    let blocked = poll(task); assert_eq!(blocked["error"]["code"], "busy", "{blocked}");
    crate::session_writer_fence::finish(&agent, "title", "fixture-op").unwrap();
    // Authentication failure is surfaced without a fallback request.
    reject.store(true, Ordering::SeqCst);
    let started = call("sessions.autoName", json!({"session":"title"}));
    let task = started["data"]["task"].as_str().unwrap();
    let failed = poll(task); assert_eq!(failed["ok"], false, "{failed}");
    assert!(failed["error"]["message"].as_str().unwrap().contains("401"), "{failed}");
    assert_eq!(seen.load(Ordering::SeqCst), 5);
    reject.store(false, Ordering::SeqCst);
    // A model A → B → A change invalidates the task, even if its final JSON matches.
    hold.store(true, Ordering::SeqCst);
    let started = call("sessions.autoName", json!({"session":"title"}));
    let task = started["data"]["task"].as_str().unwrap(); wait_seen(6);
    for model in ["other", "fixture"] {
        let changed = call("agent.command", json!({"session":"title","type":"set_model","provider":"fixture","modelId":model}));
        assert_eq!(changed["ok"], true, "{changed}");
    }
    hold.store(false, Ordering::SeqCst);
    let stale = poll(task); assert_eq!(stale["error"]["code"], "stale", "{stale}");
    let until = Instant::now() + Duration::from_secs(5); while completed.load(Ordering::SeqCst) < 6 { assert!(Instant::now() < until); std::thread::sleep(Duration::from_millis(10)); }
    // A virtual model registered at session_start routes through the live registry.
    let changed = call("agent.command", json!({"session":"title","type":"set_model","provider":"router","modelId":"auto"}));
    assert_eq!(changed["ok"], true, "{changed}");
    let started = call("sessions.autoName", json!({"session":"title"}));
    let task = started["data"]["task"].as_str().unwrap();
    let result = poll(task); assert_eq!(result["data"]["title"], "Live Fixture Title", "{result}");
    assert_eq!(seen.load(Ordering::SeqCst), 7);
    // Closing the original child never applies its result to a replacement.
    hold.store(true, Ordering::SeqCst);
    let started = call("sessions.autoName", json!({"session":"title"}));
    let task = started["data"]["task"].as_str().unwrap(); wait_seen(8);
    let previous = state.registry.get("title").unwrap();
    state.registry.remove("title", Duration::from_secs(5));
    let resumed = call("agent.command", json!({"session":"title","type":"get_state"}));
    assert_eq!(resumed["ok"], true, "{resumed}");
    assert!(!Arc::ptr_eq(&previous, &state.registry.get("title").unwrap()));
    hold.store(false, Ordering::SeqCst);
    let result = poll(task); assert_eq!(result["error"]["code"], "stale", "{result}");
    let until = Instant::now() + Duration::from_secs(5); while completed.load(Ordering::SeqCst) < 8 { assert!(Instant::now() < until); std::thread::sleep(Duration::from_millis(10)); }
    // An authenticated pre-append refusal is definitive and removes only its own fence.
    std::fs::write(&refuse_flag, "refuse").unwrap();
    let started = call("sessions.autoName", json!({"session":"title"}));
    let task = started["data"]["task"].as_str().unwrap();
    let refused = poll(task); assert_eq!(refused["error"]["code"], "busy", "{refused}");
    assert!(!crate::session_writer_fence::fence_path(&agent, "title").exists());
    std::fs::remove_file(&refuse_flag).unwrap();
    // The child executes rename after the host has timed out: the durable
    // fence, not an absent ACK or a refreshed list, blocks later writers.
    let before_late = std::fs::read(&file).unwrap();
    std::fs::write(&delay_flag, "delay").unwrap();
    *state.title_rename_timeout.lock().unwrap() = Duration::from_millis(100);
    let started = call("sessions.autoName", json!({"session":"title"}));
    let task = started["data"]["task"].as_str().unwrap();
    let unknown = poll(task); assert_eq!(unknown["error"]["code"], "outcome_unknown", "{unknown}");
    let fence = crate::session_writer_fence::fence_path(&agent, "title");
    assert!(fence.exists());
    assert!(state.registry.get("title").unwrap().command("prompt", json!({"message":"blocked"}), Some(Duration::from_secs(2))).is_err());
    assert_eq!(call("sessions.autoNameCancel", json!({"session":"title","task":task}))["ok"], false);
    std::thread::sleep(Duration::from_millis(800));
    let after_late = std::fs::read(&file).unwrap();
    assert!(after_late.len() > before_late.len(), "late rename must actually append after timeout");
    assert!(fence.exists());
    let restarted = IpcHostState::new();
    *restarted.task_agent_dir.lock().unwrap() = Some(agent.clone());
    let writer = restarted.registry.with_offline_session_writer("title", Duration::from_millis(10), || Ok::<_, ()>(()));
    assert!(matches!(writer, Err(session_host::SessionWriterError::Busy(_))));
    // An unrelated task mutex must not make the global table serialize
    // another session's start and cancellation.
    let second_file = sessions.join("other.jsonl");
    std::fs::write(&second_file, [json!({"type":"session","version":3,"id":"other-session","cwd":cwd,"timestamp":"2026-01-01T00:00:00.000Z"}), json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"Other task"}})].iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();
    let blocked_task = Arc::new(Mutex::new(TitleTask { session: state.registry.get("title").unwrap(), id: "held".into(), snapshot: Value::Null, expires: Instant::now() + Duration::from_secs(120) }));
    state.title_tasks.lock().unwrap().insert("held".into(), Some(blocked_task.clone()));
    let held_guard = blocked_task.lock().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    hold.store(true, Ordering::SeqCst);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            let started = call("sessions.autoName", json!({"session":"other-session"}));
            let result = if let Some(task) = started["data"]["task"].as_str() {
                let status = call("sessions.autoNameStatus", json!({"session":"other-session","task":task}));
                if status["data"]["status"] == "running" { call("sessions.autoNameCancel", json!({"session":"other-session","task":task})) } else { status }
            } else { started };
            tx.send(result).unwrap();
        });
        let received = rx.recv_timeout(Duration::from_secs(8));
        drop(held_guard);
        let result = received.expect("other session was blocked by the global title task lock");
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["data"]["cancelled"], true, "{result}");
    });
    hold.store(false, Ordering::SeqCst);
    state.title_tasks.lock().unwrap().remove("held");
    let other = state.registry.get("other-session").unwrap();
    let other_guard = other.try_branch_activity().unwrap();
    let source = state.registry.get("title").unwrap();
    assert!(source.title_rename_with_owned_fence(&other_guard, "not-owner", "blocked", Some(Duration::from_secs(1))).is_err());
    drop(other_guard);
    state.registry.remove("other-session", Duration::from_secs(5));
    state.registry.remove("title", Duration::from_secs(5));
    state.management.shutdown_all(Duration::from_secs(5));
}
