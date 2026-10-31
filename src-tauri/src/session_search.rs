//! Full-text session search: catalogue paths are resolved by the host, never supplied by the UI.
use std::collections::HashMap;
use serde_json::{json, Value};
use crate::pi_ipc::{catalogue_info, key_of, management_call, ms_to_iso, IpcHostState};

fn session_file_within_root(file: &std::path::Path, root: &std::path::Path) -> Option<std::path::PathBuf> {
    let canonical = file.canonicalize().ok()?;
    canonical.starts_with(root).then_some(canonical)
}

pub(crate) fn search(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let query = args.get("query").and_then(Value::as_str)
        .ok_or_else(|| ("invalid_args".into(), "query is required".into()))?.trim();
    if query.encode_utf16().count() > 200 {
        return Err(("invalid_args".into(), "Search query exceeds 200 characters".into()));
    }
    if query.is_empty() { return Ok(json!({"results": [], "truncated": false})); }
    let agent_dir = state.agent_dir();
    let root = match agent_dir.join("sessions").canonicalize() {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({"results": [], "truncated": false})),
        Err(error) => return Err(("io".into(), error.to_string())),
    };
    let mut scans: Vec<_> = session_host::list_session_files(&agent_dir).iter()
        .filter_map(|file| session_file_within_root(file, &root))
        .filter_map(|file| session_host::scan_session_file_info(&file)).collect();
    scans.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    // The search engine itself enforces its 500-file cap; retain one extra to
    // report truncation rather than claiming the first 500 were exhaustive.
    let candidates: Vec<_> = scans.iter().take(501).map(|scan| json!({
        "path": scan.path.to_string_lossy(), "id": scan.id,
        "modified": ms_to_iso(scan.modified_ms), "transient": false,
    })).collect();
    let mut result = management_call(state, "session.search", json!({"query": query, "sessions": candidates}))?;
    let by_path: HashMap<_, _> = scans.iter().map(|scan| (key_of(&scan.path), scan)).collect();
    if let Some(results) = result.get_mut("results").and_then(Value::as_array_mut) {
        for hit in results {
            let Some(path) = hit.pointer("/session/path").and_then(Value::as_str) else {
                return Err(("op_failed".into(), "invalid search result".into()));
            };
            let Some(scan) = by_path.get(&key_of(std::path::Path::new(path))) else {
                return Err(("op_failed".into(), "search returned an unknown session".into()));
            };
            let parent_id = scan.parent_session_path.as_deref().and_then(|parent| by_path.get(&key_of(std::path::Path::new(parent))).map(|scan| scan.id.clone()));
            let relation = session_host::history::read_subagent_relation(&scan.path).or_else(|| {
                scan.parent_session_path.as_ref().map(|_| json!({"kind": "fork", "originSessionId": parent_id}))
            });
            hit["session"] = catalogue_info(state, &agent_dir, scan, parent_id, relation);
        }
    } else {
        return Err(("op_failed".into(), "invalid search response".into()));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::session_file_within_root;

    #[test]
    fn search_rejects_files_outside_session_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        std::fs::create_dir(&root).unwrap();
        let inside = root.join("inside.jsonl");
        let outside = dir.path().join("outside.jsonl");
        std::fs::write(&inside, "").unwrap();
        std::fs::write(&outside, "").unwrap();
        let root = root.canonicalize().unwrap();
        assert!(session_file_within_root(&inside, &root).is_some());
        assert!(session_file_within_root(&outside, &root).is_none());
        #[cfg(unix)] {
            let link = root.join("link.jsonl");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(session_file_within_root(&link, &root).is_none());
        }
    }
}
