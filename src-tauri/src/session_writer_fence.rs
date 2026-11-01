//! Persistent fail-closed barriers for session-file operations with unknown outcomes.
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use serde_json::{json, Value};

pub(crate) fn fence_path(agent_dir: &Path, session_id: &str) -> PathBuf {
    let hash = Sha256::digest(session_id.as_bytes());
    let name = hash.iter().map(|b| format!("{b:02x}")).collect::<String>();
    agent_dir.join("pi-web").join("session-writer-fences").join(format!("{name}.json"))
}

/// Presence of a fence, including a corrupt or non-regular entry, refuses all writers.
pub(crate) fn assert_session_writable(agent_dir: &Path, session_id: &str) -> Result<(), String> {
    let path = fence_path(agent_dir, session_id);
    for ancestor in [agent_dir.join("pi-web"), agent_dir.join("pi-web/session-writer-fences")] {
        match std::fs::symlink_metadata(&ancestor) {
            Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {},
            Ok(_) => return Err("Session writer fence directory is not safe".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Cannot inspect session writer fence: {error}")),
        }
    }
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot inspect session writer fence: {error}")),
        Ok(_) => Err("Session has an unresolved writer outcome; do not retry".into()),
    }
}

/// Read-only classification; even resolved fences continue to block writers.
/// Unknown files and old records remain unresolved, never auto-cleaned.
pub(crate) fn diagnostic(agent_dir: &Path) -> (crate::host_lifecycle::PendingState, crate::host_lifecycle::PendingState) {
    use crate::host_lifecycle::PendingState::{Clear, Pending, Uninspectable};
    use std::io::Read;
    let directory = agent_dir.join("pi-web/session-writer-fences");
    match std::fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return (Clear, Clear),
        Err(_) => return (Uninspectable, Uninspectable),
        Ok(meta) if !meta.file_type().is_dir() => return (Uninspectable, Uninspectable),
        Ok(_) => {},
    }
    let Ok(entries) = std::fs::read_dir(&directory) else { return (Uninspectable, Uninspectable) };
    let (mut unresolved, mut cleanup) = (Clear, Clear);
    for (index, entry) in entries.enumerate() {
        if index >= 1024 { return (Uninspectable, Uninspectable); }
        let Ok(entry) = entry else { return (Uninspectable, Uninspectable) };
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { return (Uninspectable, Uninspectable) };
        if !meta.file_type().is_file() || meta.len() > 65536 { unresolved = Pending; continue; }
        let mut options = std::fs::OpenOptions::new(); options.read(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let Ok(file) = options.open(&path) else { return (Uninspectable, Uninspectable) };
        let mut bytes = Vec::new();
        if file.take(65537).read_to_end(&mut bytes).is_err() || bytes.len() > 65536 { return (Uninspectable, Uninspectable); }
        let value = serde_json::from_slice::<Value>(&bytes).ok();
        let resolved = value.as_ref().is_some_and(|value| {
            let Some(session) = value.get("sessionId").and_then(Value::as_str).filter(|v| !v.is_empty()) else { return false };
            value.get("version").and_then(Value::as_u64) == Some(1)
                && value.get("operationId").and_then(Value::as_str).is_some_and(|v| !v.is_empty())
                && value.get("operation").and_then(Value::as_str).is_some_and(|v| !v.is_empty())
                && value.get("phase").and_then(Value::as_str) == Some("resolved")
                && matches!(value.get("outcome").and_then(Value::as_str), Some("applied" | "not_applied"))
                && fence_path(agent_dir, session) == path
        });
        if resolved { cleanup = Pending; } else { unresolved = Pending; }
    }
    (unresolved, cleanup)
}

