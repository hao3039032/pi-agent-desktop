//! Host-side validation for continuing a chat in a project.
use std::path::{Path, PathBuf};
use crate::file_access::AllowedRoots;
use crate::session_view::{chat_workspace_dir, legacy_chat_workspace_dir};
use crate::pi_ipc::IpcHostState;
use serde_json::{json, Value};
use std::time::Duration;

fn error(code: &str, message: impl ToString) -> (String, String) { (code.into(), message.to_string()) }

pub(crate) fn random_id() -> Result<String, (String, String)> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| error("io", e))?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h = bytes.iter().map(|v| format!("{v:02x}")).collect::<String>();
    Ok(format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]))
}

fn source(state: &IpcHostState, id: &str) -> Result<session_host::SessionSummary, (String, String)> {
    let agent = state.agent_dir();
    let index = session_host::history::scan_sessions(&agent);
    let mut matches = index.projects.into_values().flatten().filter(|entry| entry.id == id);
    let mut summary = matches.next().ok_or_else(|| error("not_found", "Session not found"))?;
    if matches.next().is_some() { return Err(error("invalid_args", "Duplicate session identities cannot be modified")); }
    let root = agent.join("sessions").canonicalize().map_err(|e| error("io", e))?;
    summary.file = summary.file.canonicalize().map_err(|e| error("io", e))?;
    if !summary.file.starts_with(root) { return Err(error("access_denied", "Session is outside session storage")); }
    if !crate::session_view::is_chat_workspace_path(Path::new(&summary.cwd), &agent) {
        return Err(error("invalid_args", "Only a chat can be continued in a project"));
    }
    Ok(summary)
}

#[cfg(unix)]
pub(crate) fn writer_config(state: &IpcHostState) -> Result<management_host::ManagementSpawnConfig, (String, String)> {
    let mut config = state.management_config.lock().unwrap().clone().ok_or_else(|| error("management_unavailable", "Management runtime unavailable"))?;
    let agent = state.agent_dir();
    if config.agent_dir.as_deref().is_some_and(|configured| configured != agent) || config.extensions.len() != 1 {
        return Err(error("not_supported", "Invalid session writer configuration"));
    }
    config.agent_dir = Some(agent);
    let asset = std::fs::read(&config.extensions[0]).map_err(|e| error("io", e))?;
    if asset != include_bytes!("../../lib/pi-rpc/assets/pi-web-management.mjs") {
        return Err(error("access_denied", "Untrusted session writer asset"));
    }
    if config.env.len() != 1 || config.env[0].0 != "PI_WEB_MANAGED_MODULES" || !Path::new(&config.env[0].1).is_dir() {
        return Err(error("management_unavailable", "Invalid session writer module tree"));
    }
    Ok(config)
}

/// Only the fixed management asset and its synchronous SDK file graph run here:
/// these operations do not spawn subprocesses or external commands. Their pi
/// process has a private process group. This proof is not valid for other ops.
#[cfg(unix)]
pub(crate) fn run_writer(state: &IpcHostState, op: &str, args: Value) -> Result<Value, (String, String)> {
    let config = writer_config(state).map_err(|e| error("outcome_unknown", format!("Session writer outcome unknown; do not retry: {}", e.1)))?;
    let writer = management_host::spawn_session_file_writer(&config).map_err(|e| error("outcome_unknown", e))?;
    let pid = writer.pid();
    #[cfg(test)]
    let timeout = *state.session_writer_timeout.lock().unwrap();
    #[cfg(not(test))]
    let timeout = Duration::from_secs(60);
    let result = writer.call(op, args, timeout);
    let exited = writer.close(Duration::from_secs(5));
    // Only an absent process group after an orderly leader exit permits success.
    let group_gone = exited && i32::try_from(pid).ok().filter(|pid| *pid > 1).is_some_and(|pid| {
        (unsafe { libc::kill(-pid, 0) }) == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    });
    if !group_gone {
        let _ = writer.force_stop(Duration::from_secs(5));
        return Err(error("outcome_unknown", "Session writer exit could not be verified; do not retry"));
    }
    result.map_err(|e| error("outcome_unknown", format!("Session writer outcome unknown; do not retry: {e}")))
}

#[cfg(not(unix))]
pub(crate) fn run_writer(_state: &IpcHostState, _op: &str, _args: Value) -> Result<Value, (String, String)> {
    Err(error("not_supported", "Session file mutations are not supported on this platform"))
}


