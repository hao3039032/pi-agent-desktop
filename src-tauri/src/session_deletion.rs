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

impl ScheduledReferences for crate::scheduled_session_index::ScheduledSessionIndex {
    fn is_referenced(&self, id: &str) -> bool { self.is_referenced(id) }
}

#[derive(Debug)]
struct DeletePreflight { path: PathBuf, file: std::fs::File, metadata: std::fs::Metadata }
#[derive(Debug)]
enum DeleteOutcome { Preflight(DeletePreflight), Deleted(Value) }

#[cfg(unix)]
fn same_file_version(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino() && left.len() == right.len()
        && left.mtime() == right.mtime() && left.mtime_nsec() == right.mtime_nsec()
}
#[cfg(not(unix))]
fn same_file_version(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    left.len() == right.len() && left.modified().ok() == right.modified().ok()
}

pub(crate) fn delete(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let _policy = state.policy_gate.try_read().map_err(|_| error("busy", "Session policy change is in progress"))?;
    let agent = state.agent_dir();
    if crate::trust_policy_fence::is_pending(&agent) {
        return Err(error("busy", "Trust policy outcome is unresolved"));
    }
    let id = args.get("session").and_then(Value::as_str).filter(|value| !value.is_empty())
        .ok_or_else(|| error("invalid_args", "session is required"))?;
    if args.get("trashChatFolder").is_some_and(|value| !value.is_boolean()) {
        return Err(error("invalid_args", "trashChatFolder must be a boolean"));
    }
    let mut preflight_proof = None;
    if state.registry.get(id).is_some() {
        // Check every disk-side refusal before closing an idle child. The
        // actual deletion repeats all checks after the child really exits.
        {
            let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(&agent)
                .map_err(|e| error("busy", format!("Scheduler transaction unavailable: {e}")))?;
            crate::session_deletion_journal::recover_pending(state, &agent)?;
            let index = crate::scheduled_session_index::ScheduledSessionIndex::load_for_deletion(&agent)
                .map_err(|e| error("io", format!("Cannot verify scheduled session references: {e}")))?;
            match delete_with_index(state, args, &index, true, None)? {
                DeleteOutcome::Preflight(proof) => preflight_proof = Some(proof),
                DeleteOutcome::Deleted(_) => return Err(error("io", "Unexpected deletion preflight result")),
            }
        }
        state.registry.with_offline_session_writer(id, std::time::Duration::from_secs(5), || Ok::<_, (String, String)>(()))
            .map_err(|failure| match failure {
                session_host::SessionWriterError::Busy(message) => error("busy", message),
                session_host::SessionWriterError::Operation(error) => error,
            })?;
    }
    let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(&agent)
        .map_err(|e| error("busy", format!("Scheduler transaction unavailable: {e}")))?;
    crate::session_deletion_journal::recover_pending(state, &agent)?;
    let index = crate::scheduled_session_index::ScheduledSessionIndex::load_for_deletion(&agent)
        .map_err(|e| error("io", format!("Cannot verify scheduled session references: {e}")))?;
    match delete_with_index(state, args, &index, false, preflight_proof.as_ref())? {
        DeleteOutcome::Deleted(result) => Ok(result),
        DeleteOutcome::Preflight(_) => Err(error("io", "Unexpected deletion result")),
    }
}


fn delete_with_index(state: &IpcHostState, args: &Value, scheduled: &impl ScheduledReferences, preflight: bool, proof: Option<&DeletePreflight>) -> Result<DeleteOutcome, (String, String)> {
    let id = args.get("session").and_then(Value::as_str).filter(|v| !v.is_empty())
        .ok_or_else(|| error("invalid_args", "session is required"))?;
    if args.get("trashChatFolder").is_some_and(|v| !v.is_boolean()) {
        return Err(error("invalid_args", "trashChatFolder must be a boolean"));
    }
    let trash_chat_folder = args.get("trashChatFolder").and_then(Value::as_bool) == Some(true);
    state.registry.with_idle_session_writers(&[id.to_string()], |_| delete_locked(state, id, scheduled, trash_chat_folder, preflight, proof))
        .map_err(|error| match error {
            session_host::SessionWriterError::Busy(message) => self::error("busy", message),
            session_host::SessionWriterError::Operation(error) => error,
        })
}

