//! Durable, fail-closed fence for an unresolved trust.json mutation.
//! The host checks this in addition to any other session-policy fences.
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub(crate) fn marker_path(agent_dir: &Path) -> PathBuf {
    agent_dir.join("pi-web").join("trust-policy-pending.json")
}

/// Even malformed files, links and unreadable metadata are unresolved.
pub(crate) fn is_pending(agent_dir: &Path) -> bool {
    let directory = agent_dir.join("pi-web");
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if !metadata.file_type().is_dir() => return true,
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return false,
        Err(_) => return true,
    }
    match std::fs::symlink_metadata(marker_path(agent_dir)) {
        Ok(_) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

/// Persist the operation identity before submitting any trust writer.
#[cfg(unix)]
pub(crate) fn begin(agent_dir: &Path, operation_id: &str, cwd: &Path) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    if is_pending(agent_dir) { return Err(io::Error::new(io::ErrorKind::AlreadyExists, "trust policy is already unresolved")); }
    let path = marker_path(agent_dir);
    let directory = path.parent().ok_or_else(|| io::Error::other("invalid trust fence path"))?;
    std::fs::create_dir_all(directory)?;
    if !std::fs::symlink_metadata(directory)?.file_type().is_dir() {
        return Err(io::Error::other("trust fence directory is not a directory"));
    }
    std::fs::File::open(agent_dir)?.sync_all()?;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
    let record = serde_json::json!({"version": 1, "operationId": operation_id, "cwd": cwd});
    file.write_all(record.to_string().as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    std::fs::File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn begin(_agent_dir: &Path, _operation_id: &str, _cwd: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "durable trust policy fence is unavailable on this platform"))
}

/// Clear only the exact operation, after its writer has confirmed completion.
#[cfg(unix)]
pub(crate) fn complete(agent_dir: &Path, operation_id: &str) -> io::Result<()> {
    let path = marker_path(agent_dir);
    if !std::fs::symlink_metadata(&path)?.file_type().is_file() {
        return Err(io::Error::other("trust fence is not a regular file"));
    }
    let data: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)
        .map_err(|_| io::Error::other("trust fence is malformed"))?;
    if data.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || data.get("operationId").and_then(serde_json::Value::as_str) != Some(operation_id) {
        return Err(io::Error::other("trust fence operation does not match"));
    }
    let directory = path.parent().ok_or_else(|| io::Error::other("invalid trust fence path"))?;
    std::fs::remove_file(&path)?;
    std::fs::File::open(directory)?.sync_all()
}

#[cfg(not(unix))]
pub(crate) fn complete(_agent_dir: &Path, _operation_id: &str) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "durable trust policy fence is unavailable on this platform"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn pending_survives_restart_and_only_the_matching_operation_clears_it() {
        let root = tempfile::tempdir().unwrap();
        assert!(!is_pending(root.path()));
        begin(root.path(), "operation-a", Path::new("/project")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(marker_path(root.path())).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(is_pending(root.path()));
        assert!(begin(root.path(), "operation-b", Path::new("/project")).is_err());
        assert!(complete(root.path(), "operation-b").is_err());
        assert!(is_pending(root.path()));
        complete(root.path(), "operation-a").unwrap();
        assert!(!is_pending(root.path()));
    }

    #[test]
    fn malformed_or_unreadable_marker_stays_pending() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("pi-web")).unwrap();
        std::fs::write(marker_path(root.path()), "not-json").unwrap();
        assert!(is_pending(root.path()));
        assert!(complete(root.path(), "operation-a").is_err());
        assert!(is_pending(root.path()));
    }
}
