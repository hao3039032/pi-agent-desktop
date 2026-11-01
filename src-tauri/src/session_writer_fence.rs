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
        || value.get("operation").and_then(Value::as_str) != Some("title-rename") {
        return Err("Session writer fence owner mismatch".into());
    }
    Ok(())
}

pub(crate) fn finish_owned_title_fence(agent_dir: &Path, session_id: &str, operation_id: &str) -> Result<(), String> {
    assert_owned_title_fence(agent_dir, session_id, operation_id)?;
    finish_checked(agent_dir, session_id, operation_id, Some("title-rename"))
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

/// Remove only the operation's own valid fence after its writer has terminated
/// and its result is known. This does not recover unknown outcomes.
pub(crate) fn finish(agent_dir: &Path, session_id: &str, operation_id: &str) -> Result<(), String> {
    finish_checked(agent_dir, session_id, operation_id, None)
}

fn finish_checked(agent_dir: &Path, session_id: &str, operation_id: &str, kind: Option<&str>) -> Result<(), String> {
    let path = fence_path(agent_dir, session_id);
    let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_file() || metadata.len() > 65536 { return Err("Invalid session writer fence".into()); }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if value.get("version").and_then(Value::as_u64) != Some(1)
        || value.get("sessionId").and_then(Value::as_str) != Some(session_id)
        || value.get("operationId").and_then(Value::as_str) != Some(operation_id)
        || kind.is_some_and(|expected| value.get("operation").and_then(Value::as_str) != Some(expected)) {
        return Err("Session writer fence identity mismatch".into());
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or("Invalid fence path")?).and_then(|directory| directory.sync_all()).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(finish_owned_title_fence(root, "s", "other").is_err());
        let path = fence_path(root, "s");
        let mut record: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        record["operation"] = json!("other");
        std::fs::write(&path, record.to_string()).unwrap();
        assert!(assert_owned_title_fence(root, "s", "op").is_err());
        assert!(finish_owned_title_fence(root, "s", "op").is_err());
        assert!(path.exists());
        std::fs::write(&path, "not json").unwrap();
        assert!(assert_owned_title_fence(root, "s", "op").is_err());
        #[cfg(unix)] {
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&source, &path).unwrap();
            assert!(assert_owned_title_fence(root, "s", "op").is_err());
            assert!(finish_owned_title_fence(root, "s", "op").is_err());
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