/// Only the operation which created this exact title-rename fence may pass it.
pub(crate) fn assert_owned_title_fence(agent_dir: &Path, session_id: &str, operation_id: &str) -> Result<(), String> {
    let path = fence_path(agent_dir, session_id);
    for ancestor in [agent_dir.join("pi-web"), agent_dir.join("pi-web/session-writer-fences")] {
        let metadata = std::fs::symlink_metadata(ancestor).map_err(|e| e.to_string())?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() { return Err("Unsafe session fence directory".into()); }
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_file() || metadata.len() > 65536 { return Err("Invalid session writer fence".into()); }
    let value: Value = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if value.get("version").and_then(Value::as_u64) != Some(1)
        || value.get("sessionId").and_then(Value::as_str) != Some(session_id)
        || value.get("operationId").and_then(Value::as_str) != Some(operation_id)
        || value.get("operation").and_then(Value::as_str) != Some("title-rename")
        || value.get("phase").is_some() {
        return Err("Session writer fence owner mismatch".into());
    }
    Ok(())
}

pub(crate) fn finish_owned_title_fence(agent_dir: &Path, session_id: &str, operation_id: &str, outcome: FenceOutcome) -> Result<(), String> {
    assert_owned_title_fence(agent_dir, session_id, operation_id)?;
    finish_checked(agent_dir, session_id, operation_id, Some("title-rename"), outcome, None)
}

/// A live title rename may run while the session file is being appended, or
/// before the SDK has flushed it. This bounded prefix is diagnostic only;
/// neither its presence nor its digest grants write authority.
pub(crate) fn begin_live_title(agent_dir: &Path, session_id: &str, operation_id: &str, source: &Path) -> Result<(), String> {
    use std::io::Read;
    assert_session_writable(agent_dir, session_id)?;
    let path = fence_path(agent_dir, session_id);
    let dir = path.parent().ok_or("Invalid fence path")?;
    #[cfg(unix)] {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    assert_session_writable(agent_dir, session_id)?;
    let diagnostic = std::fs::symlink_metadata(source).ok().filter(|meta| meta.file_type().is_file()).and_then(|_| {
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options.open(source).ok()?;
        if !file.metadata().ok()?.file_type().is_file() { return None; }
        let mut bytes = Vec::new();
        file.take(65536).read_to_end(&mut bytes).ok()?;
        let digest = Sha256::digest(&bytes).iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        Some(json!({"prefixBytes": bytes.len(), "prefixSha256": digest}))
    });
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|e| format!("Cannot create session writer fence: {e}"))?;
    let record = json!({"version":1,"operationId":operation_id,"sessionId":session_id,"operation":"title-rename", "source":{"path":source,"diagnosticOnly":true,"prefix":diagnostic}});
    file.write_all(record.to_string().as_bytes()).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::fs::File::open(dir).and_then(|directory| directory.sync_all()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Caller holds the session offline-writer gate. A failed or interrupted write
/// deliberately leaves a refusing fence, never a falsely clean state.
pub(crate) fn begin(agent_dir: &Path, session_id: &str, operation_id: &str, operation: &str, source: &Path, target: Option<&Path>, target_id: Option<&str>) -> Result<(), String> {
    begin_record(agent_dir, session_id, operation_id, operation, source, target, target_id, None)
}

pub(crate) fn begin_fork(agent_dir: &Path, session_id: &str, operation_id: &str, operation: &str, source: &Path, target: &Path, target_id: &str, staging: &Path) -> Result<(), String> {
    begin_record(agent_dir, session_id, operation_id, operation, source, Some(target), Some(target_id), Some(staging))
}

fn begin_record(agent_dir: &Path, session_id: &str, operation_id: &str, operation: &str, source: &Path, target: Option<&Path>, target_id: Option<&str>, staging: Option<&Path>) -> Result<(), String> {
    assert_session_writable(agent_dir, session_id)?;
    let path = fence_path(agent_dir, session_id);
    let dir = path.parent().ok_or("Invalid fence path")?;
    #[cfg(unix)] {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    assert_session_writable(agent_dir, session_id)?;
    let metadata = std::fs::metadata(source).map_err(|e| format!("Cannot identify session source: {e}"))?;
    if !metadata.is_file() { return Err("Session source is not a file".into()); }
    let mut reader = std::fs::File::open(source).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    std::io::copy(&mut reader, &mut digest).map_err(|e| e.to_string())?;
    let fingerprint = digest.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        json!({"path":source,"sha256":fingerprint,"size":metadata.len(),"device":metadata.dev(),"inode":metadata.ino()})
    };
    #[cfg(not(unix))]
    let identity = json!({"path":source,"sha256":fingerprint,"size":metadata.len()});
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|e| format!("Cannot create session writer fence: {e}"))?;
    let record = json!({"version":1,"operationId":operation_id,"sessionId":session_id,"operation":operation,"source":identity,"target":target,"targetId":target_id,"staging":staging});
    file.write_all(record.to_string().as_bytes()).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::fs::File::open(dir).and_then(|directory| directory.sync_all()).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) enum FenceOutcome { Applied, NotApplied }

