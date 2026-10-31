//! Host-owned project directory selection: no frontend path can authorize itself.
use std::{path::{Path, PathBuf}, sync::Arc};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use crate::pi_ipc::IpcHostState;

fn accept_selection(state: &IpcHostState, selected: Option<PathBuf>) -> Result<Option<String>, String> {
    let Some(path) = selected else { return Ok(None) };
    let canonical = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !canonical.is_dir() { return Err("Selected path is not a directory".into()); }
    if crate::worktrees::is_chat_area(&path, &state.agent_dir()) || crate::worktrees::is_chat_area(&canonical, &state.agent_dir()) {
        return Err("Chat folders cannot be selected as projects".into());
    }
    std::fs::read_dir(&canonical).map_err(|e| e.to_string())?;
    state.propose_path(&canonical);
    Ok(Some(canonical.to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) async fn select_project_directory(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, Arc<IpcHostState>>,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    if window.label() != "main" { return Err("Untrusted window".into()); }
    let mut dialog = app.dialog().file().set_title("Select project folder");
    if let Some(path) = default_path.filter(|p| Path::new(p).is_absolute()) { dialog = dialog.set_directory(path); }
    let selected = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder()).await.map_err(|e| e.to_string())?;
    let selected = selected.map(|p| p.into_path().map_err(|e| e.to_string())).transpose()?;
    accept_selection(&state, selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fake_dialog_cancel_and_selection_grant_only_selected_project() {
        let tmp = tempfile::tempdir().unwrap();
        let state = IpcHostState::new();
        let project = tmp.path().join("project"); std::fs::create_dir(&project).unwrap();
        assert_eq!(accept_selection(&state, None).unwrap(), None);
        assert!(!state.file_roots.lock().unwrap().is_path_allowed(&project));
        assert_eq!(accept_selection(&state, Some(project.clone())).unwrap(), Some(project.to_string_lossy().to_string()));
        assert!(state.file_roots.lock().unwrap().is_existing_path_allowed(&project));
    }

    #[test]
    fn forged_cwd_and_chat_folder_do_not_grant_access() {
        let tmp = tempfile::tempdir().unwrap();
        let state = IpcHostState::new();
        let agent = tmp.path().join("agent");
        *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
        let project = tmp.path().join("project"); std::fs::create_dir(&project).unwrap();
        let chat = crate::session_view::chat_workspace_dir(&agent).join("20260101-120000-abcd");
        std::fs::create_dir_all(&chat).unwrap();
        let call = |op: &str, cwd: &Path| crate::pi_ipc::dispatch_envelope(&state, serde_json::json!({"v":1,"id":"test","op":op,"args":{"cwd":cwd,"selected":true}}));
        for path in [&project, &chat] {
            assert_eq!(call("cwd.validate", path)["ok"], false);
            assert_eq!(call("agent.create", path)["ok"], false);
            assert!(!state.file_roots.lock().unwrap().is_path_allowed(path));
        }
        assert!(accept_selection(&state, Some(chat)).is_err());
        accept_selection(&state, Some(project.clone())).unwrap();
        assert_eq!(call("cwd.validate", &project)["ok"], true);
    }

    #[test]
    fn persisted_session_cwd_is_discovered_before_sidebar_load() {
        let tmp = tempfile::tempdir().unwrap();
        let state = IpcHostState::new();
        let agent = tmp.path().join("agent");
        *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
        let project = tmp.path().join("existing"); std::fs::create_dir(&project).unwrap();
        let folder = agent.join("sessions").join("fixture"); std::fs::create_dir_all(&folder).unwrap();
        let header = serde_json::json!({"type":"session","version":3,"id":"fixture", "timestamp":"2026-01-01T00:00:00.000Z", "cwd":project});
        std::fs::write(folder.join("fixture.jsonl"), format!("{header}\n")).unwrap();
        let response = crate::pi_ipc::dispatch_envelope(&state, serde_json::json!({"v":1,"id":"test","op":"cwd.validate","args":{"cwd":project}}));
        assert_eq!(response["ok"], true, "{response}");
        std::fs::remove_dir(&project).unwrap();
        let state = IpcHostState::new();
        *state.task_agent_dir.lock().unwrap() = Some(agent);
        let missing = crate::pi_ipc::dispatch_envelope(&state, serde_json::json!({"v":1,"id":"test","op":"cwd.status","args":{"cwd":project}}));
        assert_eq!(missing["data"]["availability"], "missing", "{missing}");
    }

    #[cfg(unix)]
    #[test]
    fn selected_root_replaced_by_symlink_is_not_authorized() {
        let tmp = tempfile::tempdir().unwrap();
        let state = IpcHostState::new();
        let project = tmp.path().join("project"); let outside = tmp.path().join("outside");
        std::fs::create_dir(&project).unwrap(); std::fs::create_dir(&outside).unwrap();
        accept_selection(&state, Some(project.clone())).unwrap();
        std::fs::rename(&project, tmp.path().join("old")).unwrap();
        std::os::unix::fs::symlink(&outside, &project).unwrap();
        assert!(!state.file_roots.lock().unwrap().is_existing_path_allowed(&project));
        let response = crate::pi_ipc::dispatch_envelope(&state, serde_json::json!({"v":1,"id":"test","op":"cwd.validate","args":{"cwd":project}}));
        assert_eq!(response["ok"], false);
    }
}
