//! Full-text session search over private, bounded host snapshots.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use serde_json::{json, Value};
use crate::pi_ipc::{catalogue_info, key_of, management_call, ms_to_iso, IpcHostState};

const MAX_CANDIDATES: usize = 501;
const MAX_PINNED_FILES: usize = 32;
const MAX_SCAN_ENTRIES: usize = 100_000;
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
#[derive(Debug)]
enum OpenFailure { Unsafe(String), Unavailable }

#[cfg(target_os = "linux")]
fn open_failure(error: std::io::Error) -> OpenFailure {
    match error.raw_os_error() {
        Some(libc::ELOOP | libc::ENOTDIR) => OpenFailure::Unsafe(error.to_string()),
        _ => OpenFailure::Unavailable,
    }
}

#[cfg(target_os = "linux")]
fn open_root(root: &Path) -> Result<std::fs::File, Failure> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(root).map_err(|error| ("access_denied".into(), format!("Cannot open session storage safely: {error}")))
}

/// A skipped or unreadable source cannot identify a pending writer by id.
/// Refuse an unresolved fence rather than disguising it as a partial search.
#[cfg(target_os = "linux")]
fn ensure_no_pending_writer_fences(agent: &Path) -> Result<(), Failure> {
    use std::os::fd::AsRawFd;
    let parent = agent.join("pi-web");
    match std::fs::symlink_metadata(&parent) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(("busy".into(), format!("Cannot verify session writer fences: {error}"))),
        Ok(metadata) if !metadata.file_type().is_dir() => return Err(("busy".into(), "Unsafe session writer fence directory".into())),
        Ok(_) => {},
    }
    let parent = open_root(&parent)?;
    let directory = match crate::file_access::openat_directory_no_follow(&parent, "session-writer-fences") {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(("busy".into(), format!("Cannot verify session writer fences: {error}"))),
    };
    let mut entries = std::fs::read_dir(format!("/proc/self/fd/{}", directory.as_raw_fd()))
        .map_err(|error| ("busy".into(), format!("Cannot verify session writer fences: {error}")))?;
    match entries.next() {
        None => Ok(()),
        Some(Ok(_)) => Err(("busy".into(), "An unresolved session writer prevents a complete search".into())),
        Some(Err(error)) => Err(("busy".into(), format!("Cannot verify session writer fences: {error}"))),
    }
}

#[cfg(target_os = "linux")]
fn open_beneath(root: &Path, path: &Path) -> Result<std::fs::File, OpenFailure> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let relative = path.strip_prefix(root).map_err(|_| OpenFailure::Unsafe("Session path is outside session storage".into()))?;
    let mut parts = relative.components().peekable();
    let mut parent = open_root(root).map_err(|error| OpenFailure::Unsafe(error.1))?;
    while let Some(part) = parts.next() {
        let std::path::Component::Normal(name) = part else { return Err(OpenFailure::Unsafe("Invalid session path".into())); };
        let name = name.to_str().ok_or_else(|| OpenFailure::Unsafe("Invalid session path encoding".into()))?;
        if parts.peek().is_some() {
            parent = crate::file_access::openat_directory_no_follow(&parent, name).map_err(open_failure)?;
        } else {
            let name = std::ffi::CString::new(name).map_err(|error| OpenFailure::Unsafe(error.to_string()))?;
            let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK) };
            if fd < 0 { return Err(open_failure(std::io::Error::last_os_error())); }
            let file = unsafe { std::fs::File::from_raw_fd(fd) };
            if !file.metadata().map_err(open_failure)?.is_file() { return Err(OpenFailure::Unsafe("Session is not a regular file".into())); }
            return Ok(file);
        }
    }
    Err(OpenFailure::Unsafe("Invalid session path".into()))
}

#[cfg(target_os = "linux")]
#[derive(Debug, Eq, PartialEq, Ord, PartialOrd)]
struct SearchCandidate { modified: i64, modified_nsec: i64, path: PathBuf, device: u64, inode: u64 }

