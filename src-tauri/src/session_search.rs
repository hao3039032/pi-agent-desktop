//! Full-text session search over private, bounded host snapshots.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use serde_json::{json, Value};
use crate::pi_ipc::{catalogue_info, key_of, management_call, ms_to_iso, IpcHostState};

const MAX_CANDIDATES: usize = 501;
const MAX_SCAN_FILES: usize = 512;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;
const SNAPSHOT_BUDGET: std::time::Duration = std::time::Duration::from_secs(3);

type Failure = (String, String);
fn io(error: impl ToString) -> Failure { ("io".into(), error.to_string()) }

fn check_empty_query(state: &IpcHostState) -> Result<(), Failure> {
    let _policy = state.policy_gate.try_read().map_err(|_| ("busy".into(), "Session policy change is in progress".into()))?;
    let agent = state.agent_dir();
    if crate::trust_policy_fence::is_pending(&agent) { return Err(("busy".into(), "Trust policy outcome is unresolved".into())); }
    let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(&agent)
        .map_err(|e| ("busy".into(), format!("Scheduler transaction unavailable: {e}")))?;
    crate::session_deletion_journal::recover_pending(state, &agent)
}

#[cfg(target_os = "linux")]
fn open_beneath(root: &Path, path: &Path) -> Result<std::fs::File, Failure> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let relative = path.strip_prefix(root).map_err(io)?;
    let mut parts = relative.components().peekable();
    let mut parent = std::fs::File::open(root).map_err(io)?;
    while let Some(part) = parts.next() {
        let std::path::Component::Normal(name) = part else { return Err(io("invalid session path")); };
        let name = name.to_str().ok_or_else(|| io("invalid session path encoding"))?;
        if parts.peek().is_some() {
            parent = crate::file_access::openat_directory_no_follow(&parent, name).map_err(io)?;
        } else {
            let name = std::ffi::CString::new(name).map_err(io)?;
            let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK) };
            if fd < 0 { return Err(io(std::io::Error::last_os_error())); }
            let file = unsafe { std::fs::File::from_raw_fd(fd) };
            if !file.metadata().map_err(io)?.is_file() { return Err(io("session is not a regular file")); }
            return Ok(file);
        }
    }
    Err(io("invalid session path"))
}

#[cfg(target_os = "linux")]
fn collect_search_files(root: &Path, start: std::time::Instant) -> Result<Vec<PathBuf>, Failure> {
    use std::os::fd::AsRawFd;
    let mut pending = vec![(root.to_path_buf(), std::fs::File::open(root).map_err(io)?)];
    let mut files = Vec::new();
    let mut directories = 0usize;
    while let Some((dir, handle)) = pending.pop() {
        directories += 1;
        if directories > 2048 { return Err(io("Session search scan exceeds its 2048-directory budget")); }
        for entry in std::fs::read_dir(format!("/proc/self/fd/{}", handle.as_raw_fd())).map_err(io)? {
            if start.elapsed() > SNAPSHOT_BUDGET { return Err(io("Session search snapshot exceeded its time budget")); }
            let entry = entry.map_err(io)?;
            let kind = entry.file_type().map_err(io)?;
            if kind.is_symlink() { return Err(io("Session search refuses symbolic links")); }
            let path = dir.join(entry.file_name());
            if kind.is_dir() {
                let name = entry.file_name();
                let name = name.to_str().ok_or_else(|| io("invalid session directory encoding"))?;
                if pending.len() >= 512 { return Err(io("Session search exceeds its open-directory budget")); }
                pending.push((path, crate::file_access::openat_directory_no_follow(&handle, name).map_err(io)?));
            }
            else if kind.is_file() && path.extension().is_some_and(|extension| extension == "jsonl") {
                files.push(path);
                if files.len() > MAX_SCAN_FILES { return Err(io("Session search scan exceeds its 512-file budget")); }
            }
        }
    }
    Ok(files)
}