/// Only a caller that has established this operation's result may resolve it.
/// Failure means fence cleanup is uncertain, not that the mutation is unknown.
pub(crate) fn finish_known(agent_dir: &Path, session_id: &str, operation_id: &str, outcome: FenceOutcome) -> Result<(), String> {
    finish_checked(agent_dir, session_id, operation_id, None, outcome, None)
}

#[cfg(test)]
pub(crate) fn finish(agent_dir: &Path, session_id: &str, operation_id: &str) -> Result<(), String> {
    finish_known(agent_dir, session_id, operation_id, FenceOutcome::Applied)
}

fn finish_checked(agent_dir: &Path, session_id: &str, operation_id: &str, kind: Option<&str>, outcome: FenceOutcome, fail_at: Option<&str>) -> Result<(), String> {
    let path = fence_path(agent_dir, session_id);
    let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_file() || metadata.len() > 65536 { return Err("Invalid session writer fence".into()); }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mut value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if value.get("version").and_then(Value::as_u64) != Some(1)
        || value.get("sessionId").and_then(Value::as_str) != Some(session_id)
        || value.get("operationId").and_then(Value::as_str) != Some(operation_id)
        || kind.is_some_and(|expected| value.get("operation").and_then(Value::as_str) != Some(expected)) {
        return Err("Session writer fence identity mismatch".into());
    }
    // A pre-existing terminal phase is not a license to replay cleanup.
    if value.get("phase").is_some() { return Err("Session writer fence is not unresolved".into()); }
    let object = value.as_object_mut().ok_or("Invalid session writer fence")?;
    object.insert("phase".into(), json!("resolved"));
    object.insert("outcome".into(), json!(match outcome { FenceOutcome::Applied => "applied", FenceOutcome::NotApplied => "not_applied" }));
    let directory = path.parent().ok_or("Invalid fence path")?;
    if fail_at == Some("before_resolved") { return Err("Injected terminal persistence failure".into()); }
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    temporary.write_all(&serde_json::to_vec(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(&path).map_err(|e| e.error.to_string())?;
    #[cfg(unix)]
    std::fs::File::open(directory).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())?;
    if fail_at == Some("resolved") { return Err("Injected cleanup failure".into()); }
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    if fail_at == Some("unlinked") { return Err("Injected fence directory sync failure".into()); }
    #[cfg(unix)]
    std::fs::File::open(directory).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolved_fence_crash_fixture() {
        let Some(root) = std::env::var_os("PI_TEST_RESOLVED_FENCE_DIR") else { return };
        let root = Path::new(&root);
        let source = root.join("source"); std::fs::write(&source, "fixture").unwrap();
        begin(root, "s", "op", "continue", &source, None, None).unwrap();
        assert!(finish_checked(root, "s", "op", None, FenceOutcome::Applied, Some("resolved")).is_err());
        std::process::exit(73);
    }

    #[test]
    fn restart_reports_durable_resolved_fence_without_clearing_it() {
        use crate::host_lifecycle::PendingState::{Clear, Pending};
        let temp = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "session_writer_fence::tests::resolved_fence_crash_fixture", "--nocapture"])
            .env("PI_TEST_RESOLVED_FENCE_DIR", temp.path()).status().unwrap();
        assert_eq!(status.code(), Some(73));
        assert_eq!(diagnostic(temp.path()), (Clear, Pending));
        assert!(assert_session_writable(temp.path(), "s").is_err());
        assert!(fence_path(temp.path(), "s").exists());
    }

    #[test]
    fn terminal_phase_survives_cleanup_failure_and_never_authorizes_writes() {
        use crate::host_lifecycle::PendingState::{Clear, Pending};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let source = root.join("source"); std::fs::write(&source, "fixture").unwrap();
        begin(root, "s", "op", "continue", &source, None, None).unwrap();
        assert!(finish_checked(root, "s", "op", None, FenceOutcome::Applied, Some("resolved")).is_err());
        let record: Value = serde_json::from_slice(&std::fs::read(fence_path(root, "s")).unwrap()).unwrap();
        assert_eq!(record["phase"], "resolved"); assert_eq!(record["outcome"], "applied");
        assert_eq!(diagnostic(root), (Clear, Pending));
        assert!(assert_session_writable(root, "s").is_err());
        assert!(finish_known(root, "s", "op", FenceOutcome::Applied).is_err());
    }

    #[test]
    fn diagnostic_separates_mixed_unresolved_and_known_cleanup() {
        use crate::host_lifecycle::PendingState::Pending;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path(); let source = root.join("source"); std::fs::write(&source, "fixture").unwrap();
        begin(root, "s1", "op1", "continue", &source, None, None).unwrap();
        begin(root, "s2", "op2", "continue", &source, None, None).unwrap();
        assert!(finish_checked(root, "s1", "op1", None, FenceOutcome::Applied, Some("resolved")).is_err());
        assert_eq!(diagnostic(root), (Pending, Pending));
        assert!(assert_session_writable(root, "s1").is_err());
        assert!(assert_session_writable(root, "s2").is_err());
    }

    #[test]
    fn verified_prewrite_refusal_records_not_applied_without_authorizing_owner() {
        use crate::host_lifecycle::PendingState::{Clear, Pending};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        begin_live_title(root, "s", "op", &root.join("unflushed")).unwrap();
        assert!(finish_checked(root, "s", "op", Some("title-rename"), FenceOutcome::NotApplied, Some("resolved")).is_err());
        let record: Value = serde_json::from_slice(&std::fs::read(fence_path(root, "s")).unwrap()).unwrap();
        assert_eq!(record["outcome"], "not_applied");
        assert_eq!(diagnostic(root), (Clear, Pending));
        assert!(assert_owned_title_fence(root, "s", "op").is_err());
        assert!(assert_session_writable(root, "s").is_err());
    }

    #[test]
    fn unlink_sync_failure_is_cleanup_uncertainty_after_known_terminal() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let source = root.join("source"); std::fs::write(&source, "fixture").unwrap();
        begin(root, "s", "op", "continue", &source, None, None).unwrap();
        assert!(finish_checked(root, "s", "op", None, FenceOutcome::Applied, Some("unlinked")).is_err());
        assert!(assert_session_writable(root, "s").is_ok());
        assert!(!fence_path(root, "s").exists());
    }

    #[test]
    fn failed_identity_check_preserves_unresolved_evidence() {
        use crate::host_lifecycle::PendingState::{Clear, Pending};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path(); let source = root.join("source"); std::fs::write(&source, "fixture").unwrap();
        begin(root, "s", "op", "continue", &source, None, None).unwrap();
        assert!(finish_known(root, "s", "wrong", FenceOutcome::Applied).is_err());
        assert!(finish_checked(root, "s", "op", None, FenceOutcome::Applied, Some("before_resolved")).is_err());
        assert_eq!(diagnostic(root), (Pending, Clear));
        let record: Value = serde_json::from_slice(&std::fs::read(fence_path(root, "s")).unwrap()).unwrap();
        assert!(record.get("phase").is_none());
    }

    #[test]
    fn live_title_fence_allows_unflushed_source_and_bounds_diagnostics() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let source = root.join("not-flushed.jsonl");
        begin_live_title(root, "s", "one", &source).unwrap();
        let path = fence_path(root, "s");
        let record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(record["source"]["diagnosticOnly"], true);
        assert!(record["source"]["prefix"].is_null());
        finish_owned_title_fence(root, "s", "one", FenceOutcome::Applied).unwrap();
        std::fs::write(&source, vec![b'x'; 200_000]).unwrap();
        begin_live_title(root, "s", "two", &source).unwrap();
        let record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(record["source"]["prefix"]["prefixBytes"], 65536);
        finish_owned_title_fence(root, "s", "two", FenceOutcome::Applied).unwrap();
    }

    #[test]
    fn title_fence_requires_exact_owner_and_kind() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let source = root.join("source.jsonl");
        std::fs::write(&source, "fixture").unwrap();
        assert!(assert_owned_title_fence(root, "s", "op").is_err());
        begin(root, "s", "op", "title-rename", &source, None, None).unwrap();
        assert!(assert_session_writable(root, "s").is_err());
        assert!(assert_owned_title_fence(root, "s", "op").is_ok());
        assert!(assert_owned_title_fence(root, "s", "other").is_err());
        assert!(assert_owned_title_fence(root, "other", "op").is_err());
        assert!(finish_owned_title_fence(root, "s", "other", FenceOutcome::Applied).is_err());
        let path = fence_path(root, "s");
        let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        record["operation"] = json!("other");
        std::fs::write(&path, record.to_string()).unwrap();
        assert!(assert_owned_title_fence(root, "s", "op").is_err());
        assert!(finish_owned_title_fence(root, "s", "op", FenceOutcome::Applied).is_err());
        assert!(path.exists());
        std::fs::write(&path, "not json").unwrap();
        assert!(assert_owned_title_fence(root, "s", "op").is_err());
        #[cfg(unix)] {
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&source, &path).unwrap();
            assert!(assert_owned_title_fence(root, "s", "op").is_err());
            assert!(finish_owned_title_fence(root, "s", "op", FenceOutcome::Applied).is_err());
        }
    }

    #[test]
    fn unresolved_or_corrupt_fence_survives_new_host_and_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let agent = temp.path();
        let file = fence_path(agent, "session");
        assert!(assert_session_writable(agent, "session").is_ok());
        let source = agent.join("source.jsonl");
        std::fs::write(&source, "fixture").unwrap();
        begin(agent, "session", "op-1", "continue", &source, Some(Path::new("/project")), Some("target")).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(file.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(begin(agent, "session", "op-2", "continue", &source, None, None).is_err());
        assert!(finish(agent, "session", "op-2").is_err());
        assert!(assert_session_writable(agent, "session").is_err());
        finish(agent, "session", "op-1").unwrap();
        std::fs::write(&file, b"damaged").unwrap();
        assert!(assert_session_writable(agent, "session").is_err());
        assert!(assert_session_writable(agent, "other").is_ok());
        assert!(assert_session_writable(&PathBuf::from(agent), "session").is_err());
        for _ in 0..2 {
            let host = crate::pi_ipc::IpcHostState::new();
            *host.task_agent_dir.lock().unwrap() = Some(agent.to_path_buf());
            let result = host.registry.with_offline_session_writer("session", std::time::Duration::from_millis(1), || Ok::<_, ()>(()));
            assert!(matches!(result, Err(session_host::SessionWriterError::Busy(_))));
        }
    }
}