/// Keep only the newest bounded set while walking. An interrupted or partially
/// unreadable walk is explicitly incomplete; symlinks remain security errors.
#[cfg(target_os = "linux")]
fn collect_search_files(root: &Path, deadline: std::time::Instant) -> Result<(Vec<SearchCandidate>, bool), Failure> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let mut pending = vec![(root.to_path_buf(), open_root(root)?)];
    let mut candidates = BinaryHeap::new();
    let mut directories = 0usize;
    let mut visited = 0usize;
    let mut truncated = false;
    'walk: while let Some((dir, handle)) = pending.pop() {
        directories += 1;
        if directories > 2048 { truncated = true; break; }
        let entries = match std::fs::read_dir(format!("/proc/self/fd/{}", handle.as_raw_fd())) {
            Ok(entries) => entries,
            Err(error) if dir == root => return Err(io(error)),
            Err(_) => { truncated = true; continue; },
        };
        for entry in entries {
            if std::time::Instant::now() >= deadline || visited >= MAX_SCAN_ENTRIES { truncated = true; break 'walk; }
            visited += 1;
            let entry = match entry { Ok(entry) => entry, Err(_) => { truncated = true; continue; } };
            let kind = match entry.file_type() { Ok(kind) => kind, Err(_) => { truncated = true; continue; } };
            if kind.is_symlink() { return Err(("access_denied".into(), "Session search refuses symbolic links".into())); }
            let name = entry.file_name();
            let path = dir.join(&name);
            if kind.is_dir() {
                let name = name.to_str().ok_or_else(|| ("access_denied".into(), "Invalid session directory encoding".into()))?;
                if pending.len() >= 512 { truncated = true; continue; }
                match crate::file_access::openat_directory_no_follow(&handle, name) {
                    Ok(child) => pending.push((path, child)),
                    Err(error) => match open_failure(error) {
                        OpenFailure::Unsafe(message) => return Err(("access_denied".into(), message)),
                        OpenFailure::Unavailable => truncated = true,
                    },
                }
            } else if kind.is_file() && path.extension().is_some_and(|extension| extension == "jsonl") {
                let name = std::ffi::CString::new(name.as_bytes()).map_err(|error| ("access_denied".into(), error.to_string()))?;
                let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
                if unsafe { libc::fstatat(handle.as_raw_fd(), name.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 {
                    match open_failure(std::io::Error::last_os_error()) {
                        OpenFailure::Unsafe(message) => return Err(("access_denied".into(), message)),
                        OpenFailure::Unavailable => { truncated = true; continue; },
                    }
                }
                let stat = unsafe { stat.assume_init() };
                if stat.st_mode & libc::S_IFMT != libc::S_IFREG { return Err(("access_denied".into(), "Session path changed to a non-regular file".into())); }
                let candidate = SearchCandidate { modified: stat.st_mtime, modified_nsec: stat.st_mtime_nsec, path, device: stat.st_dev as u64, inode: stat.st_ino as u64 };
                candidates.push(Reverse(candidate));
                if candidates.len() > MAX_CANDIDATES { candidates.pop(); truncated = true; }
            }
        }
    }
    let mut candidates: Vec<_> = candidates.into_iter().map(|Reverse(candidate)| candidate).collect();
    candidates.sort_by(|a, b| b.cmp(a));
    Ok((candidates, truncated))
}

#[cfg(target_os = "linux")]
fn same_snapshot_version(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    before.dev() == after.dev() && before.ino() == after.ino() && before.len() == after.len()
        && before.mtime() == after.mtime() && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime() && before.ctime_nsec() == after.ctime_nsec()
}

#[cfg(target_os = "linux")]
fn verify_opened_source(root: &Path, path: &Path, handle: &std::fs::File, before: &std::fs::Metadata) -> Result<(), Failure> {
    use std::os::unix::fs::MetadataExt;
    if !same_snapshot_version(before, &handle.metadata().map_err(io)?) {
        return Err(("busy".into(), "Session changed during search snapshot".into()));
    }
    match open_beneath(root, path) {
        Ok(current) => {
            let current = current.metadata().map_err(io)?;
            if current.dev() != before.dev() || current.ino() != before.ino() {
                return Err(("busy".into(), "Session identity changed during search snapshot".into()));
            }
        }
        Err(OpenFailure::Unavailable) => return Err(("busy".into(), "Session disappeared during search snapshot".into())),
        Err(OpenFailure::Unsafe(message)) => return Err(("access_denied".into(), message)),
    }
    Ok(())
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
    snapshot_with_budget(state, SNAPSHOT_BUDGET)
}

#[cfg(target_os = "linux")]
fn snapshot_with_budget(state: &IpcHostState, budget: std::time::Duration) -> Result<SearchSnapshot, Failure> {
    snapshot_with_budget_hook(state, budget, || {})
}

#[cfg(target_os = "linux")]
fn snapshot_with_budget_hook(state: &IpcHostState, budget: std::time::Duration, after_discovery: impl FnOnce()) -> Result<SearchSnapshot, Failure> {
    snapshot_with_budget_hooks(state, budget, after_discovery, |_| {})
}

#[cfg(target_os = "linux")]
fn snapshot_with_budget_hooks(state: &IpcHostState, budget: std::time::Duration, after_discovery: impl FnOnce(), mut after_candidate: impl FnMut(usize)) -> Result<SearchSnapshot, Failure> {
    use std::io::{BufRead, Read, Seek, SeekFrom, Write};
    use std::os::unix::fs::MetadataExt;
    let deadline = std::time::Instant::now() + budget;
    let _policy = state.policy_gate.try_read().map_err(|_| ("busy".into(), "Session policy change is in progress".into()))?;
    let agent = state.agent_dir();
    if crate::trust_policy_fence::is_pending(&agent) { return Err(("busy".into(), "Trust policy outcome is unresolved".into())); }
    let directory = tempfile::Builder::new().prefix("pi-session-search-").tempdir().map_err(io)?;
    let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(&agent)
        .map_err(|e| ("busy".into(), format!("Scheduler transaction unavailable: {e}")))?;
    crate::session_deletion_journal::recover_pending(state, &agent)?;
    ensure_no_pending_writer_fences(&agent)?;
    let root = match agent.join("sessions").canonicalize() {
        Ok(root) => root,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SearchSnapshot { _directory: directory, candidates: Vec::new(), by_snapshot: HashMap::new(), truncated: false });
        }
        Err(e) => return Err(io(e)),
    };
    let (files, mut truncated) = collect_search_files(&root, deadline)?;
    after_discovery();
    let mut seen_ids = std::collections::HashSet::new();
    let mut source_ids = HashMap::new();
    let mut captured = Vec::new();
    let mut used = 0u64;
    // A fixed-size batch avoids holding a descriptor for every selected file.
    for batch in files.chunks(MAX_PINNED_FILES) {
        if std::time::Instant::now() >= deadline { truncated = true; break; }
        let mut pinned = Vec::new();
        for candidate in batch {
            if std::time::Instant::now() >= deadline { truncated = true; break; }
            let mut handle = match open_beneath(&root, &candidate.path) {
                Ok(handle) => handle,
                Err(OpenFailure::Unavailable) => { truncated = true; continue; },
                Err(OpenFailure::Unsafe(message)) => return Err(("access_denied".into(), message)),
            };
            let before = match handle.metadata() { Ok(metadata) => metadata, Err(_) => { truncated = true; continue; } };
            if before.dev() != candidate.device || before.ino() != candidate.inode {
                return Err(("busy".into(), "Session identity changed during search snapshot".into()));
            }
            if before.mtime() != candidate.modified || before.mtime_nsec() != candidate.modified_nsec { truncated = true; }
            let mut line = Vec::new();
            let read = std::io::BufReader::new(&mut handle).take(65537).read_until(b'\n', &mut line);
            verify_opened_source(&root, &candidate.path, &handle, &before)?;
            if read.is_err() || line.len() > 65536 || line.is_empty() { truncated = true; continue; }
            let header: Value = match serde_json::from_slice(&line) { Ok(header) => header, Err(_) => { truncated = true; continue; } };
            let Some(id) = header.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()) else { truncated = true; continue; };
            if header.get("type").and_then(Value::as_str) != Some("session") { truncated = true; continue; }
            if !seen_ids.insert(id.to_string()) { return Err(("busy".into(), "Duplicate session identity during search snapshot".into())); }
            source_ids.insert(key_of(&candidate.path), id.to_string());
            pinned.push((candidate.path.clone(), id.to_string(), handle, before));
        }
        let session_ids: Vec<_> = pinned.iter().map(|(_, id, _, _)| id.clone()).collect();
        state.registry.with_session_snapshot_gates(&session_ids, || {
            for (path, id, mut handle, before) in pinned {
                if std::time::Instant::now() >= deadline { truncated = true; break; }
                let length = before.len().min(MAX_FILE_BYTES);
                if before.len() > MAX_FILE_BYTES { truncated = true; }
                if used.saturating_add(length) > MAX_SNAPSHOT_BYTES { truncated = true; continue; }
                let snapshot = directory.path().join(format!("{}.jsonl", captured.len()));
                let mut output = match std::fs::OpenOptions::new().write(true).create_new(true).open(&snapshot) {
                    Ok(output) => output, Err(_) => { truncated = true; break; },
                };
                if handle.seek(SeekFrom::Start(0)).is_err() {
                    verify_opened_source(&root, &path, &handle, &before)?;
                    truncated = true; drop(output); std::fs::remove_file(&snapshot).map_err(io)?; continue;
                }
                let mut copied = 0u64;
                let mut buffer = [0u8; 64 * 1024];
                let mut failed = false;
                while copied < length {
                    if std::time::Instant::now() >= deadline { truncated = true; failed = true; break; }
                    let want = (length - copied).min(buffer.len() as u64) as usize;
                    let count = match handle.read(&mut buffer[..want]) { Ok(0) | Err(_) => { truncated = true; failed = true; break; }, Ok(count) => count };
                    if output.write_all(&buffer[..count]).is_err() { truncated = true; failed = true; break; }
                    copied += count as u64;
                }
                verify_opened_source(&root, &path, &handle, &before)?;
                if failed { drop(output); std::fs::remove_file(&snapshot).map_err(io)?; continue; }
                if output.flush().is_err() { truncated = true; drop(output); std::fs::remove_file(&snapshot).map_err(io)?; break; }
                if let Ok(modified) = before.modified() {
                    if output.set_times(std::fs::FileTimes::new().set_modified(modified)).is_err() {
                        truncated = true; drop(output); std::fs::remove_file(&snapshot).map_err(io)?; continue;
                    }
                }
                used += copied;
                let Some(mut scan) = session_host::scan_session_file_info(&snapshot) else { truncated = true; std::fs::remove_file(&snapshot).map_err(io)?; continue; };
                let relation = session_host::history::read_subagent_relation(&snapshot);
                if std::time::Instant::now() >= deadline { truncated = true; }
                if scan.id != id { return Err(("busy".into(), "Session identity changed during search snapshot".into())); }
                scan.path = path;
                let modified = before.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64).unwrap_or(0);
                captured.push((snapshot, scan, relation, modified));
                after_candidate(captured.len());
            }
            Ok::<_, Failure>(())
        }).map_err(|error| match error {
            session_host::SessionWriterError::Busy(message) => ("busy".into(), message.into()),
            session_host::SessionWriterError::Operation(error) => error,
        })?;
    }
    ensure_no_pending_writer_fences(&agent)?;
    let mut candidates = Vec::with_capacity(captured.len());
    let mut by_snapshot = HashMap::new();
    for (snapshot, scan, relation, modified) in captured {
        let parent_id = scan.parent_session_path.as_deref().and_then(|path| source_ids.get(&key_of(Path::new(path))).cloned());
        let relation = relation.or_else(|| scan.parent_session_path.as_ref().map(|_| json!({"kind":"fork","originSessionId":parent_id})));
        // Keep the mtime ranking used for bounded discovery when the original
        // matcher applies its 500-file cap; results retain source metadata.
        candidates.push(json!({"path":snapshot.to_string_lossy(),"id":scan.id,"modified":ms_to_iso(modified),"transient":false}));
        by_snapshot.insert(key_of(&snapshot), (scan, parent_id, relation));
    }
    Ok(SearchSnapshot { _directory: directory, candidates, by_snapshot, truncated })
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
    let snapshot = snapshot(state)?;
    search_from_snapshot(state, query, snapshot, call)
}