#[cfg(target_os = "linux")]
struct SearchSnapshot {
    _directory: tempfile::TempDir,
    candidates: Vec<Value>,
    by_snapshot: HashMap<String, (session_host::history::ScannedSession, Option<String>, Option<Value>)>,
    truncated: bool,
}

#[cfg(target_os = "linux")]
fn snapshot(state: &IpcHostState) -> Result<SearchSnapshot, Failure> {
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;
    let start = std::time::Instant::now();
    let _policy = state.policy_gate.try_read().map_err(|_| ("busy".into(), "Session policy change is in progress".into()))?;
    let agent = state.agent_dir();
    if crate::trust_policy_fence::is_pending(&agent) {
        return Err(("busy".into(), "Trust policy outcome is unresolved".into()));
    }
    let directory = tempfile::Builder::new().prefix("pi-session-search-").tempdir().map_err(io)?;
    let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(&agent)
        .map_err(|e| ("busy".into(), format!("Scheduler transaction unavailable: {e}")))?;
    crate::session_deletion_journal::recover_pending(state, &agent)?;
    let root = match agent.join("sessions").canonicalize() {
        Ok(root) => root,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SearchSnapshot { _directory: directory, candidates: Vec::new(), by_snapshot: HashMap::new(), truncated: false });
        }
        Err(e) => return Err(io(e)),
    };
    let files = collect_search_files(&root, start)?;
    let mut scans = Vec::new();
    let mut scanned_bytes = 0u64;
    for file in files {
        if start.elapsed() > SNAPSHOT_BUDGET { return Err(io("Session search snapshot exceeded its time budget")); }
        if !file.starts_with(&root) { return Err(io("Session search path is outside session storage")); }
        let handle = open_beneath(&root, &file)?;
        let before = handle.metadata().map_err(io)?;
        if before.len() > MAX_FILE_BYTES { return Err(io("Session search file exceeds its 16 MiB snapshot budget")); }
        scanned_bytes = scanned_bytes.saturating_add(before.len());
        if scanned_bytes > MAX_SNAPSHOT_BYTES { return Err(io("Session search scan exceeds its 64 MiB budget")); }
        let descriptor = PathBuf::from(format!("/proc/self/fd/{}", handle.as_raw_fd()));
        let Some(mut scan) = session_host::scan_session_file_info(&descriptor) else { continue };
        let relation = session_host::history::read_subagent_relation(&descriptor);
        let after = handle.metadata().map_err(io)?;
        if before.dev() != after.dev() || before.ino() != after.ino() || before.len() != after.len()
            || before.mtime() != after.mtime() || before.mtime_nsec() != after.mtime_nsec() {
            return Err(("busy".into(), "Session changed during search snapshot".into()));
        }
        scan.path = file;
        scans.push((scan, relation, handle, before));
    }
    scans.sort_by(|a, b| b.0.modified_ms.cmp(&a.0.modified_ms));
    let session_ids: Vec<_> = scans.iter().map(|(scan, _, _, _)| scan.id.clone()).collect();
    state.registry.with_session_snapshot_gates(&session_ids, || {
    let ids: HashMap<_, _> = scans.iter().map(|(scan, _, _, _)| (key_of(&scan.path), scan.id.clone())).collect();
    let mut candidates = Vec::new();
    let mut by_snapshot = HashMap::new();
    let mut used = 0u64;
    let mut truncated = scans.len() > MAX_CANDIDATES;
    for (scan, relation, mut handle, before) in scans.into_iter().take(MAX_CANDIDATES) {
        if start.elapsed() > SNAPSHOT_BUDGET { return Err(io("Session search snapshot exceeded its time budget")); }
        if used.saturating_add(before.len()) > MAX_SNAPSHOT_BYTES { truncated = true; break; }
        let snapshot = directory.path().join(format!("{}.jsonl", candidates.len()));
        let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(&snapshot).map_err(io)?;
        handle.seek(SeekFrom::Start(0)).map_err(io)?;
        let copied = std::io::copy(&mut (&mut handle).take(before.len() + 1), &mut output).map_err(io)?;
        output.flush().map_err(io)?;
        if start.elapsed() > SNAPSHOT_BUDGET { return Err(io("Session search snapshot exceeded its time budget")); }
        let after = handle.metadata().map_err(io)?;
        if copied != before.len() || before.dev() != after.dev() || before.ino() != after.ino()
            || before.len() != after.len() || before.mtime() != after.mtime() || before.mtime_nsec() != after.mtime_nsec() {
            return Err(("busy".into(), "Session changed during search snapshot".into()));
        }
        used += copied;
        let parent_id = scan.parent_session_path.as_deref().and_then(|p| ids.get(&key_of(Path::new(p))).cloned());
        let relation = relation.or_else(|| scan.parent_session_path.as_ref().map(|_| json!({"kind":"fork","originSessionId":parent_id})));
        candidates.push(json!({"path":snapshot.to_string_lossy(),"id":scan.id,"modified":ms_to_iso(scan.modified_ms),"transient":false}));
        by_snapshot.insert(key_of(&snapshot), (scan, parent_id, relation));
    }
    Ok(SearchSnapshot { _directory: directory, candidates, by_snapshot, truncated })
    }).map_err(|error| match error {
        session_host::SessionWriterError::Busy(message) => ("busy".into(), message.into()),
        session_host::SessionWriterError::Operation(error) => error,
    })
}