pub(crate) fn is_owned_chat_folder(cwd: &Path, agent: &Path) -> bool {
    if !crate::session_view::is_chat_folder_path(cwd, agent)
        || !std::fs::symlink_metadata(cwd).is_ok_and(|entry| entry.file_type().is_dir() && !entry.file_type().is_symlink()) {
        return false;
    }
    match (cwd.canonicalize(), chat_workspace_dir(agent).canonicalize()) {
        (Ok(folder), Ok(root)) => folder.is_dir() && folder.parent() == Some(root.as_path()),
        _ => false,
    }
}

fn session_id(args: &Value) -> Result<&str, (String, String)> {
    args.get("session").and_then(Value::as_str).filter(|v| !v.is_empty())
        .ok_or_else(|| error("invalid_args", "session is required"))
}

fn has_assistant(file: &Path) -> Result<bool, (String, String)> {
    use std::io::BufRead;
    let reader = std::io::BufReader::new(std::fs::File::open(file).map_err(|e| error("io", e))?);
    let mut found = false;
    for line in reader.lines() {
        let line = line.map_err(|e| error("io", e))?;
        if line.trim().is_empty() { continue; }
        let value: Value = serde_json::from_str(&line).map_err(|_| error("invalid_args", "Damaged session transcript"))?;
        if value.get("type").and_then(Value::as_str) == Some("message") && value.pointer("/message/role").and_then(Value::as_str) == Some("assistant") { found = true; }
    }
    Ok(found)
}

fn digest(file: &Path) -> Result<Vec<u8>, (String, String)> {
    use sha2::{Digest, Sha256};
    let mut input = std::fs::File::open(file).map_err(|e| error("io", e))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut input, &mut hasher).map_err(|e| error("io", e))?;
    Ok(hasher.finalize().to_vec())
}

pub(crate) fn set_access(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let id = session_id(args)?;
    let unlocked = args.get("unlocked").and_then(Value::as_bool).ok_or_else(|| error("invalid_args", "unlocked must be a boolean"))?;
    if !state.chat_unlock_permitted() { return Err(error("access_denied", "Chat access changes require a trusted packaged desktop")); }
    let _policy = state.policy_gate.try_read().map_err(|_| error("busy", "Session policy change is in progress"))?;
    let agent = state.agent_dir();
    let preliminary = source(state, id)?;
    if !is_owned_chat_folder(Path::new(&preliminary.cwd), &agent) { return Err(error("invalid_args", "Only a chat with its own folder can use the computer")); }
    #[cfg(unix)]
    writer_config(state)?;
    #[cfg(not(unix))]
    return Err(error("not_supported", "Session file mutations are not supported on this platform"));
    let result = state.registry.with_offline_session_writer(id, Duration::from_secs(5), || {
        let summary = source(state, id)?;
        if !is_owned_chat_folder(Path::new(&summary.cwd), &agent) { return Err(error("invalid_args", "Only a chat with its own folder can use the computer")); }
        if !has_assistant(&summary.file)? { return Err(error("invalid_args", "Send a message first, then this chat can use the computer")); }
        let operation = random_id()?;
        crate::session_writer_fence::begin(&agent, id, &operation, "chat-access", &summary.file, None, None).map_err(|e| error("outcome_unknown", e))?;
        let answer = run_writer(state, "session.setOfflineChatUnlock", json!({"file":summary.file,"unlocked":unlocked}))?;
        if !answer.get("changed").is_some_and(Value::is_boolean)
            || !has_assistant(&summary.file).map_err(|e| error("outcome_unknown", format!("Access change could not be verified; do not retry: {}", e.1)))?
            || session_host::spawn_plan::read_chat_unlocked(&summary.file) != unlocked {
            return Err(error("outcome_unknown", "Access change could not be verified; do not retry"));
        }
        crate::session_writer_fence::finish(&agent, id, &operation).map_err(|e| error("partial_success", format!("Chat access was saved, but its completion record could not be cleared; do not retry: {e}")))?;
        Ok(())
    });
    match result {
        Err(session_host::SessionWriterError::Busy(message)) => return Err(error("busy", message)),
        Err(session_host::SessionWriterError::Operation(error)) => return Err(error),
        Ok(()) => {}
    }
    drop(_policy);
    crate::pi_ipc::dispatch_with_resume(state, "agent.command", &json!({"session": id, "type": "get_state"}))
        .map_err(|(_, message)| error("partial_success", format!("Chat access was saved, but the session could not reopen; do not repeat the change: {message}")))?;
    Ok(json!({"success":true,"data":{"sessionId":id,"recreated":true,"unlocked":unlocked}}))
}

