use crate::file_access::AllowedRoots;
use serde_json::{json, Value};
use std::path::{Component, Path};

/// Read-only status; authorization precedes probing and never grants a root.
pub(crate) fn status(roots: &AllowedRoots, cwd: &str) -> Result<Value, (&'static str, &'static str)> {
    let path = Path::new(cwd.trim());
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir)) {
        return Err(("invalid_args", "An absolute cwd without parent traversal is required"));
    }
    if !roots.is_path_allowed(path) { return Err(("unauthorized_scope", "Access denied")); }
    let availability = match std::fs::metadata(path) {
        Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => "missing",
        Err(_) => "unreadable",
        Ok(meta) => {
            if !roots.is_existing_path_allowed(path) { return Err(("unauthorized_scope", "Access denied")); }
            if !meta.is_dir() { "not-directory" }
            else if std::fs::read_dir(path).is_err() { "unreadable" }
            else { "available" }
        }
    };
    Ok(json!({ "cwd": path.to_string_lossy(), "availability": availability }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn status_only_probes_known_roots_and_grants_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let mut roots = AllowedRoots::new(); roots.add(&root);
        assert_eq!(status(&roots, root.to_str().unwrap()).unwrap()["availability"], "available");
        assert_eq!(status(&roots, root.join("missing").to_str().unwrap()).unwrap()["availability"], "missing");
        assert!(status(&roots, tmp.path().join("other").to_str().unwrap()).is_err());
        assert!(status(&roots, root.join("../other").to_str().unwrap()).is_err());
        std::fs::write(root.join("file"), b"fixture").unwrap();
        assert_eq!(status(&roots, root.join("file").to_str().unwrap()).unwrap()["availability"], "not-directory");
        #[cfg(unix)] {
            std::os::unix::fs::symlink(tmp.path(), root.join("escape")).unwrap();
            assert!(status(&roots, root.join("escape").to_str().unwrap()).is_err());
        }
    }
}