fn delete_locked(state: &IpcHostState, id: &str, scheduled: &impl ScheduledReferences, trash_chat_folder: bool, preflight: bool, proof: Option<&DeletePreflight>) -> Result<DeleteOutcome, (String, String)> {
    if scheduled.is_referenced(id) {
        return Err(error("not_supported", "Session is still referenced by a scheduled run or archive."));
    }
    // Never stop a writer on the user's behalf; removal waits for a truly
    // inactive child, and prevents a stale queued message from disappearing.
    if !preflight && state.registry.get(id).is_some() {
        return Err(error("busy", "Close the session and wait for queued messages before deleting it."));
    }
    let root = state.agent_dir().join("sessions").canonicalize().map_err(|e| error("io", e))?;
    let mut files = Vec::new();
    files_in(&root, &mut files)?;
    let mut target: Option<(PathBuf, std::fs::File, std::fs::Metadata)> = None;
    let mut target_cwd: Option<PathBuf> = None;
    let mut session_cwds = Vec::new();
    let mut references = Vec::new();
    for file in files {
        let handle = std::fs::File::open(&file).map_err(|e| error("io", e))?;
        let before = handle.metadata().map_err(|e| error("io", e))?;
        let mut reader = std::io::BufReader::new(handle);
        let header = bounded_line(&mut reader, 64 * 1024)?.ok_or_else(|| error("not_supported", "Cannot verify an empty session file."))?;
        if header.get("type").and_then(Value::as_str) != Some("session") { return Err(error("not_supported", "Cannot verify a session header.")); }
        let child_id = header.get("id").and_then(Value::as_str).ok_or_else(|| error("not_supported", "Cannot verify a session id."))?;
        let cwd = match header.get("cwd") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(PathBuf::from(value)),
            _ => return Err(error("not_supported", "Cannot verify a session working directory.")),
        };
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
        let after = reader.get_ref().metadata().map_err(|e| error("io", e))?;
        if before.len() != after.len() || before.modified().map_err(|e| error("io", e))? != after.modified().map_err(|e| error("io", e))? {
            return Err(error("busy", "Session changed while checking references"));
        }
        if child_id == id {
            if target.is_some() { return Err(error("not_supported", "Duplicate session ids require manual resolution.")); }
            target_cwd = cwd.clone();
            target = Some((file.clone(), reader.into_inner(), after));
        }
        session_cwds.push((child_id.to_string(), cwd));
        references.push((child_id.to_string(), parent, subagent_parent));
    }
    let (target, target_handle, target_metadata) = target.ok_or_else(|| error("not_found", "Session not found"))?;
    let current_metadata = target_handle.metadata().map_err(|e| error("io", e))?;
    if !same_file_version(&target_metadata, &current_metadata) {
        return Err(error("busy", "Session changed after reference scan"));
    }
    let canonical_target = target.canonicalize().map_err(|e| error("io", e))?;
    if !canonical_target.starts_with(&root) { return Err(error("access_denied", "Session path is outside session storage.")); }
    if let Some(proof) = proof {
        let original = proof.file.metadata().map_err(|e| error("io", e))?;
        if !same_path(&proof.path, &canonical_target) || !same_file_version(&proof.metadata, &original)
            || !same_file_version(&proof.metadata, &target_metadata) {
            return Err(error("busy", "Session file changed after deletion preflight"));
        }
    }
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
    if trash_chat_folder {
        if let Some(cwd) = target_cwd.filter(|cwd| crate::session_view::is_chat_folder_path(cwd, &state.agent_dir()) && cwd.exists()) {
            let shared = session_cwds.iter().any(|(session_id, other)| session_id != id && other.as_ref().is_some_and(|other| same_path(other, &cwd)));
            if !shared {
                return Err(error("not_supported", "Moving an unshared chat folder requires recoverable multi-file deletion."));
            }
        }
    }
    if preflight { return Ok(DeleteOutcome::Preflight(DeletePreflight { path: canonical_target, file: target_handle, metadata: target_metadata })); }
    crate::session_deletion_journal::remove(&root, &state.agent_dir(), id, &canonical_target, &target_metadata)?;
    Ok(DeleteOutcome::Deleted(json!({"ok": true, "folderTrashed": false})))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixtureIndex(Vec<String>);
    impl ScheduledReferences for FixtureIndex {
        fn is_referenced(&self, id: &str) -> bool { self.0.iter().any(|entry| entry == id) }
    }
    fn delete(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
        match delete_with_index(state, args, &FixtureIndex(Vec::new()), false, None)? {
            DeleteOutcome::Deleted(result) => Ok(result),
            DeleteOutcome::Preflight(_) => Err(error("io", "Unexpected test deletion result")),
        }
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
        assert_eq!(delete_with_index(&state, &args, &FixtureIndex(vec!["target".into()]), false, None).unwrap_err().0, "not_supported");
        assert!(target.exists());
    }
    #[cfg(unix)]
    #[test]
    fn idle_live_child_is_closed_only_after_preflight_and_real_exit() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let bridge = dir.path().join("bridge.mjs");
        std::fs::write(&bridge, "// fixture").unwrap();
        let script = r##"#!/usr/bin/env node