#[cfg(target_os = "linux")]
pub(crate) fn search(state: &IpcHostState, args: &Value) -> Result<Value, Failure> {
    search_with_management(state, args, |args| management_call(state, "session.search", args))
}

#[cfg(target_os = "linux")]
fn search_with_management(state: &IpcHostState, args: &Value, call: impl FnOnce(Value) -> Result<Value, Failure>) -> Result<Value, Failure> {
    let query = args.get("query").and_then(Value::as_str).ok_or_else(|| ("invalid_args".into(), "query is required".into()))?.trim();
    if query.encode_utf16().count() > 200 { return Err(("invalid_args".into(), "Search query exceeds 200 characters".into())); }
    if query.is_empty() { check_empty_query(state)?; return Ok(json!({"results": [], "truncated": false})); }
    let agent = state.agent_dir();
    let snapshot = snapshot(state)?;
    let mut result = call(json!({"query":query,"sessions":snapshot.candidates}))?;
    if snapshot.truncated { result["truncated"] = json!(true); }
    let results = result.get_mut("results").and_then(Value::as_array_mut).ok_or_else(|| ("op_failed".into(), "invalid search response".into()))?;
    for hit in results {
        let path = hit.pointer("/session/path").and_then(Value::as_str).ok_or_else(|| ("op_failed".into(), "invalid search result".into()))?;
        let (scan, parent, relation) = snapshot.by_snapshot.get(&key_of(Path::new(path))).ok_or_else(|| ("op_failed".into(), "search returned an unknown snapshot".into()))?;
        hit["session"] = catalogue_info(state, &agent, scan, parent.clone(), relation.clone());
    }
    Ok(result)
}