#[cfg(target_os = "linux")]
fn search_from_snapshot(state: &IpcHostState, query: &str, snapshot: SearchSnapshot, call: impl FnOnce(Value) -> Result<Value, Failure>) -> Result<Value, Failure> {
    let agent = state.agent_dir();
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

    fn fixture_session(root: &Path, id: &str, modified: u64, text: &str) -> PathBuf {
        let path = root.join(format!("{id}.jsonl"));
        let header = json!({"type":"session","id":id,"cwd":"/tmp","timestamp":"2026-01-01T00:00:00Z"});
        let message = json!({"type":"message","timestamp":"2099-01-01T00:00:00Z","message":{"role":"user","content":text}});
        std::fs::write(&path, format!("{header}\n{message}\n")).unwrap();
        let times = std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(modified));
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_times(times).unwrap();
        path
    }
    fn call_original_algorithm(request: Value) -> Result<Value, Failure> {
        let module = Path::new(env!("CARGO_MANIFEST_DIR")).join("../lib/session-search.ts");
        let script = "import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1]).href); const a=JSON.parse(process.argv[2]); console.log(JSON.stringify(await m.searchSessionContents(a.sessions,a.query)));";
        let output = std::process::Command::new("node").args(["--experimental-strip-types", "--input-type=module", "-e", script])
            .arg(module).arg(request.to_string()).env_remove("PI_PACKAGE_DIR").env_remove("PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT").env_remove("JITI_ALIAS").output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        Ok(serde_json::from_slice(&output.stdout).unwrap())
    }
    fn search_with_original_algorithm(state: &IpcHostState) -> Result<Value, Failure> {
        search_with_management(state, &json!({"query":"needle"}), call_original_algorithm)
    }
    fn search_fixture() -> (tempfile::TempDir, IpcHostState, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions/p"); std::fs::create_dir_all(&root).unwrap();
        let state = IpcHostState::new(); *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        (dir, state, root)
    }
    #[test]
    fn search_returns_recent_match_with_513_sessions() {
        let (_dir, state, root) = search_fixture();
        for i in 0..512 { fixture_session(&root, &format!("old-{i:03}"), 1_700_000_000 + i, "other"); }
        let newest = fixture_session(&root, "newest", 1_800_000_000, "needle");
        let contents = std::fs::read_to_string(&newest).unwrap().replace("2099-01-01", "2001-01-01");
        std::fs::write(&newest, contents).unwrap();
        std::fs::OpenOptions::new().write(true).open(&newest).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_800_000_000))).unwrap();
        let result = search_with_original_algorithm(&state).unwrap();
        assert_eq!(result["truncated"], true);
        assert_eq!(result["results"][0]["session"]["id"], "newest");
        assert_eq!(result["results"][0]["session"]["path"], newest.to_string_lossy().as_ref());
        assert!(result["results"][0]["session"]["modified"].as_str().unwrap().starts_with("2001-01-01"));
        assert!(!result.to_string().contains("pi-session-search-"));
    }
    #[test]
    fn oversized_old_session_does_not_hide_recent_match() {
        let (_dir, state, root) = search_fixture();
        let old = fixture_session(&root, "large-old", 1_600_000_000, "other");
        std::fs::OpenOptions::new().write(true).open(&old).unwrap().set_len(MAX_FILE_BYTES + 1).unwrap();
        std::fs::OpenOptions::new().write(true).open(&old).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000))).unwrap();
        let recent = fixture_session(&root, "recent", 1_800_000_000, "needle");
        let result = search_with_original_algorithm(&state).unwrap();
        assert_eq!(result["truncated"], true);
        assert_eq!(result["results"][0]["session"]["path"], recent.to_string_lossy().as_ref());
    }
    #[test]
    fn oversized_session_prefix_can_still_match() {
        let (_dir, state, root) = search_fixture();
        let file = fixture_session(&root, "large", 1_800_000_000, "needle before limit");
        std::fs::OpenOptions::new().write(true).open(&file).unwrap().set_len(MAX_FILE_BYTES * 4).unwrap();
        let snapshot = snapshot(&state).unwrap();
        let snapshot_path = Path::new(snapshot.candidates[0]["path"].as_str().unwrap());
        assert_eq!(std::fs::metadata(snapshot_path).unwrap().len(), MAX_FILE_BYTES);
        let result = search_from_snapshot(&state, "needle", snapshot, call_original_algorithm).unwrap();
        assert_eq!(result["truncated"], true);
        assert_eq!(result["results"][0]["session"]["path"], file.to_string_lossy().as_ref());
    }
    #[test]
    fn total_snapshot_budget_keeps_recent_match_and_reports_truncation() {
        let (_dir, state, root) = search_fixture();
        for i in 0..5 {
            let file = fixture_session(&root, &format!("large-{i}"), 1_600_000_000 + i, "other");
            let length = if i == 4 { MAX_FILE_BYTES } else { 15 * 1024 * 1024 };
            std::fs::OpenOptions::new().write(true).open(&file).unwrap().set_len(length).unwrap();
            std::fs::OpenOptions::new().write(true).open(&file).unwrap().set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000 + i))).unwrap();
        }
        let recent = fixture_session(&root, "recent", 1_800_000_000, "needle");
        let older_small = fixture_session(&root, "older-small", 1_500_000_000, "needle after skipped large files");
        let result = search_with_original_algorithm(&state).unwrap();
        assert_eq!(result["truncated"], true);
        assert_eq!(result["results"][0]["session"]["path"], recent.to_string_lossy().as_ref());
        assert!(result["results"].as_array().unwrap().iter().any(|hit| hit["session"]["path"] == older_small.to_string_lossy().as_ref()));
    }
    #[test]
    fn unreadable_session_is_skipped_without_losing_other_results() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, state, root) = search_fixture();
        let unreadable = fixture_session(&root, "unreadable", 1_900_000_000, "other");
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0)).unwrap();
        assert!(std::fs::File::open(&unreadable).is_err(), "fixture must run without DAC override");
        let recent = fixture_session(&root, "recent", 1_800_000_000, "needle");
        let result = search_with_original_algorithm(&state).unwrap();
        assert_eq!(result["truncated"], true);
        assert_eq!(result["results"][0]["session"]["path"], recent.to_string_lossy().as_ref());
    }
    #[test]
    fn unreadable_history_directory_keeps_accessible_results() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, state, root) = search_fixture();
        let blocked = root.join("blocked"); std::fs::create_dir(&blocked).unwrap();
        fixture_session(&blocked, "hidden", 1_900_000_000, "other");
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0)).unwrap();
        assert!(std::fs::read_dir(&blocked).is_err(), "fixture must run without DAC override");
        let recent = fixture_session(&root, "recent", 1_800_000_000, "needle");
        let result = search_with_original_algorithm(&state).unwrap();
        assert_eq!(result["truncated"], true);
        assert_eq!(result["results"][0]["session"]["path"], recent.to_string_lossy().as_ref());
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[test]
    fn elapsed_snapshot_budget_returns_incomplete_not_error() {
        let (_dir, state, root) = search_fixture();
        fixture_session(&root, "one", 1_800_000_000, "needle");
        let snapshot = snapshot_with_budget(&state, std::time::Duration::ZERO).unwrap();
        assert!(snapshot.truncated);
        assert!(snapshot.candidates.is_empty());
    }
    #[test]
    fn deadline_after_one_snapshot_keeps_the_existing_match() {
        let (_dir, state, root) = search_fixture();
        fixture_session(&root, "older", 1_700_000_000, "other");
        let recent = fixture_session(&root, "recent", 1_800_000_000, "needle");
        let snapshot = snapshot_with_budget_hooks(&state, std::time::Duration::from_secs(1), || {}, |count| {
            if count == 1 { std::thread::sleep(std::time::Duration::from_millis(1100)); }
        }).unwrap();
        assert!(snapshot.truncated);
        assert_eq!(snapshot.candidates.len(), 1);
        let result = search_from_snapshot(&state, "needle", snapshot, call_original_algorithm).unwrap();
        assert_eq!(result["truncated"], true);
        assert_eq!(result["results"][0]["session"]["path"], recent.to_string_lossy().as_ref());
    }
    #[test]
    fn writer_fence_created_during_snapshot_is_not_reported_as_partial_success() {
        let (dir, state, root) = search_fixture();
        let source = fixture_session(&root, "source", 1_800_000_000, "needle");
        let result = snapshot_with_budget_hooks(&state, SNAPSHOT_BUDGET, || {}, |count| {
            if count == 1 { crate::session_writer_fence::begin(dir.path(), "other", "op", "chat", &source, None, None).unwrap(); }
        });
        assert_eq!(result.err().unwrap().0, "busy");
        assert!(crate::session_writer_fence::fence_path(dir.path(), "other").exists());
    }
    #[test]
    fn pending_fence_is_not_hidden_by_timeout_or_unreadable_source() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, state, root) = search_fixture();
        let file = fixture_session(&root, "fenced", 1_800_000_000, "needle");
        crate::session_writer_fence::begin(dir.path(), "fenced", "op", "chat", &file, None, None).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0)).unwrap();
        assert_eq!(snapshot_with_budget(&state, std::time::Duration::ZERO).err().unwrap().0, "busy");
        assert_eq!(snapshot(&state).err().unwrap().0, "busy");
    }
    #[test]
    fn duplicate_session_id_is_not_hidden_as_a_partial_search() {
        let (_dir, state, root) = search_fixture();
        let first = fixture_session(&root, "first", 1_800_000_000, "needle");
        let duplicate = root.join("duplicate.jsonl");
        std::fs::copy(&first, &duplicate).unwrap();
        let result = snapshot(&state);
        assert_eq!(result.err().unwrap().0, "busy");
        assert!(first.exists() && duplicate.exists());
    }
    #[test]
    fn replacing_a_discovered_candidate_is_a_security_refusal() {
        let (_dir, state, root) = search_fixture();
        let path = fixture_session(&root, "same-id", 1_800_000_000, "needle");
        let result = snapshot_with_budget_hook(&state, SNAPSHOT_BUDGET, || {
            std::fs::rename(&path, root.join("old.saved")).unwrap();
            fixture_session(&root, "same-id", 1_800_000_000, "replacement");
        });
        assert_eq!(result.err().unwrap().0, "busy");
    }
    #[test]
    fn replacing_a_discovered_candidate_with_symlink_is_refused() {
        let (dir, state, root) = search_fixture();
        let path = fixture_session(&root, "candidate", 1_800_000_000, "needle");
        let outside = dir.path().join("outside.jsonl"); std::fs::write(&outside, "secret").unwrap();
        let result = snapshot_with_budget_hook(&state, SNAPSHOT_BUDGET, || {
            std::fs::remove_file(&path).unwrap(); std::os::unix::fs::symlink(&outside, &path).unwrap();
        });
        assert_eq!(result.err().unwrap().0, "access_denied");
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "secret");
    }
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
        crate::session_writer_fence::begin(dir.path(), "a", "op", "chat", &file, None, None).unwrap();
        assert_eq!(snapshot(&state).err().unwrap().0, "busy");
        for op in ["sessions.index", "sessions.list"] {
            let response = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"test","op":op,"args":{}}));
            assert_eq!(response["error"]["code"], "busy", "{op}: {response}");
        }
        crate::session_writer_fence::finish(dir.path(), "a", "op").unwrap();
        let marker = crate::session_writer_fence::fence_path(dir.path(), "a");
        std::fs::write(&marker, "{broken").unwrap();
        assert_eq!(snapshot(&state).err().unwrap().0, "busy");
        assert!(marker.exists());
        std::fs::remove_file(marker).unwrap();
        assert!(snapshot(&state).is_ok());
    }
    #[test]
    fn snapshot_limits_are_explicit_and_candidate_cap_sets_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions/p"); std::fs::create_dir_all(&root).unwrap();
        let state = IpcHostState::new(); *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let large = root.join("large.jsonl");
        std::fs::File::create(&large).unwrap().set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(snapshot(&state).unwrap().truncated);
        std::fs::remove_file(large).unwrap();
        for i in 0..513 {
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
