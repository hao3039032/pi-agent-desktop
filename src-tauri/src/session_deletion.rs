//! Safe single-file deletion. Multi-file cascades and chat-folder trash are
//! refused before any mutation until their recoverable journal is available.
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use serde_json::{json, Value};
use crate::pi_ipc::IpcHostState;

fn error(code: &str, message: impl ToString) -> (String, String) { (code.into(), message.to_string()) }

fn files_in(root: &Path, files: &mut Vec<PathBuf>) -> Result<(), (String, String)> {
    for entry in std::fs::read_dir(root).map_err(|e| error("io", e))? {
        let entry = entry.map_err(|e| error("io", e))?;
        let kind = entry.file_type().map_err(|e| error("io", e))?;
        if kind.is_symlink() {
            return Err(error("not_supported", "Cannot safely verify session references through a symbolic link."));
        }
        if kind.is_dir() { files_in(&entry.path(), files)?; }
        else if kind.is_file() && entry.path().extension().is_some_and(|s| s == "jsonl") { files.push(entry.path()); }
    }
    Ok(())
}

fn bounded_line(reader: &mut impl BufRead, max: u64) -> Result<Option<Value>, (String, String)> {
    let mut bytes = Vec::new();
    reader.take(max).read_until(b'\n', &mut bytes).map_err(|e| error("io", e))?;
    if bytes.is_empty() { return Ok(None); }
    if bytes.len() as u64 == max && !bytes.ends_with(b"\n") {
        return Err(error("not_supported", "Session reference metadata exceeds the safe scan limit."));
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| error("not_supported", "Cannot verify malformed session reference metadata."))
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) { a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()) } else { a == b }
}

/// Scheduler-owned data supplies this proof after a successful, non-corrupt load.
pub(crate) trait ScheduledReferences {
    fn is_referenced(&self, session_id: &str) -> bool;
}

pub(crate) fn delete(_state: &IpcHostState, _args: &Value) -> Result<Value, (String, String)> {
    Err(error("not_supported", "Deletion is unavailable until the scheduled-session reference index is connected."))
}