#[cfg(not(target_os = "linux"))]
fn session_file_within_root(file: &Path, root: &Path) -> Option<PathBuf> {
    let canonical = file.canonicalize().ok()?;
    canonical.starts_with(root).then_some(canonical)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn search(state: &IpcHostState, args: &Value) -> Result<Value, Failure> {
    let query = args.get("query").and_then(Value::as_str).ok_or_else(|| ("invalid_args".into(), "query is required".into()))?.trim();
    if query.encode_utf16().count() > 200 { return Err(("invalid_args".into(), "Search query exceeds 200 characters".into())); }
    if query.is_empty() { check_empty_query(state)?; return Ok(json!({"results": [], "truncated": false})); }
    let _policy = state.policy_gate.try_read().map_err(|_| ("busy".into(), "Session policy change is in progress".into()))?;
    let agent = state.agent_dir();
    if crate::trust_policy_fence::is_pending(&agent) { return Err(("busy".into(), "Trust policy outcome is unresolved".into())); }
    let transaction = task_scheduler::transaction_lock::TransactionLock::acquire(&agent)
        .map_err(|e| ("busy".into(), format!("Scheduler transaction unavailable: {e}")))?;
    crate::session_deletion_journal::recover_pending(state, &agent)?;
    let root = match agent.join("sessions").canonicalize() {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({"results": [], "truncated": false})),
        Err(error) => return Err(io(error)),
    };
    drop(transaction);
    drop(_policy);
    let mut scans: Vec<_> = session_host::list_session_files(&agent).iter()
        .filter_map(|file| session_file_within_root(file, &root))
        .filter_map(|file| session_host::scan_session_file_info(&file)).collect();
    scans.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    let candidates: Vec<_> = scans.iter().take(501).map(|scan| json!({"path":scan.path.to_string_lossy(),"id":scan.id,"modified":ms_to_iso(scan.modified_ms),"transient":false})).collect();
    let mut result = management_call(state, "session.search", json!({"query":query,"sessions":candidates}))?;
    let by_path: HashMap<_, _> = scans.iter().map(|scan| (key_of(&scan.path), scan)).collect();
    let results = result.get_mut("results").and_then(Value::as_array_mut).ok_or_else(|| ("op_failed".into(), "invalid search response".into()))?;
    for hit in results {
        let path = hit.pointer("/session/path").and_then(Value::as_str).ok_or_else(|| ("op_failed".into(), "invalid search result".into()))?;
        let scan = by_path.get(&key_of(Path::new(path))).ok_or_else(|| ("op_failed".into(), "search returned an unknown session".into()))?;
        let parent = scan.parent_session_path.as_deref().and_then(|p| by_path.get(&key_of(Path::new(p))).map(|s| s.id.clone()));
        let relation = session_host::history::read_subagent_relation(&scan.path).or_else(|| scan.parent_session_path.as_ref().map(|_| json!({"kind":"fork","originSessionId":parent})));
        hit["session"] = catalogue_info(state, &agent, scan, parent, relation);
    }
    Ok(result)
}