pub(crate) fn continue_in_project(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let id = session_id(args)?;
    let proposed = args.get("cwd").and_then(Value::as_str).ok_or_else(|| error("invalid_args", "cwd is required"))?;
    let _policy = state.policy_gate.try_read().map_err(|_| error("busy", "Session policy change is in progress"))?;
    let agent = state.agent_dir();
    let cwd = project_destination(&state.file_roots.lock().unwrap(), &agent, proposed)?;
    source(state, id)?;
    #[cfg(unix)]
    writer_config(state)?;
    #[cfg(not(unix))]
    return Err(error("not_supported", "Session file mutations are not supported on this platform"));
    let result = state.registry.with_offline_session_writer(id, Duration::from_secs(5), || {
        let summary = source(state, id)?;
        let before = digest(&summary.file)?;
        let operation = random_id()?;
        let target_id = random_id()?;
        if session_host::history::find_session_by_id(&agent, &target_id).is_some() { return Err(error("busy", "Generated session identity already exists")); }
        crate::session_writer_fence::begin(&agent, id, &operation, "continue", &summary.file, Some(&cwd), Some(&target_id)).map_err(|e| error("outcome_unknown", e))?;
        crate::session_writer_fence::begin(&agent, &target_id, &operation, "continue-target", &summary.file, Some(&cwd), Some(&target_id)).map_err(|e| error("outcome_unknown", e))?;
        let answer = run_writer(state, "session.continueChat", json!({"file":summary.file,"cwd":cwd,"targetId":target_id}))?;
        let copied = answer.get("path").and_then(Value::as_str).ok_or_else(|| error("outcome_unknown", "Copy result missing path; do not retry"))?;
        let copied = Path::new(copied).canonicalize().map_err(|e| error("outcome_unknown", e))?;
        let target_root = crate::session_view::default_session_dir(&agent, &cwd).canonicalize().map_err(|e| error("outcome_unknown", e))?;
        let header = session_host::history::read_header_summary(&copied).map_err(|e| error("outcome_unknown", e))?;
        if copied.parent() != Some(target_root.as_path()) || header.id != target_id || header.cwd != cwd.to_string_lossy()
            || header.parent_session.as_deref() != summary.file.to_str()
            || digest(&summary.file).map_err(|e| error("outcome_unknown", format!("Copy source could not be verified; do not retry: {}", e.1)))? != before {
            return Err(error("outcome_unknown", "Copy identity could not be verified; do not retry"));
        }
        crate::session_writer_fence::finish(&agent, &target_id, &operation).map_err(|e| error("partial_success", format!("Project copy was created, but its completion record could not be cleared; do not retry: {e}")))?;
        crate::session_writer_fence::finish(&agent, id, &operation).map_err(|e| error("partial_success", format!("Project copy was created, but its completion record could not be cleared; do not retry: {e}")))?;
        Ok(json!({"sessionId":target_id,"path":copied,"cwd":cwd,"chatFolder":if crate::session_view::is_chat_folder_path(Path::new(&summary.cwd), &agent) { Some(summary.cwd) } else { None }}))
    });
    match result {
        Ok(value) => Ok(value),
        Err(session_host::SessionWriterError::Busy(message)) => Err(error("busy", message)),
        Err(session_host::SessionWriterError::Operation(error)) => Err(error),
    }
}

pub(crate) fn get_access(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let id = args.get("session").and_then(Value::as_str).filter(|v| !v.is_empty())
        .ok_or_else(|| ("invalid_args".into(), "session is required".into()))?;
    let agent = state.agent_dir();
    let live = state.registry.get(id);
    let summary = session_host::history::find_session_by_id(&agent, id);
    let (cwd, file) = match (live.as_ref(), summary.as_ref()) {
        (Some(session), _) => (session.cwd.clone(), Some(session.session_file.clone())),
        (None, Some(summary)) => (PathBuf::from(&summary.cwd), Some(summary.file.clone())),
        (None, None) => return Err(("not_found".into(), "Session not found".into())),
    };
    let chat = crate::session_view::is_chat_workspace_path(&cwd, &agent);
    let folder = chat && crate::session_view::is_chat_folder_path(&cwd, &agent);
    let pending = chat && crate::session_writer_fence::assert_session_writable(&agent, id).is_err();
    let can_unlock = folder && is_owned_chat_folder(&cwd, &agent) && state.chat_unlock_permitted();
    let unlocked = can_unlock && file.as_deref().is_some_and(session_host::spawn_plan::read_chat_unlocked);
    Ok(json!({"chat": chat, "folder": if folder { Some(cwd.to_string_lossy().into_owned()) } else { None }, "available": can_unlock && !pending, "unlocked": unlocked, "pending": pending}))
}