#[allow(dead_code)]
pub(crate) fn delete_with_index(state: &IpcHostState, args: &Value, scheduled: &impl ScheduledReferences) -> Result<Value, (String, String)> {
    let id = args.get("session").and_then(Value::as_str).filter(|v| !v.is_empty())
        .ok_or_else(|| error("invalid_args", "session is required"))?;
    if args.get("trashChatFolder").is_some_and(|v| !v.is_boolean()) {
        return Err(error("invalid_args", "trashChatFolder must be a boolean"));
    }
    if args.get("trashChatFolder").and_then(Value::as_bool) == Some(true) {
        return Err(error("not_supported", "Deleting a chat folder requires recoverable multi-file deletion, which is not available yet."));
    }
    let lock = state.registry.start_lock_for(id);
    let _guard = lock.lock().unwrap();
    if scheduled.is_referenced(id) {
        return Err(error("not_supported", "Session is still referenced by a scheduled run or archive."));
    }
    // Never stop a writer on the user's behalf; removal waits for a truly
    // inactive child, and prevents a stale queued message from disappearing.
    if state.registry.get(id).is_some() || state.registry.composer_outbox_for(id).has_items() {
        return Err(error("busy", "Close the session and wait for queued messages before deleting it."));
    }
    let root = state.agent_dir().join("sessions").canonicalize().map_err(|e| error("io", e))?;
    let mut files = Vec::new();
    files_in(&root, &mut files)?;
    let mut target: Option<PathBuf> = None;
    let mut references = Vec::new();
    for file in files {
        let handle = std::fs::File::open(&file).map_err(|e| error("io", e))?;
        let mut reader = std::io::BufReader::new(handle);
        let header = bounded_line(&mut reader, 64 * 1024)?.ok_or_else(|| error("not_supported", "Cannot verify an empty session file."))?;
        if header.get("type").and_then(Value::as_str) != Some("session") { return Err(error("not_supported", "Cannot verify a session header.")); }
        let child_id = header.get("id").and_then(Value::as_str).ok_or_else(|| error("not_supported", "Cannot verify a session id."))?;
        let parent = match header.get("parentSession") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(PathBuf::from(value)),
            _ => return Err(error("not_supported", "Cannot verify a parent session path.")),
        };
        // The metadata may appear anywhere in the transcript, not just after
        // the header. A malformed or oversized entry makes absence unprovable.
        let mut subagent_parent = None;
        while let Some(entry) = bounded_line(&mut reader, 16 * 1024 * 1024)? {
            if entry.get("type").and_then(Value::as_str) == Some("custom")
                && entry.get("customType").and_then(Value::as_str) == Some("pi-web:subagent")
            {
                let parent = entry.pointer("/data/parentSessionId").and_then(Value::as_str)
                    .ok_or_else(|| error("not_supported", "Cannot verify a subagent parent."))?;
                if subagent_parent.is_some() {
                    return Err(error("not_supported", "Cannot verify duplicate subagent metadata."));
                }
                subagent_parent = Some(parent.to_string());
            }
        }
        if child_id == id {
            if target.is_some() { return Err(error("not_supported", "Duplicate session ids require manual resolution.")); }
            if subagent_parent.is_some() { return Err(error("not_supported", "Subagent deletion requires the full cascade operation.")); }
            target = Some(file.clone());
        }
        references.push((child_id.to_string(), parent, subagent_parent));
    }
    let target = target.ok_or_else(|| error("not_found", "Session not found"))?;
    let canonical_target = target.canonicalize().map_err(|e| error("io", e))?;
    if !canonical_target.starts_with(&root) { return Err(error("access_denied", "Session path is outside session storage.")); }
    for (child_id, parent, subagent_parent) in references {
        if child_id == id { continue; }
        if subagent_parent.as_deref() == Some(id) { return Err(error("not_supported", "Session has subagents and requires the full cascade operation.")); }
        if let Some(parent) = parent {
            if !parent.is_absolute() { return Err(error("not_supported", "Cannot verify a relative parent session path.")); }
            if let Ok(path) = parent.canonicalize() {
                if same_path(&path, &canonical_target) { return Err(error("not_supported", "Session has child branches and requires the full cascade operation.")); }
            } else if same_path(&parent, &canonical_target) {
                return Err(error("not_supported", "Session has child branches and requires the full cascade operation."));
            }
        }
    }
    std::fs::remove_file(&canonical_target).map_err(|e| error("io", e))?;
    Ok(json!({"ok": true, "folderTrashed": false}))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixtureIndex(Vec<String>);
    impl ScheduledReferences for FixtureIndex {
        fn is_referenced(&self, id: &str) -> bool { self.0.iter().any(|entry| entry == id) }
    }
    fn delete(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
        delete_with_index(state, args, &FixtureIndex(Vec::new()))
    }

    fn fixture() -> (tempfile::TempDir, IpcHostState, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions/project");
        std::fs::create_dir_all(&root).unwrap();
        let state = IpcHostState::new();
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        (dir, state, root)
    }
    fn session(root: &Path, id: &str, parent: Option<&Path>) -> PathBuf {
        let path = root.join(format!("{id}.jsonl"));
        let header = json!({"type":"session", "version":3, "id":id, "cwd":root, "timestamp":"2026-01-01T00:00:00Z", "parentSession":parent});
        std::fs::write(&path, format!("{header}\n")).unwrap();
        path
    }
    #[test]
    fn scheduler_references_and_missing_index_fail_closed() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let args = json!({"session":"target"});
        assert_eq!(super::delete(&state, &args).unwrap_err().0, "not_supported");
        assert_eq!(delete_with_index(&state, &args, &FixtureIndex(vec!["target".into()])).unwrap_err().0, "not_supported");
        assert!(target.exists());
    }
    #[test]
    fn deletes_only_an_unreferenced_offline_file() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let sibling = session(&root, "sibling", None);
        let result = delete(&state, &json!({"session":"target"})).unwrap();
        assert_eq!(result["folderTrashed"], false);
        assert!(!target.exists());
        assert!(sibling.exists());
    }
    #[test]
    fn rejects_complex_or_queued_deletion_without_side_effects() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let child = session(&root, "child", Some(&target));
        assert_eq!(delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists() && child.exists());
        assert_eq!(delete(&state, &json!({"session":"child","trashChatFolder":true})).unwrap_err().0, "not_supported");
        assert!(child.exists());
        state.registry.composer_outbox_for("child").enqueue("queued", None).unwrap();
        assert_eq!(delete(&state, &json!({"session":"child"})).unwrap_err().0, "busy");
        assert!(child.exists());
    }
    #[test]
    fn rejects_subagent_references_and_keeps_shared_chat_folder() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-1");
        std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(chat.join("kept.txt"), "kept").unwrap();
        let target = session(&root, "target", None);
        let child = session(&root, "sub", None);
        let marker = json!({"type":"custom","customType":"pi-web:subagent","data":{"version":1,"parentSessionId":"target"}});
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().append(true).open(&child).unwrap();
        writeln!(file, "{}", json!({"type":"model_change","provider":"fixture","modelId":"fixture"})).unwrap();
        writeln!(file, "{marker}").unwrap();
        assert_eq!(delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists() && child.exists() && chat.join("kept.txt").exists());
    }
    #[test]
    fn malformed_transcript_cannot_prove_absence_of_subagents() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let other = session(&root, "other", None);
        use std::io::Write;
        writeln!(std::fs::OpenOptions::new().append(true).open(&other).unwrap(), "{{broken").unwrap();
        assert_eq!(delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists() && other.exists());
    }
    #[test]
    fn malformed_or_duplicate_metadata_never_deletes() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        std::fs::write(root.join("corrupt.jsonl"), "{broken\\n").unwrap();
        assert_eq!(delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists());
        std::fs::remove_file(root.join("corrupt.jsonl")).unwrap();
        let duplicate = root.join("duplicate.jsonl");
        std::fs::copy(&target, &duplicate).unwrap();
        assert_eq!(delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists() && duplicate.exists());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_session_layout_before_deleting() {
        let (dir, state, root) = fixture();
        let target = session(&root, "target", None);
        std::os::unix::fs::symlink(dir.path(), root.join("link")).unwrap();
        assert_eq!(delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists());
    }
}
