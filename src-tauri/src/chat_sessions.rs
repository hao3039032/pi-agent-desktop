//! Host-side validation for continuing a chat in a project.
use std::path::{Path, PathBuf};
use crate::file_access::AllowedRoots;
use crate::session_view::{chat_workspace_dir, legacy_chat_workspace_dir};

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
        std::fs::write(&loose, &source).unwrap();
        let state = IpcHostState::new();
        *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable, agent_dir: Some(agent.clone()),
            extensions: vec![Path::new("../lib/pi-rpc/assets/pi-web-management.mjs").canonicalize().unwrap()],
            env: vec![("PI_WEB_MANAGED_MODULES".into(), managed.to_string_lossy().into_owned())],
        });
        assert_eq!(std::fs::read_to_string(&file).unwrap(), source, "source before management call");
        let args = json!({"file": file, "cwd": project});
        let copied = management_call(&state, "session.continueChat", args).unwrap_or_else(|error| panic!("{error:?}; source: {:?}", std::fs::read_to_string(&file)));
        let copied_file = Path::new(copied["path"].as_str().unwrap());
        assert!(copied_file.starts_with(agent.join("sessions")));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), source);
        assert!(!loose.exists());
        assert_eq!(std::fs::read_to_string(source_dir.join("legacy-layout.jsonl")).unwrap(), source);
        assert!(std::fs::read_to_string(copied_file).unwrap().contains("parentSession"));
        for unlocked in [true, false] {
            let result = management_call(&state, "session.setOfflineChatUnlock", json!({"file": file, "unlocked": unlocked})).unwrap();
            assert_eq!(result["changed"], true);
            assert_eq!(session_host::spawn_plan::read_chat_unlocked(&file), unlocked);
        }
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