/// A frontend path is only a proposal: it must already be authorized by the host.
pub(crate) fn project_destination(roots: &AllowedRoots, agent_dir: &Path, proposed: &str) -> Result<PathBuf, (String, String)> {
    if proposed.is_empty() || !Path::new(proposed).is_absolute() {
        return Err(("invalid_args".into(), "Choose a project folder".into()));
    }
    let cwd = std::fs::canonicalize(proposed)
        .map_err(|_| ("invalid_args".into(), "Project folder does not exist".into()))?;
    if !cwd.is_dir() {
        return Err(("invalid_args".into(), "Choose a project folder".into()));
    }
    if !roots.is_existing_path_allowed(&cwd) {
        return Err(("access_denied".into(), "Project folder is not authorized".into()));
    }
    for root in [chat_workspace_dir(agent_dir), legacy_chat_workspace_dir(agent_dir)] {
        if let Ok(root) = root.canonicalize() {
            if cwd.starts_with(root) {
                return Err(("invalid_args".into(), "Choose a project folder".into()));
            }
        }
    }
    Ok(cwd)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn real_pi_management_copies_chat_and_persists_unlock() {
        use serde_json::json;
        use crate::pi_ipc::{IpcHostState, management_call};
        let executable = std::env::var("PI_CLI_BIN").expect("PI_CLI_BIN is required");
        let temp = tempfile::tempdir().unwrap();
        let agent = temp.path().join("agent");
        let chat = agent.join("chats/fixture");
        let project = temp.path().join("project");
        let managed = temp.path().join("managed");
        for dir in [&chat, &project, &managed.join("@earendil-works")] { std::fs::create_dir_all(dir).unwrap(); }
        std::os::unix::fs::symlink(Path::new("../node_modules/@earendil-works/pi-coding-agent").canonicalize().unwrap(), managed.join("@earendil-works/pi-coding-agent")).unwrap();
        std::os::unix::fs::symlink(Path::new("../node_modules").canonicalize().unwrap(), managed.join("node_modules")).unwrap();
        let build = std::process::Command::new("node").arg("../scripts/migration/build-management-modules.mjs").arg("--out").arg(&managed).output().unwrap();
        assert!(build.status.success(), "{}", String::from_utf8_lossy(&build.stderr));
        let source_dir = crate::session_view::default_session_dir(&agent, &chat);
        std::fs::create_dir_all(&source_dir).unwrap();
        let file = source_dir.join("source.jsonl");
        let rows = [
            json!({"type":"session","version":3,"id":"source","timestamp":"2026-01-01T00:00:00.000Z","cwd":chat}),
            json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello"}}),
            json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}),
        ];
        let source = rows.iter().map(|row| row.to_string()).collect::<Vec<_>>().join("\n") + "\n";
        std::fs::write(&file, &source).unwrap();
        // Old SDK versions left sessions directly in agentDir; real pi startup
        // migrates those files before the management request runs.
        let loose = agent.join("legacy-layout.jsonl");
        let loose_source = source.replacen("\"source\"", "\"legacy-source\"", 1);
        std::fs::write(&loose, &loose_source).unwrap();
        let mut state = IpcHostState::new();
        *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
        let access = get_access(&state, &json!({"session":"source"})).unwrap();
        assert_eq!(access["chat"], true);
        assert_eq!(access["available"], false);
        state.allow_chat_unlock_for_test();
        assert_eq!(get_access(&state, &json!({"session":"source"})).unwrap()["available"], true);
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable, agent_dir: Some(agent.clone()),
            extensions: vec![Path::new("../lib/pi-rpc/assets/pi-web-management.mjs").canonicalize().unwrap()],
            env: vec![("PI_WEB_MANAGED_MODULES".into(), managed.to_string_lossy().into_owned())],
        });
        assert_eq!(std::fs::read_to_string(&file).unwrap(), source, "source before management call");
        let args = json!({"file": file, "cwd": project, "targetId": "f55ce4c4-4294-4e8b-8415-1c73b7e6eff6"});
        let copied = management_call(&state, "session.continueChat", args).unwrap_or_else(|error| panic!("{error:?}; source: {:?}", std::fs::read_to_string(&file)));
        let copied_file = Path::new(copied["path"].as_str().unwrap());
        assert!(copied_file.starts_with(agent.join("sessions")));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), source);
        assert!(!loose.exists());
        assert_eq!(std::fs::read_to_string(source_dir.join("legacy-layout.jsonl")).unwrap(), loose_source);
        assert!(std::fs::read_to_string(copied_file).unwrap().contains("parentSession"));
        for unlocked in [true, false] {
            let result = management_call(&state, "session.setOfflineChatUnlock", json!({"file": file, "unlocked": unlocked})).unwrap();
            assert_eq!(result["changed"], true);
            assert_eq!(session_host::spawn_plan::read_chat_unlocked(&file), unlocked);
            assert_eq!(get_access(&state, &json!({"session":"source"})).unwrap()["unlocked"], unlocked);
        }
    }

    #[test]
    fn source_rejects_duplicate_ids_and_escaped_chat_folder() {
        let temp = tempfile::tempdir().unwrap();
        let agent = temp.path().join("agent");
        let chat = agent.join("chats/one");
        let sessions = agent.join("sessions/a");
        std::fs::create_dir_all(&chat).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        let row = json!({"type":"session","version":3,"id":"duplicate","timestamp":"2026-01-01T00:00:00Z","cwd":chat});
        for name in ["a.jsonl", "b.jsonl"] { std::fs::write(sessions.join(name), format!("{row}\n")).unwrap(); }
        let state = IpcHostState::new();
        *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
        assert_eq!(source(&state, "duplicate").unwrap_err().0, "invalid_args");
        #[cfg(unix)] {
            let external = temp.path().join("external");
            std::fs::create_dir_all(&external).unwrap();
            let link = agent.join("chats/link");
            std::os::unix::fs::symlink(&external, &link).unwrap();
            assert!(!is_owned_chat_folder(&link, &agent));
        }
    }

    #[test]
    fn packaged_window_check_rejects_network_and_non_application_documents() {
        let good = if cfg!(windows) { "http://tauri.localhost/index.html?x=1#chat" } else { "tauri://localhost/index.html?x=1#chat" };
        assert!(crate::pi_ipc::is_trusted_static_chat_window("main", &tauri::Url::parse(good).unwrap()));
        assert!(!crate::pi_ipc::is_trusted_static_chat_window("other", &tauri::Url::parse(good).unwrap()));
        for url in ["http://localhost:3000/", "http://127.0.0.1/", "https://example.com/", "about:blank", "tauri://localhost/other"] {
            assert!(!crate::pi_ipc::is_trusted_static_chat_window("main", &tauri::Url::parse(url).unwrap()));
        }
    }

    #[cfg(unix)]
    #[test]
    fn real_ipc_chat_access_and_continue_keep_source_and_reject_pending() {
        use crate::pi_ipc::{dispatch_envelope, SpawnBase};
        let executable = std::env::var("PI_CLI_BIN").expect("PI_CLI_BIN is required");
        let temp = tempfile::tempdir().unwrap();
        let agent = temp.path().join("agent");
        let chat = agent.join("chats/fixture");
        let project = temp.path().join("project");
        let managed = temp.path().join("managed");
        for dir in [&chat, &project, &managed.join("@earendil-works")] { std::fs::create_dir_all(dir).unwrap(); }
        std::os::unix::fs::symlink(Path::new("../node_modules/@earendil-works/pi-coding-agent").canonicalize().unwrap(), managed.join("@earendil-works/pi-coding-agent")).unwrap();
        std::os::unix::fs::symlink(Path::new("../node_modules").canonicalize().unwrap(), managed.join("node_modules")).unwrap();
        let build = std::process::Command::new("node").arg("../scripts/migration/build-management-modules.mjs").arg("--out").arg(&managed).output().unwrap();
        assert!(build.status.success(), "{}", String::from_utf8_lossy(&build.stderr));
        std::fs::write(agent.join("models.json"), json!({"providers":{"fixture":{"baseUrl":"http://127.0.0.1:9","apiKey":"fixture","api":"openai-completions","models":[{"id":"dummy","name":"Dummy","reasoning":false,"input":["text"],"contextWindow":200000,"maxTokens":4096,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}}).to_string()).unwrap();
        std::fs::write(agent.join("settings.json"), r#"{"defaultProvider":"fixture","defaultModel":"dummy"}"#).unwrap();
        let source_dir = crate::session_view::default_session_dir(&agent, &chat);
        std::fs::create_dir_all(&source_dir).unwrap();
        let file = source_dir.join("source.jsonl");
        let entries = [
            json!({"type":"session","version":3,"id":"chat-source","timestamp":"2026-01-01T00:00:00.000Z","cwd":chat}),
            json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"hello"}}),
            json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}),
        ];
        let initial = entries.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n";
        std::fs::write(&file, &initial).unwrap();
        let mut state = IpcHostState::new();
        *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
        state.file_roots.lock().unwrap().add(&project);
        *state.spawn_base.lock().unwrap() = Some(SpawnBase {
            executable: executable.clone(),
            bridge_asset: Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs").canonicalize().unwrap(),
            artifacts_asset: None,
            chat_asset: Some(Path::new("../lib/pi-rpc/assets/pi-web-chat.mjs").canonicalize().unwrap()),
        });
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable, agent_dir: Some(agent.clone()),
            extensions: vec![Path::new("../lib/pi-rpc/assets/pi-web-management.mjs").canonicalize().unwrap()],
            env: vec![("PI_WEB_MANAGED_MODULES".into(), managed.to_string_lossy().into_owned())],
        });
        let call = |state: &IpcHostState, op: &str, args: Value| dispatch_envelope(state, json!({"v":1,"id":"fixture","op":op,"args":args}));
        let args = json!({"session":"chat-source","unlocked":true});
        assert_eq!(call(&state, "sessions.chatAccessSet", args.clone())["error"]["code"], "access_denied");
        state.allow_chat_unlock_for_test();
        let unlocked = call(&state, "sessions.chatAccessSet", args);
        assert_eq!(unlocked["ok"], true, "{unlocked}");
        assert_eq!(call(&state, "sessions.chatAccessGet", json!({"session":"chat-source"}))["data"]["unlocked"], true);
        let tools = state.registry.get("chat-source").unwrap().bridge_request("tools.list", None, Some(Duration::from_secs(10))).unwrap();
        assert!(tools["active"].as_array().unwrap().iter().any(|name| name == "bash"), "{tools}");
        let outbox = state.registry.composer_outbox_for("chat-source");
        let pending = outbox.enqueue("pending", None).unwrap();
        assert_eq!(call(&state, "sessions.continueInProject", json!({"session":"chat-source","cwd":project}))["error"]["code"], "busy");
        outbox.take(&pending.id);
        let before = std::fs::read(&file).unwrap();
        let denied_dir = temp.path().join("denied");
        std::fs::create_dir_all(&denied_dir).unwrap();
        assert_eq!(call(&state, "sessions.continueInProject", json!({"session":"chat-source","cwd":denied_dir}))["error"]["code"], "access_denied");
        let copied = call(&state, "sessions.continueInProject", json!({"session":"chat-source","cwd":project}));
        assert_eq!(copied["ok"], true, "{copied}");
        assert_eq!(std::fs::read(&file).unwrap(), before);
        let target = PathBuf::from(copied["data"]["path"].as_str().unwrap());
        let header = session_host::history::read_header_summary(&target).unwrap();
        assert_eq!(header.parent_session.as_deref(), file.to_str());
        assert_eq!(header.cwd, project.to_string_lossy());
        let target_id = copied["data"]["sessionId"].as_str().unwrap();
        assert_eq!(call(&state, "sessions.continueInProject", json!({"session":target_id,"cwd":project}))["error"]["code"], "invalid_args");
        assert_eq!(call(&state, "sessions.chatAccessSet", json!({"session":target_id,"unlocked":true}))["error"]["code"], "invalid_args");
        let locked = call(&state, "sessions.chatAccessSet", json!({"session":"chat-source","unlocked":false}));
        assert_eq!(locked["ok"], true, "{locked}");
        assert_eq!(call(&state, "sessions.chatAccessGet", json!({"session":"chat-source"}))["data"]["unlocked"], false);
        let tools = state.registry.get("chat-source").unwrap().bridge_request("tools.list", None, Some(Duration::from_secs(10))).unwrap();
        assert!(!tools["active"].as_array().unwrap().iter().any(|name| name == "bash"), "{tools}");
        // A real, deliberately stalled writer loses its response. The host
        // must keep the disk fence even after it reaps the process.
        use std::os::unix::fs::PermissionsExt;
        let hung = temp.path().join("hung-writer");
        std::fs::write(&hung, "#!/usr/bin/python3\nimport sys,time\nsys.stdin.readline()\ntime.sleep(30)\n").unwrap();
        std::fs::set_permissions(&hung, std::fs::Permissions::from_mode(0o700)).unwrap();
        state.management_config.lock().unwrap().as_mut().unwrap().executable = hung.to_string_lossy().into_owned();
        *state.session_writer_timeout.lock().unwrap() = Duration::from_millis(200);
        let unknown = call(&state, "sessions.chatAccessSet", json!({"session":"chat-source","unlocked":true}));
        assert_eq!(unknown["error"]["code"], "outcome_unknown", "{unknown}");
        assert!(crate::session_writer_fence::assert_session_writable(&agent, "chat-source").is_err());
        let pending = call(&state, "sessions.chatAccessGet", json!({"session":"chat-source"}));
        assert_eq!(pending["data"]["pending"], true);
        assert_eq!(pending["data"]["available"], false);
        assert_eq!(call(&state, "sessions.chatAccessSet", json!({"session":"chat-source","unlocked":true}))["error"]["code"], "busy");
        assert_eq!(call(&state, "sessions.continueInProject", json!({"session":"chat-source","cwd":project}))["error"]["code"], "busy");
        let fresh = IpcHostState::new();
        *fresh.task_agent_dir.lock().unwrap() = Some(agent.clone());
        let refused = fresh.registry.with_offline_session_writer("chat-source", Duration::from_millis(10), || Ok::<_, ()>(()));
        assert!(matches!(refused, Err(session_host::SessionWriterError::Busy(_))));
        let second_file = source_dir.join("second.jsonl");
        std::fs::write(&second_file, initial.replacen("\"chat-source\"", "\"second-chat\"", 1)).unwrap();
        let unknown_copy = call(&state, "sessions.continueInProject", json!({"session":"second-chat","cwd":project}));
        assert_eq!(unknown_copy["error"]["code"], "outcome_unknown", "{unknown_copy}");
        let fence = std::fs::read(crate::session_writer_fence::fence_path(&agent, "second-chat")).unwrap();
        let record: Value = serde_json::from_slice(&fence).unwrap();
        let target_id = record["targetId"].as_str().unwrap();
        assert!(crate::session_writer_fence::assert_session_writable(&agent, target_id).is_err());
        assert!(crate::session_writer_fence::assert_session_writable(&agent, "second-chat").is_err());
        assert_eq!(call(&state, "sessions.continueInProject", json!({"session":"second-chat","cwd":project}))["error"]["code"], "busy");
        assert_eq!(std::fs::read_to_string(second_file).unwrap(), initial.replacen("\"chat-source\"", "\"second-chat\"", 1));
        state.registry.remove("chat-source", Duration::from_secs(5));
    }

    #[test]
    fn project_destination_requires_authorized_real_project_not_chat_descendant() {
        let temp = tempfile::tempdir().unwrap();
        let agent = temp.path().join("agent");
        let project = temp.path().join("project");
        let chat = agent.join("chats/one/nested");
        let legacy = agent.join("chat-workspace/nested");
        for dir in [&project, &chat, &legacy] { std::fs::create_dir_all(dir).unwrap(); }
        let mut roots = AllowedRoots::new();
        assert_eq!(project_destination(&roots, &agent, project.to_str().unwrap()).unwrap_err().0, "access_denied");
        roots.add(temp.path());
        assert_eq!(project_destination(&roots, &agent, project.to_str().unwrap()).unwrap(), project.canonicalize().unwrap());
        for dir in [&chat, &legacy] {
            assert_eq!(project_destination(&roots, &agent, dir.to_str().unwrap()).unwrap_err().0, "invalid_args");
        }
        assert!(project_destination(&roots, &agent, "relative").is_err());
        #[cfg(unix)] {
            let link = temp.path().join("chat-link");
            std::os::unix::fs::symlink(&chat, &link).unwrap();
            assert!(project_destination(&roots, &agent, link.to_str().unwrap()).is_err());
        }
    }
}