#[cfg(all(test, not(target_os = "linux")))]
mod platform_tests {
    use super::*;
    #[test]
    fn search_rejects_files_outside_session_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions"); std::fs::create_dir(&root).unwrap();
        let inside = root.join("inside.jsonl"); let outside = dir.path().join("outside.jsonl");
        std::fs::write(&inside, "").unwrap(); std::fs::write(&outside, "").unwrap();
        let root = root.canonicalize().unwrap();
        assert!(session_file_within_root(&inside, &root).is_some());
        assert!(session_file_within_root(&outside, &root).is_none());
        #[cfg(unix)] {
            let link = root.join("link.jsonl"); std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(session_file_within_root(&link, &root).is_none());
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    #[test]
    fn search_rejects_files_outside_session_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions"); std::fs::create_dir(&root).unwrap();
        let inside = root.join("inside.jsonl"); let outside = dir.path().join("outside.jsonl");
        std::fs::write(&inside, "inside").unwrap(); std::fs::write(&outside, "outside").unwrap();
        assert!(open_beneath(&root, &inside).is_ok());
        assert!(open_beneath(&root, &outside).is_err());
        let link = root.join("link.jsonl"); std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(open_beneath(&root, &link).is_err());
    }
    #[test]
    fn management_reads_snapshot_and_returns_original_identity_and_cleans_up_on_error() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions/p"); std::fs::create_dir_all(&root).unwrap();
        let file = root.join("a.jsonl");
        let header = "{\"type\":\"session\",\"id\":\"a\",\"cwd\":\"/tmp\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"needle\"}}\n";
        std::fs::write(&file, header).unwrap();
        let state = IpcHostState::new(); *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let saved = std::cell::RefCell::new(PathBuf::new());
        let result = search_with_management(&state, &json!({"query":"needle"}), |request| {
            let session = request["sessions"][0].clone();
            let path = PathBuf::from(session["path"].as_str().unwrap());
            *saved.borrow_mut() = path.clone();
            std::fs::rename(&file, root.join("old")).unwrap();
            std::fs::write(&file, "replacement").unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), header);
            let module = Path::new(env!("CARGO_MANIFEST_DIR")).join("../lib/session-search.ts");
            let script = "import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1]).href); const a=JSON.parse(process.argv[2]); console.log(JSON.stringify(await m.searchSessionContents(a.sessions,a.query)));";
            let output = std::process::Command::new("node").args(["--experimental-strip-types", "--input-type=module", "-e", script])
                .arg(module).arg(request.to_string())
                .env_remove("PI_PACKAGE_DIR").env_remove("PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT").env_remove("JITI_ALIAS")
                .output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            Ok(serde_json::from_slice(&output.stdout).unwrap())
        }).unwrap();
        assert_eq!(result["results"][0]["session"]["path"], file.to_string_lossy().as_ref());
        assert!(!saved.borrow().exists());
        std::fs::write(&file, header).unwrap();
        let error = search_with_management(&state, &json!({"query":"needle"}), |request| {
            *saved.borrow_mut() = PathBuf::from(request["sessions"][0]["path"].as_str().unwrap());
            Err(("timeout".into(), "unknown".into()))
        }).unwrap_err();
        assert_eq!(error.0, "timeout");
        assert!(!saved.borrow().exists());
    }
    #[test]
    fn snapshot_rejects_policy_and_unresolved_session_fences() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions/p"); std::fs::create_dir_all(&root).unwrap();
        let file = root.join("a.jsonl");
        std::fs::write(&file, "{\"type\":\"session\",\"id\":\"a\",\"cwd\":\"/tmp\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n").unwrap();
        let state = IpcHostState::new(); *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let policy = state.policy_gate.try_write().unwrap();
        assert_eq!(snapshot(&state).err().unwrap().0, "busy");
        drop(policy);
        crate::session_writer_fence::begin(dir.path(), "a", "op", "chat", &file, None).unwrap();
        assert_eq!(snapshot(&state).err().unwrap().0, "busy");
        for op in ["sessions.index", "sessions.list"] {
            let response = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"test","op":op,"args":{}}));
            assert_eq!(response["error"]["code"], "busy", "{op}: {response}");
        }
        crate::session_writer_fence::finish(dir.path(), "a", "op").unwrap();
        assert!(snapshot(&state).is_ok());
    }
    #[test]
    fn snapshot_limits_are_explicit_and_candidate_cap_sets_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions/p"); std::fs::create_dir_all(&root).unwrap();
        let state = IpcHostState::new(); *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let large = root.join("large.jsonl");
        std::fs::File::create(&large).unwrap().set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(snapshot(&state).err().unwrap().1.contains("16 MiB"));
        std::fs::remove_file(large).unwrap();
        for i in 0..502 {
            std::fs::write(root.join(format!("{i}.jsonl")), format!("{{\"type\":\"session\",\"id\":\"{i}\",\"cwd\":\"/tmp\",\"timestamp\":\"2026-01-01T00:00:00Z\"}}\n")).unwrap();
        }
        let snapshot = snapshot(&state).unwrap();
        assert!(snapshot.truncated);
        assert_eq!(snapshot.candidates.len(), 501);
    }
    #[test]
    fn snapshot_pins_content_and_removes_private_files_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions/p"); std::fs::create_dir_all(&root).unwrap();
        let file = root.join("a.jsonl");
        std::fs::write(&file, "{\"type\":\"session\",\"id\":\"a\",\"cwd\":\"/tmp\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n").unwrap();
        let state = IpcHostState::new(); *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let snapshot = snapshot(&state).unwrap();
        let path = PathBuf::from(snapshot.candidates[0]["path"].as_str().unwrap());
        std::fs::rename(&file, root.join("moved")).unwrap();
        std::fs::write(&file, "different").unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"id\":\"a\""));
        drop(snapshot);
        assert!(!path.exists());
    }
}