const readline = require('node:readline');
const bridge = BRIDGE_PATH;
const emit = x => process.stdout.write(JSON.stringify(x) + '\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  const reply = data => emit({type:'response',id:r.id,command:r.type,success:true,data});
  if (r.type === 'get_state') return reply({sessionId:'target',isStreaming:false,isCompacting:false,thinkingLevel:'off'});
  if (r.type === 'get_commands') return reply({commands:[{name:'pi-web:bridge',source:'extension',sourceInfo:{path:bridge}}]});
  if (r.type === 'prompt' && r.message.startsWith('/pi-web:bridge ')) {
    const [, rid, encoded] = r.message.split(' '); const payload = JSON.parse(Buffer.from(encoded,'base64url'));
    reply({disposition:'handled'});
    return emit({type:'extension_ui_request',id:'notice',method:'notify',message:'PI_WEB_BRIDGE_V1 '+JSON.stringify({sid:'target',rid,nonce:payload.nonce,ok:true,result:{}})});
  }
  if (r.type === 'prompt') { emit({type:'agent_start'}); return reply({}); }
  if (r.type === 'interrupt') { emit({type:'agent_settled'}); return reply({}); }
  reply({});
});
"##.replace("BRIDGE_PATH", &serde_json::to_string(&bridge.to_string_lossy()).unwrap());
        let executable = dir.path().join("mock-pi");
        std::fs::write(&executable, script).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = session_host::SessionSpawnConfig {
            executable: executable.to_string_lossy().into_owned(), agent_dir: Some(dir.path().to_path_buf()),
            session_dir: Some(root.clone()), bridge_asset: bridge, artifacts_asset: None, chat_asset: None,
            chat_asset_sha256: None, shape: session_host::SessionSpawnShape::Project { tool_args: None },
            initial_model: None, thinking_level: None, extra_args: Vec::new(),
        };
        let live = state.registry.start("target", &target, "target", &root, &config).unwrap();
        let runs = dir.path().join("scheduled-tasks/runs"); std::fs::create_dir_all(&runs).unwrap();
        let archive = runs.join("12345678-1234-1234-1234-123456789abc.archive.jsonl");
        std::fs::write(&archive, format!("{}\n", json!({"runId":"r","sessionId":"target"}))).unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(state.registry.get("target").is_some() && target.exists());
        std::fs::remove_file(archive).unwrap();
        let child = session(&root, "child", Some(&target));
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(state.registry.get("target").is_some() && target.exists());
        std::fs::remove_file(child).unwrap();
        live.command("prompt", json!({"message":"fixture only"}), Some(std::time::Duration::from_secs(2))).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !live.run_state().is_running() { assert!(std::time::Instant::now() < deadline); std::thread::sleep(std::time::Duration::from_millis(5)); }
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap_err().0, "busy");
        assert!(state.registry.get("target").is_some() && target.exists());
        live.command("interrupt", json!({}), Some(std::time::Duration::from_secs(2))).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while live.run_state().is_running() { assert!(std::time::Instant::now() < deadline); std::thread::sleep(std::time::Duration::from_millis(5)); }
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap()["ok"], true);
        assert!(state.registry.get("target").is_none());
        assert!(!target.exists());
        drop(live);
    }
    #[test]
    fn deletion_preflight_keeps_identity_across_replacement() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let args = json!({"session":"target"});
        let index = FixtureIndex(Vec::new());
        let proof = match delete_with_index(&state, &args, &index, true, None).unwrap() {
            DeleteOutcome::Preflight(proof) => proof,
            other => panic!("unexpected result: {other:?}"),
        };
        std::fs::rename(&target, root.join("original.saved")).unwrap();
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":root,"replacement":true}))).unwrap();
        assert_eq!(delete_with_index(&state, &args, &index, false, Some(&proof)).unwrap_err().0, "busy");
        assert!(std::fs::read_to_string(&target).unwrap().contains("replacement"));
        assert!(root.join("original.saved").exists());
    }
    #[test]
    fn deletion_preflight_refuses_post_scan_append() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let args = json!({"session":"target"});
        let index = FixtureIndex(Vec::new());
        let proof = match delete_with_index(&state, &args, &index, true, None).unwrap() {
            DeleteOutcome::Preflight(proof) => proof,
            other => panic!("unexpected result: {other:?}"),
        };
        use std::io::Write;
        writeln!(std::fs::OpenOptions::new().append(true).open(&target).unwrap(), "{}", json!({"type":"custom","customType":"new"})).unwrap();
        assert_eq!(delete_with_index(&state, &args, &index, false, Some(&proof)).unwrap_err().0, "busy");
        assert!(std::fs::read_to_string(&target).unwrap().contains("new"));
    }
    #[test]
    fn production_delete_rejects_policy_and_unresolved_writer_fences() {
        let (dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let args = json!({"session":"target"});
        let policy = state.policy_gate.try_write().unwrap();
        assert_eq!(super::delete(&state, &args).unwrap_err().0, "busy");
        drop(policy);
        let lock = state.registry.start_lock_for("target");
        let writer = lock.lock().unwrap();
        assert_eq!(super::delete(&state, &args).unwrap_err().0, "busy");
        drop(writer);
        crate::session_writer_fence::begin(dir.path(), "target", "op", "chat", &target, None).unwrap();
        assert_eq!(super::delete(&state, &args).unwrap_err().0, "busy");
        assert!(target.exists());
        crate::session_writer_fence::finish(dir.path(), "target", "op").unwrap();
        let trust = crate::trust_policy_fence::marker_path(dir.path());
        std::fs::write(&trust, "corrupt").unwrap();
        assert_eq!(super::delete(&state, &args).unwrap_err().0, "busy");
        assert!(target.exists());
    }
    #[test]
    fn production_delete_checks_the_strict_scheduled_index() {
        let (dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let runs = dir.path().join("scheduled-tasks/runs");
        std::fs::create_dir_all(&runs).unwrap();
        let id = "12345678-1234-1234-1234-123456789abc";
        let run = runs.join(format!("{id}.archive.jsonl"));
        std::fs::write(&run, format!("{}\n", json!({"runId":"run","sessionId":"target"}))).unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists());
        std::fs::write(&run, "{broken\n").unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap_err().0, "io");
        assert!(target.exists());
        std::fs::remove_file(run).unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap()["ok"], true);
        assert!(!target.exists());
    }
    #[test]
    fn production_ipc_deletes_an_unreferenced_offline_session() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let response = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"delete","op":"sessions.delete","args":{"session":"target","trashChatFolder":false}}));
        assert_eq!(response["ok"], true, "{response}");
        assert!(!target.exists());
    }
    #[test]
    fn scheduler_gate_covers_index_load_and_removal() {
        let (dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let guard = task_scheduler::transaction_lock::TransactionLock::acquire(dir.path()).unwrap();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| super::delete(&state, &json!({"session":"target"})));
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(target.exists());
            let runs = dir.path().join("scheduled-tasks/runs");
            std::fs::create_dir_all(&runs).unwrap();
            std::fs::write(runs.join("12345678-1234-1234-1234-123456789abc.archive.jsonl"), format!("{}\n", json!({"runId":"r","sessionId":"target"}))).unwrap();
            drop(guard);
            assert_eq!(worker.join().unwrap().unwrap_err().0, "not_supported");
        });
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
        let chat = state.agent_dir().join("chats/chat-1");
        std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(&child, format!("{}\n", json!({"type":"session","id":"child","cwd":chat,"parentSession":target}))).unwrap();
        assert_eq!(delete(&state, &json!({"session":"child","trashChatFolder":true})).unwrap_err().0, "not_supported");
        assert!(child.exists());
        state.registry.composer_outbox_for("child").enqueue("queued", None).unwrap();
        assert_eq!(delete(&state, &json!({"session":"child"})).unwrap_err().0, "busy");
        assert!(child.exists());
    }
    #[test]
    fn deleting_one_shared_chat_session_keeps_the_folder() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-1");
        std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(chat.join("kept.txt"), "kept").unwrap();
        let parent = root.join("parent.jsonl");
        let child = root.join("child.jsonl");
        std::fs::write(&parent, format!("{}\n", json!({"type":"session","id":"parent","cwd":chat}))).unwrap();
        std::fs::write(&child, format!("{}\n", json!({"type":"session","id":"child","cwd":chat,"parentSession":parent}))).unwrap();
        let result = super::delete(&state, &json!({"session":"child","trashChatFolder":true})).unwrap();
        assert_eq!(result["folderTrashed"], false);
        assert!(parent.exists() && chat.join("kept.txt").exists());
        assert!(!child.exists());
    }
    #[test]
    fn deletes_an_offline_leaf_subagent_without_touching_its_parent() {
        let (_dir, state, root) = fixture();
        let parent = session(&root, "parent", None);
        let child = session(&root, "sub", None);
        let marker = json!({"type":"custom","customType":"pi-web:subagent","data":{"version":1,"parentSessionId":"parent"}});
        use std::io::Write;
        writeln!(std::fs::OpenOptions::new().append(true).open(&child).unwrap(), "{marker}").unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"sub"})).unwrap()["ok"], true);
        assert!(parent.exists());
        assert!(!child.exists());
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
