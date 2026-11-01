//! The `file_resources` module (M3):
//! - `files.index`: project file index & fuzzy search
//! - `desktop.describePaths`: path classification for drop & dialog
//! - `desktop.readImages`: native image attachments (size & count capped)
//! - `desktop.saveFile`: dialog-scoped destination save
//! - `chats.extractAttachmentText`: bounded DOCX worker extraction
//! - `chats.revealFolder`: reveal chat folder
//! - `chats.revealDownload`: reveal chat download (confined to Downloads)

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::file_access::is_hidden_outside_git;
use crate::pi_ipc::{protocol_error, protocol_ok, IpcHostState};

/// Cap on client-side full index (unfiltered).
pub const MAX_FILES: usize = 5000;
/// Hard caps on scan listings.
pub const GIT_HARD_CAP: usize = 200_000;
pub const WALK_HARD_CAP: usize = 50_000;
/// Open directory handles waiting to be visited; the active directory and
/// one temporary enumeration handle are additional to this queue.
const WALK_MAX_PENDING_DIRECTORIES: usize = 64;
/// Cumulative bytes of materialized relative paths, including queued directories.
const WALK_MAX_PATH_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_WALK_DEPTH: usize = 8;
pub const MAX_QUERY_LENGTH: usize = 500;
pub const CACHE_TTL: Duration = Duration::from_secs(10);
pub const CACHE_MAX_ENTRIES: usize = 20;
/// Maximum retained allocation for cached index keys and file paths.
const CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;
pub const DEFAULT_MATCH_LIMIT: usize = 20;
pub const MAX_MATCH_LIMIT: usize = 200;

/// Desktop image attachment constraints (derived from lib/image-attachments.ts).
pub const MAX_ATTACHED_IMAGES: usize = 10;
pub const MAX_ATTACHED_IMAGE_BYTES: u64 = 10 * 1024 * 1024; // 10MB
pub const MAX_ATTACHED_IMAGE_SELECTION_BYTES: u64 = 50 * 1024 * 1024; // 50MB

/// Desktop save constraints (lib/desktop-api.ts).
pub const MAX_DESKTOP_SAVE_BYTES: u64 = 100 * 1024 * 1024; // 100MB

/// Chat attachment extraction constraints (lib/chat-attachments.ts).
pub const CHAT_ATTACHMENT_EXTRACT_MAX_BYTES: usize = 10 * 1024 * 1024; // 10MB
pub const CHAT_ATTACHMENT_MAX_FILE_BYTES: usize = 256 * 1024; // 256KB

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexEntry {
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone)]
pub struct CachedFileIndex {
    pub files: Vec<String>,
    pub hard_truncated: bool,
    pub expires_at: Instant,
}

// Include Vec and String backing allocations and conservative per-entry map
// overhead. Search-derived directory entries are not stored in this cache.
fn cached_index_bytes(key: &String, entry: &CachedFileIndex) -> usize {
    key.capacity().saturating_add(128)
        .saturating_add(entry.files.capacity().saturating_mul(std::mem::size_of::<String>()))
        .saturating_add(entry.files.iter().map(String::capacity).sum::<usize>())
}

/// MIME by extension for images (lib/file-types.ts IMAGE_EXT_TO_MIME).
pub fn get_image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension().and_then(|e| e.to_str())?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// files.index
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn collect_files_with_git(cwd: &std::fs::File, state: &IpcHostState) -> Result<Option<(Vec<String>, bool, bool)>, String> {
    #[cfg(test)]
    let executable = state.index_git_executable.lock().unwrap().clone().unwrap_or_else(|| PathBuf::from("git"));
    #[cfg(not(test))]
    let executable = PathBuf::from("git");
    collect_git_command(cwd, &state.index_children, executable.as_os_str(), 8 * 1024 * 1024, Duration::from_secs(5))
}

#[cfg(unix)]
fn collect_git_command(cwd: &std::fs::File, owner: &crate::index_children::IndexChildOwner, executable: &std::ffi::OsStr, byte_limit: usize, timeout: Duration) -> Result<Option<(Vec<String>, bool, bool)>, String> {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    let deadline = Instant::now() + timeout;
    let mut lease = owner.reserve()?;
    let mut command = std::process::Command::new(executable);
    crate::file_access::file_directory_unix::git_directory(&mut command, cwd);
    command.args(["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .env("LC_ALL", "C").stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    if lease.spawn(&mut command).is_err() { return Ok(None); }
    let Some(mut stdout) = lease.child_mut().stdout.take() else {
        let cleanup_unknown = !terminate_index_child(&mut lease, deadline);
        return Ok(Some((Vec::new(), true, cleanup_unknown)));
    };
    let fd = stdout.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    let nonblocking = flags >= 0 && unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } >= 0;
    let mut bytes = Vec::new();
    let mut buf = [0u8; 16384];
    let mut status = None;
    let mut eof = false;
    let mut truncated = !nonblocking;
    while nonblocking {
        if owner.is_closing() || Instant::now() >= deadline { truncated = true; break; }
        if !eof {
            let remaining = byte_limit.saturating_sub(bytes.len());
            if remaining == 0 { truncated = true; break; }
            let read_size = remaining.min(buf.len());
            match stdout.read(&mut buf[..read_size]) {
                Ok(0) => eof = true,
                Ok(n) => { bytes.extend_from_slice(&buf[..n]); continue; }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock || error.kind() == std::io::ErrorKind::Interrupted => {},
                Err(_) => { truncated = true; break; }
            }
        }
        if status.is_none() {
            match lease.try_wait() {
                Ok(Some(exit)) => status = Some(exit),
                Ok(None) => {},
                Err(_) => { truncated = true; break; }
            }
        }
        if eof && status.is_some() { break; }
        let timeout_ms = deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(25)).as_millis() as i32;
        if eof { std::thread::sleep(Duration::from_millis(2).min(deadline.saturating_duration_since(Instant::now()))); }
        else { let mut pollfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 }; unsafe { libc::poll(&mut pollfd, 1, timeout_ms); } }
    }
    drop(stdout);
    let cleanup_unknown = status.is_none() && !terminate_index_child(&mut lease, deadline);
    if !truncated && status.is_some_and(|exit| !exit.success()) { return Ok(None); }
    if !bytes.is_empty() && bytes.last() != Some(&0) { truncated = true; }
    let mut files = Vec::new();
    for chunk in bytes.split_inclusive(|&b| b == 0) {
        if chunk.last() != Some(&0) { break; }
        let chunk = &chunk[..chunk.len() - 1];
        if chunk.is_empty() { continue; }
        let Ok(text) = std::str::from_utf8(chunk) else { truncated = true; continue };
        if text == ".git" || text.starts_with(".git/") || text == ".DS_Store" { continue; }
        files.push(text.to_string());
        if files.len() >= GIT_HARD_CAP { truncated = true; break; }
    }
    Ok(Some((files, truncated, cleanup_unknown)))
}

#[cfg(unix)]
fn terminate_index_child(lease: &mut crate::index_children::ChildLease, deadline: Instant) -> bool {
    lease.kill();
    loop {
        match lease.try_wait() {
            Ok(Some(_)) => return true,
            Err(_) => return false,
            Ok(None) => {},
        }
        if Instant::now() >= deadline { return false; }
        std::thread::sleep(Duration::from_millis(2).min(deadline.saturating_duration_since(Instant::now())));
    }
}

/// The node budget counts every enumerated entry, including directories and
/// hidden entries. The queue cap is checked before opening another handle.
struct FileWalkBudget<T> {
    pending: std::collections::VecDeque<T>,
    visited: usize,
    node_limit: usize,
    pending_limit: usize,
    path_bytes: usize,
    path_byte_limit: usize,
    path_exhausted: bool,
    truncated: bool,
}

impl<T> FileWalkBudget<T> {
    fn new(root: T, node_limit: usize, pending_limit: usize) -> Self {
        Self { pending: std::collections::VecDeque::from([root]), visited: 0, node_limit, pending_limit, path_bytes: 0, path_byte_limit: WALK_MAX_PATH_BYTES, path_exhausted: false, truncated: false }
    }
    fn record_path(&mut self, path: &str) -> bool {
        match self.path_bytes.checked_add(path.len()) {
            Some(total) if total <= self.path_byte_limit => { self.path_bytes = total; true }
            _ => { self.path_exhausted = true; self.truncated = true; false }
        }
    }
    fn remaining(&self) -> usize { self.node_limit - self.visited }
    fn record(&mut self, count: usize, more: bool) {
        assert!(count <= self.remaining());
        self.visited += count;
        self.truncated |= more;
    }
    fn pop(&mut self) -> Option<T> { self.pending.pop_front() }
    fn enqueue<E>(&mut self, open: impl FnOnce() -> Result<T, E>) -> Result<(), E> {
        if self.pending.len() >= self.pending_limit || self.remaining() == 0 {
            self.truncated = true;
            return Ok(());
        }
        self.pending.push_back(open()?);
        Ok(())
    }
    fn exhausted(&mut self) -> bool {
        if self.remaining() == 0 && !self.pending.is_empty() {
            self.truncated = true;
            return true;
        }
        false
    }
}

#[cfg(unix)]
fn collect_files_with_walk(cwd: &std::fs::File) -> (Vec<String>, bool) {
    collect_files_with_walk_limits(cwd, WALK_HARD_CAP, WALK_MAX_PENDING_DIRECTORIES, WALK_MAX_PATH_BYTES)
}

#[cfg(unix)]
fn collect_files_with_walk_limits(cwd: &std::fs::File, node_limit: usize, pending_limit: usize, path_byte_limit: usize) -> (Vec<String>, bool) {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let mut files = Vec::new();
    let Ok(root) = cwd.try_clone() else { return (files, true) };
    let mut budget = FileWalkBudget::new((root, String::new(), 0), node_limit, pending_limit);
    budget.path_byte_limit = path_byte_limit;

    while let Some((directory, rel, depth)) = budget.pop() {
        let prefix_bytes = if rel.is_empty() { 0 } else { rel.len() + 1 };
        let (read_dir, more) = match crate::file_access::file_directory_unix::directory_entries_path_bounded(&directory, budget.remaining(), budget.path_byte_limit.saturating_sub(budget.path_bytes), prefix_bytes) {
            Ok(entries) => entries,
            Err(_) => { budget.truncated = true; continue; }
        };
        budget.record(read_dir.len(), more);
        for entry in read_dir {
            let name = entry.to_string_lossy().into_owned();
            if is_hidden_outside_git(&name) {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if !budget.record_path(&child_rel) { break; }
            let Ok(cname) = std::ffi::CString::new(entry.as_bytes()) else { budget.truncated = true; continue };
            let mut stat: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe { libc::fstatat(directory.as_raw_fd(), cname.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } != 0 { budget.truncated = true; continue; }
            if stat.st_mode & libc::S_IFMT == libc::S_IFDIR {
                if depth + 1 <= MAX_WALK_DEPTH {
                    if budget.enqueue(|| crate::file_access::openat_directory_no_follow(&directory, &name).map(|child| (child, child_rel, depth + 1))).is_err() {
                        budget.truncated = true;
                    }
                } else { budget.truncated = true; }
            } else {
                files.push(child_rel);
            }
        }
        if more || budget.path_exhausted || budget.exhausted() { break; }
    }
    (files, budget.truncated)
}

fn path_depth(p: &str) -> usize {
    p.bytes().filter(|&b| b == b'/').count()
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    let mut needle_chars = needle.chars();
    let mut current_needle = needle_chars.next();
    for h in haystack.chars() {
        if let Some(n) = current_needle {
            if h == n {
                current_needle = needle_chars.next();
                if current_needle.is_none() {
                    return true;
                }
            }
        }
    }
    current_needle.is_none()
}

fn score_entry(entry: &FileIndexEntry, lower_query: &str) -> i32 {
    let lower_path = entry.path.to_ascii_lowercase();
    let mut score = 0;
    if lower_query.contains('/') {
        if lower_path == lower_query {
            score = 100;
        } else if lower_path.starts_with(lower_query) {
            score = 80;
        } else if lower_path.contains(lower_query) {
            score = 50;
        } else if is_subsequence(lower_query, &lower_path) {
            score = 10;
        }
    } else {
        let slash = lower_path.rfind('/');
        let lower_name = match slash {
            Some(idx) => &lower_path[idx + 1..],
            None => &lower_path,
        };
        if lower_name == lower_query {
            score = 100;
        } else if lower_name.starts_with(lower_query) {
            score = 80;
        } else if lower_name.contains(lower_query) {
            score = 50;
        } else if lower_path.contains(lower_query) {
            score = 30;
        } else if is_subsequence(lower_query, &lower_path) {
            score = 10;
        }
    }
    if entry.is_dir && score > 0 {
        score += 10;
    }
    score
}

const INDEX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

// Charge directory set and vector capacity conservatively, not just the path
// payload. A prefix fan-out can otherwise dwarf the original file listing.
fn derive_entries_bounded(files: &[String], limit: usize) -> (Vec<FileIndexEntry>, bool) {
    let mut dirs: HashSet<&str> = HashSet::new();
    let mut entries = Vec::new();
    let mut used = 0usize;
    let mut truncated = false;
    'files: for f in files {
        for (i, _) in f.match_indices('/') {
            let dir = &f[..i];
            if dirs.contains(dir) { continue; }
            let cost = dir.len().saturating_add(128);
            if used.saturating_add(cost) > limit { truncated = true; break 'files; }
            used += cost;
            dirs.insert(dir);
            entries.push(FileIndexEntry { path: dir.to_owned(), is_dir: true });
        }
        if !f.is_empty() {
            let cost = f.len().saturating_add(64);
            if used.saturating_add(cost) > limit { truncated = true; break; }
            used += cost;
            entries.push(FileIndexEntry { path: f.clone(), is_dir: false });
        }
    }
    entries.sort_by(|a, b| path_depth(&a.path).cmp(&path_depth(&b.path)).then_with(|| a.path.cmp(&b.path)));
    (entries, truncated)
}

fn encoded_path_bytes(path: &str) -> usize {
    path.bytes().fold(2usize, |size, byte| size.saturating_add(match byte {
        b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 8 | 12 => 2,
        0..=31 => 6,
        _ => 1,
    }))
}

fn response_prefix_len(sizes: impl Iterator<Item = usize>, byte_limit: usize) -> usize {
    let mut used = 128usize; // envelope, array punctuation, and truncation flag
    sizes.take_while(|size| {
        used = used.saturating_add(size.saturating_add(1));
        used <= byte_limit
    }).count()
}

pub fn filter_file_entries(
    entries: &[FileIndexEntry],
    query: &str,
    limit: usize,
) -> Vec<FileIndexEntry> {
    let lower_query = query.to_ascii_lowercase();
    if lower_query.is_empty() {
        return entries.iter().take(limit).cloned().collect();
    }
    let mut scored: Vec<(&FileIndexEntry, i32)> = Vec::new();
    for entry in entries {
        let score = score_entry(entry, &lower_query);
        if score > 0 {
            scored.push((entry, score));
        }
    }
    scored.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| path_depth(&a.0.path).cmp(&path_depth(&b.0.path)))
            .then_with(|| a.0.path.cmp(&b.0.path))
    });
    scored.into_iter().take(limit).map(|(e, _)| e.clone()).collect()
}

#[cfg(unix)]
pub fn handle_files_index(state: &IpcHostState, id: &str, args: &Value) -> Value {
    let cwd_str = args.get("cwd").and_then(Value::as_str).unwrap_or("").trim();
    if cwd_str.is_empty() {
        return protocol_error(id, "invalid_args", "cwd must be an absolute path");
    }
    let cwd_path = PathBuf::from(cwd_str);
    if !cwd_path.is_absolute() {
        return protocol_error(id, "invalid_args", "cwd must be an absolute path");
    }

    // Security: must be inside allowed roots.
    {
        let roots = state.file_roots.lock().unwrap();
        if !roots.is_path_allowed(&cwd_path) {
            return protocol_error(id, "unauthorized_scope", "Access denied");
        }
    }
    if !cwd_path.exists() {
        return protocol_error(id, "not_found", "Directory not found");
    }
    if !cwd_path.is_dir() {
        return protocol_error(id, "invalid_args", "Not a directory");
    }
    let cwd_handle = match state.file_roots.lock().unwrap().open_directory(&cwd_path) {
        Ok(handle) => handle,
        Err(error) => return protocol_error(id, "unauthorized_scope", &error.to_string()),
    };
    let query = args.get("q").and_then(Value::as_str);
    if query.is_some_and(|q| q.len() > MAX_QUERY_LENGTH) { return protocol_error(id, "invalid_args", "query is too long"); }

    let match_limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|l| (l as usize).clamp(1, MAX_MATCH_LIMIT))
        .unwrap_or(DEFAULT_MATCH_LIMIT);

    // Identify the opened directory, not just the user-provided spelling. Never
    // hold the cache mutex across Git or filesystem enumeration.
    use std::os::unix::fs::MetadataExt;
    let metadata = match cwd_handle.metadata() { Ok(meta) => meta, Err(error) => return protocol_error(id, "io", &error.to_string()) };
    let cache_key = format!("{}:{}:{}", cwd_str, metadata.dev(), metadata.ino());
    let cached = state.file_index_cache.try_lock().ok().and_then(|cache| {
        cache.get(&cache_key).filter(|entry| entry.expires_at > Instant::now()).cloned()
    });
    let (listing, cleanup_unknown) = if let Some(entry) = cached {
        (entry, false)
    } else {
        let (files, hard_truncated, cleanup_unknown) = match collect_files_with_git(&cwd_handle, state) {
            Ok(Some(listing)) => listing,
            Ok(None) => { let (files, truncated) = collect_files_with_walk(&cwd_handle); (files, truncated, false) },
            Err(error) => return protocol_error(id, "resource_busy", &error),
        };
        let entry = CachedFileIndex { files, hard_truncated, expires_at: Instant::now() + CACHE_TTL };
        if !cleanup_unknown { if let Ok(mut cache) = state.file_index_cache.try_lock() {
            cache.retain(|_, value| value.expires_at > Instant::now());
            let cost = cached_index_bytes(&cache_key, &entry);
            if cost <= CACHE_MAX_BYTES {
                let total = cache.iter().fold(0usize, |sum, (key, value)| sum.saturating_add(cached_index_bytes(key, value)));
                if cache.len() >= CACHE_MAX_ENTRIES || total.saturating_add(cost) > CACHE_MAX_BYTES {
                    cache.clear();
                }
                cache.insert(cache_key, entry.clone());
            }
        } }
        (entry, cleanup_unknown)
    };

    if let Some(q) = query {
        if !q.is_empty() {
            let (all_entries, derived_truncated) = derive_entries_bounded(&listing.files, INDEX_RESPONSE_BYTES);
            let matches = filter_file_entries(&all_entries, q, match_limit);
            let count = response_prefix_len(matches.iter().map(|entry| encoded_path_bytes(&entry.path).saturating_add(32)), INDEX_RESPONSE_BYTES.saturating_sub(encoded_path_bytes(id)));
            return protocol_ok(id, json!({ "matches": &matches[..count], "truncated": listing.hard_truncated || derived_truncated || count < matches.len(), "cleanupUnknown": cleanup_unknown }));
        }
    }

    let capped = listing.files.len().min(MAX_FILES);
    let count = response_prefix_len(listing.files[..capped].iter().map(|path| encoded_path_bytes(path)), INDEX_RESPONSE_BYTES.saturating_sub(encoded_path_bytes(id)));
    let truncated = listing.hard_truncated || count < listing.files.len();
    let files_slice = &listing.files[..count];
    protocol_ok(
        id,
        json!({
            "files": files_slice,
            "truncated": truncated,
            "cleanupUnknown": cleanup_unknown,
        }),
    )
}

#[cfg(windows)]
pub fn handle_files_index(state: &IpcHostState, id: &str, args: &Value) -> Value {
    let cwd = Path::new(args.get("cwd").and_then(Value::as_str).unwrap_or(""));
    if !cwd.is_absolute() { return protocol_error(id, "invalid_args", "cwd must be an absolute path"); }
    let handle = match state.file_roots.lock().unwrap().open_directory(cwd) {
        Ok(handle) => handle, Err(error) => return protocol_error(id, "unauthorized_scope", &error.to_string()),
    };
    let mut budget = FileWalkBudget::new((handle, String::new(), 0usize), WALK_HARD_CAP, WALK_MAX_PENDING_DIRECTORIES);
    let mut files = Vec::new();
    while let Some((directory, relative, depth)) = budget.pop() {
        let prefix_bytes = if relative.is_empty() { 0 } else { relative.len() + 1 };
        let (entries, more) = match crate::file_access::file_handle_windows::entries_path_bounded(&directory, budget.remaining(), budget.path_byte_limit.saturating_sub(budget.path_bytes), prefix_bytes) {
            Ok(entries) => entries, Err(error) => return protocol_error(id, "io", &error.to_string()),
        };
        budget.record(entries.len(), more);
        for (name, is_dir, reparse) in entries {
            let Some(name) = name.to_str() else { return protocol_error(id, "io", "Directory contains a non-Unicode name") };
            if is_hidden_outside_git(name) || reparse { continue; }
            let child = if relative.is_empty() { name.to_owned() } else { format!("{relative}/{name}") };
            if !budget.record_path(&child) { break; }
            if is_dir && depth < MAX_WALK_DEPTH {
                if let Err(error) = budget.enqueue(|| crate::file_access::file_handle_windows::open_child(&directory, std::ffi::OsStr::new(name), true).map(|dir| (dir, child, depth + 1))) {
                    return protocol_error(id, "io", &error.to_string());
                }
            } else if !is_dir {
                files.push(child);
            } else { budget.truncated = true; }
        }
        if more || budget.path_exhausted || budget.exhausted() { break; }
    }
    if let Some(query) = args.get("q").and_then(Value::as_str).filter(|q| !q.is_empty()) {
        if query.len() > MAX_QUERY_LENGTH { return protocol_error(id, "invalid_args", "query is too long"); }
        let limit = args.get("limit").and_then(Value::as_u64).map(|n| (n as usize).clamp(1, MAX_MATCH_LIMIT)).unwrap_or(DEFAULT_MATCH_LIMIT);
        let (entries, _) = derive_entries_bounded(&files, INDEX_RESPONSE_BYTES);
        let matches = filter_file_entries(&entries, query, limit);
        let count = response_prefix_len(matches.iter().map(|entry| encoded_path_bytes(&entry.path).saturating_add(32)), INDEX_RESPONSE_BYTES.saturating_sub(encoded_path_bytes(id)));
        return protocol_ok(id, json!({ "matches": &matches[..count], "truncated": true }));
    }
    files.truncate(MAX_FILES);
    let count = response_prefix_len(files.iter().map(|path| encoded_path_bytes(path)), INDEX_RESPONSE_BYTES.saturating_sub(encoded_path_bytes(id)));
    files.truncate(count);
    // Git visibility cannot yet be evaluated through a pinned Windows cwd.
    protocol_ok(id, json!({ "files": files, "truncated": true }))
}

// ---------------------------------------------------------------------------
// desktop.describePaths
// ---------------------------------------------------------------------------

pub const MAX_PATHS: usize = 100;

pub fn handle_desktop_describe_paths(state: &IpcHostState, id: &str, args: &Value) -> Value {
    let Some(paths) = args.get("paths").and_then(Value::as_array) else {
        return protocol_error(id, "invalid_args", "paths must be an array of strings");
    };
    if paths.is_empty() {
        return protocol_error(id, "invalid_args", "No paths given");
    }
    if paths.len() > MAX_PATHS {
        return protocol_error(id, "invalid_args", &format!("At most {MAX_PATHS} paths"));
    }

    let mut items = Vec::new();
    for item in paths {
        let raw = item.as_str().unwrap_or("").trim();
        if raw.is_empty() || raw.contains('\0') {
            items.push(json!({ "path": raw, "kind": "other" }));
            continue;
        }
        let p = PathBuf::from(raw);
        if !p.is_absolute() {
            items.push(json!({ "path": raw, "kind": "other" }));
            continue;
        }
        let Some((directory, size, handle)) = state.native_drops.info(raw) else {
            items.push(json!({ "path": raw, "kind": "other" }));
            continue;
        };
        if directory {
            items.push(json!({ "path": raw, "kind": "directory" }));
        } else if handle.is_some() {
            let image_mime = get_image_mime(&p);
            let mut val = json!({
                "path": raw,
                "kind": "file",
                "size": size,
            });
            if let Some(mime) = image_mime {
                val["imageMime"] = json!(mime);
            }
            items.push(val);
        } else {
            items.push(json!({ "path": raw, "kind": "other" }));
        }
    }
    protocol_ok(id, json!({ "items": items }))
}

// ---------------------------------------------------------------------------
// desktop.readImages
// ---------------------------------------------------------------------------

pub fn handle_desktop_read_images(state: &IpcHostState, id: &str, args: &Value) -> Value {
    let Some(paths) = args.get("paths").and_then(Value::as_array) else {
        return protocol_error(id, "invalid_args", "paths must be an array of strings");
    };
    if paths.is_empty() {
        return protocol_error(id, "invalid_args", "No files selected");
    }
    if paths.len() > MAX_ATTACHED_IMAGES {
        return protocol_error(
            id,
            "invalid_args",
            &format!("Select at most {MAX_ATTACHED_IMAGES} images"),
        );
    }

    let mut files = Vec::new();
    let mut total_bytes = 0u64;

    for item in paths {
        let raw = item.as_str().unwrap_or("").trim();
        if raw.is_empty() || raw.contains('\0') {
            return protocol_error(id, "invalid_args", &format!("Invalid path: {raw}"));
        }
        let path = PathBuf::from(raw);
        if !path.is_absolute() {
            return protocol_error(id, "invalid_args", &format!("Invalid path: {raw}"));
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(raw)
            .to_string();

        let Some((false, _, Some(handle))) = state.native_drops.info(raw) else {
            return protocol_error(id, "unauthorized_scope", "file was not supplied by a native drop");
        };
        let response = state.resources.read(&handle, "", Some((0, MAX_ATTACHED_IMAGE_BYTES)));
        let (bytes, size) = match response {
            resource_protocol::ResourceResponse::Ok { bytes, total_len, .. } => (bytes, total_len),
            _ => return protocol_error(id, "not_found", &format!("File no longer available: {name}")),
        };
        if size > MAX_ATTACHED_IMAGE_BYTES {
            return protocol_error(
                id,
                "payload_too_large",
                &format!(
                    "Each image must be {}MB or smaller",
                    MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024)
                ),
            );
        }
        total_bytes += size;
        if total_bytes > MAX_ATTACHED_IMAGE_SELECTION_BYTES {
            return protocol_error(
                id,
                "payload_too_large",
                &format!(
                    "Selected images must total {}MB or less",
                    MAX_ATTACHED_IMAGE_SELECTION_BYTES / (1024 * 1024)
                ),
            );
        }
        let Some(mime_type) = get_image_mime(&path) else {
            return protocol_error(id, "invalid_args", &format!("Not an image: {name}"));
        };

        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        files.push(json!({
            "name": name,
            "mimeType": mime_type,
            "data": encoded,
        }));
    }

    protocol_ok(id, json!({ "files": files }))
}

// ---------------------------------------------------------------------------
// desktop.saveFile
// ---------------------------------------------------------------------------

pub fn handle_desktop_save_file(state: &IpcHostState, id: &str, args: &Value) -> Value {
    let dest_path_str = args
        .get("destPath")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if dest_path_str.is_empty() {
        return protocol_error(id, "invalid_args", "destPath is required");
    }
    let dest_path = PathBuf::from(dest_path_str);
    if !dest_path.is_absolute() {
        return protocol_error(id, "invalid_args", "destPath must be an absolute path");
    }

    // Destination authorization check: must have been bound via dialog selection.
    if !state.consume_authorized_save_destination(&dest_path) {
        return protocol_error(
            id,
            "unauthorized_scope",
            "destination path was not authorized by dialog",
        );
    }

    // Destination parent directory must exist and be a directory.
    let Some(parent) = dest_path.parent() else {
        return protocol_error(id, "invalid_args", "Destination parent does not exist");
    };
    if !parent.is_dir() {
        return protocol_error(id, "invalid_args", "Destination directory does not exist");
    }
    if dest_path.exists() {
        if dest_path.is_dir() {
            return protocol_error(id, "invalid_args", "Destination must be a regular file path");
        }
        if let Ok(meta) = std::fs::symlink_metadata(&dest_path) {
            if meta.file_type().is_symlink() {
                return protocol_error(id, "invalid_args", "Destination must be a regular file path");
            }
        }
    }

    // Either copying from sourcePath or writing decoded data bytes.
    if let Some(source_str) = args.get("sourcePath").and_then(Value::as_str) {
        let source_path = PathBuf::from(source_str.trim());
        if !source_path.is_absolute() {
            return protocol_error(id, "invalid_args", "sourcePath must be absolute");
        }
        {
            let roots = state.file_roots.lock().unwrap();
            if !roots.is_existing_path_allowed(&source_path) {
                return protocol_error(id, "unauthorized_scope", "Access denied");
            }
        }
        let Ok(source_meta) = std::fs::symlink_metadata(&source_path) else {
            return protocol_error(id, "not_found", "source file not found");
        };
        if source_meta.file_type().is_symlink() || !source_meta.is_file() {
            return protocol_error(id, "invalid_args", "Source must be a regular file");
        }
        if source_meta.len() > MAX_DESKTOP_SAVE_BYTES {
            return protocol_error(id, "payload_too_large", "File is too large to save");
        }

        // Copy source to dest.
        if let Err(err) = std::fs::copy(&source_path, &dest_path) {
            return protocol_error(id, "io", &format!("Save failed: {err}"));
        }
        return protocol_ok(id, json!({ "ok": true, "destPath": dest_path_str }));
    }

    if let Some(data_b64) = args.get("data").and_then(Value::as_str) {
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_b64) else {
            return protocol_error(id, "invalid_args", "Invalid base64 data");
        };
        if bytes.len() as u64 > MAX_DESKTOP_SAVE_BYTES {
            return protocol_error(id, "payload_too_large", "File is too large to save");
        }
        if let Err(err) = std::fs::write(&dest_path, bytes) {
            return protocol_error(id, "io", &format!("Save failed: {err}"));
        }
        return protocol_ok(id, json!({ "ok": true, "destPath": dest_path_str }));
    }

    protocol_error(id, "invalid_args", "sourcePath or data is required")
}

// Render a DOCX via the fixed management tree, from an already-authorized handle.
pub fn handle_docx_preview(state: &IpcHostState, id: &str, args: &Value) -> Value {
    let handle = args.get("handle").and_then(Value::as_str).unwrap_or_default();
    let (bytes, length) = match state.resources.read(handle, "", Some((0, CHAT_ATTACHMENT_EXTRACT_MAX_BYTES as u64))) {
        resource_protocol::ResourceResponse::Ok { bytes, total_len, .. } => (bytes, total_len),
        _ => return protocol_error(id, "unauthorized_scope", "Invalid resource handle"),
    };
    if length == 0 || length > CHAT_ATTACHMENT_EXTRACT_MAX_BYTES as u64 {
        return protocol_error(id, "payload_too_large", "DOCX too large for preview (>10MB)");
    }
    let dir = match tempfile::tempdir() { Ok(dir) => dir, Err(error) => return protocol_error(id, "io", &error.to_string()) };
    let path = dir.path().join("preview.docx");
    if let Err(error) = std::fs::write(&path, bytes) { return protocol_error(id, "io", &error.to_string()); }
    match crate::pi_ipc::management_call(state, "docx.renderHtml", json!({ "path": path })) {
        Ok(value) => protocol_ok(id, value),
        Err((code, message)) => protocol_error(id, &code, &message),
    }
}

// ---------------------------------------------------------------------------
// chats.extractAttachmentText
// ---------------------------------------------------------------------------

pub fn handle_chats_extract_attachment_text(state: &IpcHostState, id: &str, args: &Value) -> Value {
    let data_b64 = args.get("data").and_then(Value::as_str).unwrap_or("");
    if data_b64.is_empty() {
        return protocol_error(id, "invalid_args", "not-text");
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_b64) else {
        return protocol_error(id, "invalid_args", "not-text");
    };
    if bytes.is_empty() {
        return protocol_error(id, "invalid_args", "not-text");
    }
    if bytes.len() > CHAT_ATTACHMENT_EXTRACT_MAX_BYTES {
        return protocol_error(id, "payload_too_large", "too-large");
    }

    // Binary input path is host-created, authorized, and cleaned up in a temp directory.
    let tmp_dir = match tempfile::tempdir() {
        Ok(dir) => dir,
        Err(err) => return protocol_error(id, "io", &format!("failed to create temp directory: {err}")),
    };
    let tmp_file = tmp_dir.path().join("attachment.docx");
    if let Err(err) = std::fs::write(&tmp_file, &bytes) {
        return protocol_error(id, "io", &format!("failed to write temp file: {err}"));
    }

    let call_args = json!({
        "path": tmp_file.display().to_string(),
    });

    let res = crate::pi_ipc::management_call(state, "docx.extractText", call_args);
    // tmp_dir is automatically dropped and deleted here upon return

    match res {
        Ok(val) => {
            if let Some(text) = val.get("text").and_then(Value::as_str) {
                protocol_ok(id, json!({ "text": text }))
            } else {
                protocol_error(id, "unprocessable", "not-text")
            }
        }
        Err((code, message)) => {
            if code == "management_unavailable" {
                protocol_error(id, "management_unavailable", &message)
            } else if message.contains("too-large") {
                protocol_error(id, "payload_too_large", "too-large")
            } else if message.contains("not-text") {
                protocol_error(id, "unprocessable", "not-text")
            } else {
                protocol_error(id, &code, &message)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// chats.revealFolder
// ---------------------------------------------------------------------------

pub fn handle_chats_reveal_folder(state: &IpcHostState, id: &str, args: &Value) -> Value {
    let session_id = args.get("sessionId").and_then(Value::as_str).unwrap_or("").trim();
    if session_id.is_empty() {
        return protocol_error(id, "invalid_args", "sessionId-required");
    }

    let agent_dir = state.agent_dir();
    let cwd_path: Option<PathBuf> = {
        let live = state.registry.get(session_id);
        if let Some(session) = live {
            Some(session.cwd.clone())
        } else {
            session_host::history::find_session_by_id(&agent_dir, session_id).map(|s| PathBuf::from(s.cwd))
        }
    };

    let Some(cwd_path) = cwd_path else {
        return protocol_error(id, "not_found", "session not found");
    };

    // Verify it is a chat folder (a direct child of agent_dir/chats).
    let chats_root = agent_dir.join("chats");
    let is_chat_folder = cwd_path.parent().map(|p| p == chats_root).unwrap_or(false)
        && cwd_path != chats_root;

    if !is_chat_folder {
        return protocol_error(id, "invalid_args", "not-a-chat-folder");
    }

    if !cwd_path.exists() {
        return protocol_error(id, "not_found", "not-found");
    }

    if let Err(err) = crate::reveal_path_in_file_manager(&cwd_path) {
        return protocol_error(id, "io", &err);
    }

    protocol_ok(id, json!({ "opened": true }))
}

// ---------------------------------------------------------------------------
// chats.revealDownload
// ---------------------------------------------------------------------------

pub fn handle_chats_reveal_download(id: &str, args: &Value) -> Value {
    let path_str = args.get("path").and_then(Value::as_str).unwrap_or("").trim();
    if path_str.is_empty() {
        return protocol_error(id, "invalid_args", "path-required");
    }

    let target = PathBuf::from(path_str);
    let Ok(canonical_target) = std::fs::canonicalize(&target) else {
        return protocol_error(id, "not_found", "not-found");
    };

    let downloads_dir = std::env::var("XDG_DOWNLOAD_DIR")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(|h| PathBuf::from(h).join("Downloads")))
        .unwrap_or_else(|| PathBuf::from("/tmp"));

    let Ok(canonical_downloads) = std::fs::canonicalize(&downloads_dir) else {
        return protocol_error(id, "unauthorized_scope", "access-denied");
    };

    if !canonical_target.starts_with(&canonical_downloads) {
        return protocol_error(id, "unauthorized_scope", "access-denied");
    }

    if let Err(err) = crate::reveal_path_in_file_manager(&canonical_target) {
        return protocol_error(id, "io", &err);
    }

    protocol_ok(id, json!({ "opened": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(unix)]
    fn fake_git(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-git");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn git_output_limit_preserves_only_complete_items_and_reaps() {
        let dir = tempdir().unwrap();
        let script = fake_git(dir.path(), "printf 'one\\000two\\000unfinished'; while :; do printf 'xxxxxxxxxxxxxxxx'; done");
        let root = std::fs::File::open(dir.path()).unwrap();
        let owner = crate::index_children::IndexChildOwner::default();
        let (files, truncated, cleanup_unknown) = collect_git_command(&root, &owner, script.as_os_str(), 64, Duration::from_secs(2)).unwrap().unwrap();
        assert!(!cleanup_unknown);
        assert_eq!(files, ["one", "two"]);
        assert!(truncated);
        let report = owner.shutdown_until(Instant::now() + Duration::from_secs(2));
        assert_eq!(report.unknown, 0, "{report:?}");
        assert!(!report.tracker_busy);
    }

    #[cfg(unix)]
    #[test]
    fn git_invalid_utf8_path_is_not_reported_as_complete() {
        let dir = tempdir().unwrap();
        let root = std::fs::File::open(dir.path()).unwrap();
        let owner = crate::index_children::IndexChildOwner::default();
        let script = fake_git(dir.path(), "printf '\\377\\000ok\\000'");
        let (files, truncated, cleanup_unknown) = collect_git_command(&root, &owner, script.as_os_str(), 1024, Duration::from_secs(2)).unwrap().unwrap();
        assert_eq!(files, ["ok"]);
        assert!(truncated);
        assert!(!cleanup_unknown);
    }

    #[cfg(unix)]
    #[test]
    fn git_timeout_and_nonzero_exit_reap_direct_child() {
        let dir = tempdir().unwrap();
        let root = std::fs::File::open(dir.path()).unwrap();
        let owner = crate::index_children::IndexChildOwner::default();
        let script = fake_git(dir.path(), "printf 'ok\\000'; while :; do printf 'stderr noise' >&2; done");
        let (files, truncated, _cleanup_unknown) = collect_git_command(&root, &owner, script.as_os_str(), 1024, Duration::from_millis(80)).unwrap().unwrap();
        assert_eq!(files, ["ok"]);
        assert!(truncated);
        std::fs::write(&script, "#!/bin/sh\nexit 7\n").unwrap();
        assert!(collect_git_command(&root, &owner, script.as_os_str(), 1024, Duration::from_secs(2)).unwrap().is_none());
        let report = owner.shutdown_until(Instant::now() + Duration::from_secs(2));
        assert_eq!(report.unknown, 0, "{report:?}");
        assert!(!report.tracker_busy);
    }

    #[cfg(unix)]
    #[test]
    fn files_index_bounds_fake_git_output_in_actual_consumer() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let script = fake_git(dir.path(), &format!("while :; do printf '{}\\000'; done", "x".repeat(512)));
        let state = setup_state(&repo);
        *state.index_git_executable.lock().unwrap() = Some(script);
        let result = handle_files_index(&state, "large", &json!({"cwd": repo}));
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["data"]["truncated"], true);
        assert!(!result["data"]["files"].as_array().unwrap().is_empty());
        assert_eq!(state.index_children.shutdown_until(Instant::now() + Duration::from_secs(2)).unknown, 0);
    }

    #[cfg(unix)]
    #[test]
    fn different_roots_do_not_wait_for_slow_git_cache_fill() {
        use std::sync::Arc;
        let dir = tempdir().unwrap();
        let slow = dir.path().join("slow"); let fast = dir.path().join("fast");
        std::fs::create_dir(&slow).unwrap(); std::fs::create_dir(&fast).unwrap();
        std::fs::write(slow.join("slow"), b"").unwrap();
        let script = fake_git(dir.path(), "if [ -f slow ]; then printf x > started; while :; do :; done; else printf 'quick\\000'; fi");
        let state = Arc::new(setup_state(dir.path()));
        *state.index_git_executable.lock().unwrap() = Some(script);
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || handle_files_index(&worker_state, "slow", &json!({"cwd": slow})));
        let until = Instant::now() + Duration::from_secs(2);
        while !dir.path().join("slow/started").exists() && Instant::now() < until { std::thread::sleep(Duration::from_millis(5)); }
        let started = dir.path().join("slow/started").exists();
        let now = Instant::now();
        let answer = handle_files_index(&state, "fast", &json!({"cwd": fast}));
        let elapsed = now.elapsed();
        state.index_children.begin_shutdown();
        let slow_answer = worker.join().unwrap();
        let report = state.index_children.shutdown_until(Instant::now() + Duration::from_secs(2));
        assert!(started);
        assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        assert_eq!(answer["data"]["files"][0], "quick");
        assert_eq!(slow_answer["data"]["truncated"], true);
        assert_eq!(report.unknown, 0, "{report:?}");
    }

    #[cfg(unix)]
    #[test]
    fn index_query_reports_directory_derivation_budget_exhaustion() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempdir().unwrap();
        let state = setup_state(dir.path());
        let meta = std::fs::metadata(dir.path()).unwrap();
        let key = format!("{}:{}:{}", dir.path().display(), meta.dev(), meta.ino());
        let files = (0..12000).map(|n| format!("{n:05}/a/b/c/d/e/f/g/h/needle")).collect();
        state.file_index_cache.lock().unwrap().insert(key, CachedFileIndex { files, hard_truncated: false, expires_at: Instant::now() + CACHE_TTL });
        let answer = handle_files_index(&state, "query", &json!({"cwd": dir.path(), "q": "needle"}));
        assert_eq!(answer["ok"], true, "{answer}");
        assert_eq!(answer["data"]["truncated"], true);
        assert!(!answer["data"]["matches"].as_array().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn index_cache_budget_is_enforced_across_actual_root_scans() {
        let dir = tempdir().unwrap();
        let script = fake_git(dir.path(), &format!("i=0; while [ $i -lt 10000 ]; do printf '{}\\000'; i=$((i+1)); done", "x".repeat(900)));
        let state = setup_state(dir.path());
        *state.index_git_executable.lock().unwrap() = Some(script);
        for n in 0..5 {
            let root = dir.path().join(format!("root-{n}"));
            std::fs::create_dir(&root).unwrap();
            let result = handle_files_index(&state, "root", &json!({"cwd": root}));
            assert_eq!(result["ok"], true, "{result}");
            let cache = state.file_index_cache.lock().unwrap();
            let bytes: usize = cache.iter().map(|(key, value)| cached_index_bytes(key, value)).sum();
            assert!(bytes <= CACHE_MAX_BYTES, "{bytes}");
            assert!(cache.len() <= CACHE_MAX_ENTRIES);
        }
        let report = state.index_children.shutdown_until(Instant::now() + Duration::from_secs(2));
        assert_eq!(report.unknown, 0, "{report:?}");
    }

    #[test]
    fn derived_and_encoded_response_budgets_report_partial() {
        let files = vec!["a/b/c/d/e/file".to_string(), "another".to_string()];
        let (entries, truncated) = derive_entries_bounded(&files, 300);
        assert!(truncated);
        assert!(entries.len() < 6);
        let escaped = vec!["\n".repeat(100), "ok".to_string()];
        assert_eq!(response_prefix_len(escaped.iter().map(|path| encoded_path_bytes(path)), 200), 0);
        for text in ["simple", "a\u{0}\t\n\\\"", "目录/文件"] {
            assert_eq!(encoded_path_bytes(text), serde_json::to_string(text).unwrap().len());
        }
    }

    #[test]
    fn file_walk_path_budget_is_cumulative_and_marks_truncation() {
        let mut budget = FileWalkBudget::new((), 20, 10);
        budget.path_byte_limit = 5;
        assert!(budget.record_path("abc"));
        assert!(budget.record_path("de"));
        assert!(!budget.record_path("x"));
        assert!(budget.truncated);
    }

    #[cfg(unix)]
    #[test]
    fn file_walk_returns_partial_when_path_bytes_exhausted() {
        let dir = tempdir().unwrap();
        for name in ["aaaa", "bbbb", "cccc"] { std::fs::write(dir.path().join(name), b"").unwrap(); }
        let root = std::fs::File::open(dir.path()).unwrap();
        let (files, truncated) = collect_files_with_walk_limits(&root, 100, 10, 8);
        assert!(truncated);
        assert_eq!(files.len(), 2);
    }

    #[test]
    fn cached_index_bytes_counts_allocated_capacity() {
        let key = String::with_capacity(100);
        let mut files = Vec::with_capacity(10);
        files.push(String::with_capacity(200));
        let entry = CachedFileIndex { files, hard_truncated: false, expires_at: Instant::now() };
        assert!(cached_index_bytes(&key, &entry) >= 100 + 200 + 10 * std::mem::size_of::<String>());
    }

    #[cfg(unix)]
    #[test]
    fn files_index_scans_when_cache_lock_is_busy() {
        let tmp = tempdir().unwrap();
        std::fs::write(tmp.path().join("fixture.txt"), b"fixture").unwrap();
        let state = setup_state(tmp.path());
        let guard = state.file_index_cache.lock().unwrap();
        let response = handle_files_index(&state, "busy", &json!({"cwd": tmp.path()}));
        assert_eq!(response["ok"], true, "{response}");
        assert!(response["data"]["files"].as_array().unwrap().iter().any(|file| file == "fixture.txt"));
        drop(guard);
    }

    #[test]
    fn file_walk_budget_bounds_wide_empty_directories_and_drops_handles() {
        use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
        struct Handle(Arc<AtomicUsize>);
        impl Drop for Handle { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); } }
        let live = Arc::new(AtomicUsize::new(1));
        let mut budget = FileWalkBudget::new(Handle(Arc::clone(&live)), 20, 3);
        let root = budget.pop().unwrap();
        budget.record(10, false);
        let mut opened = 0;
        for _ in 0..10 {
            budget.enqueue(|| -> Result<_, ()> {
                opened += 1;
                live.fetch_add(1, Ordering::SeqCst);
                Ok(Handle(Arc::clone(&live)))
            }).unwrap();
        }
        assert_eq!(opened, 3, "queue limit is checked before opening");
        assert_eq!(budget.pending.len(), 3);
        assert!(budget.truncated);
        drop(root);
        drop(budget);
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn file_walk_budget_bounds_deep_nodes_and_releases_on_cancel() {
        use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
        struct Handle(Arc<AtomicUsize>);
        impl Drop for Handle { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); } }
        let live = Arc::new(AtomicUsize::new(1));
        let mut budget = FileWalkBudget::new(Handle(Arc::clone(&live)), 4, 2);
        for _ in 0..4 {
            let handle = budget.pop().unwrap();
            budget.record(1, false);
            budget.enqueue(|| -> Result<_, ()> { live.fetch_add(1, Ordering::SeqCst); Ok(Handle(Arc::clone(&live))) }).unwrap();
            drop(handle);
        }
        assert_eq!(budget.visited, 4);
        assert!(budget.truncated);
        assert!(budget.pending.is_empty());
        drop(budget);
        assert_eq!(live.load(Ordering::SeqCst), 0);

        live.store(1, Ordering::SeqCst);
        let mut budget = FileWalkBudget::new(Handle(Arc::clone(&live)), 10, 2);
        let active = budget.pop().unwrap();
        budget.enqueue(|| -> Result<_, ()> { live.fetch_add(1, Ordering::SeqCst); Ok(Handle(Arc::clone(&live))) }).unwrap();
        assert!(budget.enqueue(|| -> Result<Handle, &str> { Err("cancelled") }).is_err());
        drop(active);
        drop(budget);
        assert_eq!(live.load(Ordering::SeqCst), 0);

        live.store(1, Ordering::SeqCst);
        let result = std::panic::catch_unwind({
            let live = Arc::clone(&live);
            move || {
                let mut budget = FileWalkBudget::new(Handle(Arc::clone(&live)), 10, 2);
                budget.enqueue(|| -> Result<_, ()> { live.fetch_add(1, Ordering::SeqCst); Ok(Handle(Arc::clone(&live))) }).unwrap();
                panic!("cancelled fixture");
            }
        });
        assert!(result.is_err());
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }

    #[cfg(unix)]
    #[test]
    fn file_walk_returns_partial_when_directory_queue_is_full() {
        let temp = tempdir().unwrap();
        for n in 0..(WALK_MAX_PENDING_DIRECTORIES + 8) {
            let child = temp.path().join(format!("directory-{n}"));
            std::fs::create_dir(&child).unwrap();
            std::fs::write(child.join("file.txt"), b"fixture").unwrap();
        }
        let root = std::fs::File::open(temp.path()).unwrap();
        let (files, truncated) = collect_files_with_walk(&root);
        assert!(truncated);
        assert_eq!(files.len(), WALK_MAX_PENDING_DIRECTORIES);
        assert!(files.iter().all(|path| path.ends_with("/file.txt")));
    }

    #[cfg(unix)]
    #[test]
    fn file_walk_directory_enumeration_reports_exact_limit_and_overflow() {
        let temp = tempdir().unwrap();
        for n in 0..3 { std::fs::create_dir(temp.path().join(format!("empty-{n}"))).unwrap(); }
        let root = std::fs::File::open(temp.path()).unwrap();
        let (partial, more) = crate::file_access::file_directory_unix::directory_entries_bounded(&root, 2).unwrap();
        assert_eq!(partial.len(), 2);
        assert!(more);
        let (exact, more) = crate::file_access::file_directory_unix::directory_entries_bounded(&root, 3).unwrap();
        assert_eq!(exact.len(), 3);
        assert!(!more);
        let (none, more) = crate::file_access::file_directory_unix::directory_entries_bounded(&root, 0).unwrap();
        assert!(none.is_empty());
        assert!(more);
    }

    #[cfg(unix)]
    #[test]
    fn file_walk_counts_empty_directories_against_node_budget() {
        let temp = tempdir().unwrap();
        for n in 0..12 { std::fs::create_dir(temp.path().join(format!("empty-{n}"))).unwrap(); }
        let root = std::fs::File::open(temp.path()).unwrap();
        let (files, truncated) = collect_files_with_walk_limits(&root, 5, 10, WALK_MAX_PATH_BYTES);
        assert!(files.is_empty());
        assert!(truncated);
    }

    #[cfg(windows)]
    #[test]
    fn windows_index_returns_partial_when_directory_queue_is_full() {
        let temp = tempdir().unwrap();
        for n in 0..(WALK_MAX_PENDING_DIRECTORIES + 8) {
            let child = temp.path().join(format!("directory-{n}"));
            std::fs::create_dir(&child).unwrap();
            std::fs::write(child.join("file.txt"), b"fixture").unwrap();
        }
        let state = setup_state(temp.path());
        let result = handle_files_index(&state, "fixture", &json!({"cwd":temp.path()}));
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["data"]["truncated"], true);
        assert_eq!(result["data"]["files"].as_array().unwrap().len(), WALK_MAX_PENDING_DIRECTORIES);
    }

    fn setup_state(allowed_root: &Path) -> IpcHostState {
        let state = IpcHostState::new();
        state.file_roots.lock().unwrap().add(allowed_root).expect("fixture root");
        state
    }

    #[test]
    fn test_files_index_validations() {
        let tmp = tempdir().unwrap();
        let state = setup_state(tmp.path());

        // Relative path rejected
        let res = handle_files_index(&state, "1", &json!({ "cwd": "relative/path" }));
        assert_eq!(res["ok"], false);
        assert_eq!(res["error"]["code"], "invalid_args");

        // Out of roots rejected
        let res = handle_files_index(&state, "2", &json!({ "cwd": "/etc" }));
        assert_eq!(res["ok"], false);
        assert_eq!(res["error"]["code"], "unauthorized_scope");

        // Missing directory rejected
        let missing = tmp.path().join("missing_dir");
        state.file_roots.lock().unwrap().add_missing(&missing);
        let res = handle_files_index(
            &state,
            "3",
            &json!({ "cwd": missing.display().to_string() }),
        );
        assert_eq!(res["ok"], false);
        assert_eq!(res["error"]["code"], "not_found");

        // File path instead of directory rejected
        let file = tmp.path().join("file.txt");
        std::fs::write(&file, "hello").unwrap();
        assert!(state.file_roots.lock().unwrap().add(&file).is_err());
        let res = handle_files_index(
            &state,
            "4",
            &json!({ "cwd": file.display().to_string() }),
        );
        assert_eq!(res["ok"], false);
        assert_eq!(res["error"]["code"], "invalid_args");
    }

    #[test]
    fn test_files_index_listing_and_fuzzy_search() {
        let tmp = tempdir().unwrap();
        let state = setup_state(tmp.path());

        // Create structure:
        // - src/main.rs
        // - src/chat/input.rs
        // - src/chat/window.rs
        // - README.md
        let src = tmp.path().join("src");
        let chat = src.join("chat");
        std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(src.join("main.rs"), "fn main() {}").unwrap();
        std::fs::write(chat.join("input.rs"), "input").unwrap();
        std::fs::write(chat.join("window.rs"), "window").unwrap();
        std::fs::write(tmp.path().join("README.md"), "# Readme").unwrap();

        // 1. Without query: full list capped, directories derived
        let res = handle_files_index(
            &state,
            "list",
            &json!({ "cwd": tmp.path().display().to_string() }),
        );
        assert_eq!(res["ok"], true);
        let files = res["data"]["files"].as_array().unwrap();
        assert_eq!(files.len(), 4);
        assert_eq!(res["data"]["truncated"], false);

        // 2. Fuzzy query matching:
        // "input" should rank `src/chat/input.rs` first
        let res_input = handle_files_index(
            &state,
            "q1",
            &json!({ "cwd": tmp.path().display().to_string(), "q": "input" }),
        );
        assert_eq!(res_input["ok"], true);
        let matches = res_input["data"]["matches"].as_array().unwrap();
        assert!(!matches.is_empty());
        assert_eq!(matches[0]["path"], "src/chat/input.rs");
        assert_eq!(matches[0]["isDir"], false);

        // Query with "/": "src/chat"
        let res_slash = handle_files_index(
            &state,
            "q2",
            &json!({ "cwd": tmp.path().display().to_string(), "q": "src/chat" }),
        );
        assert_eq!(res_slash["ok"], true);
        let matches_slash = res_slash["data"]["matches"].as_array().unwrap();
        assert!(!matches_slash.is_empty());
        assert_eq!(matches_slash[0]["path"], "src/chat");
        assert_eq!(matches_slash[0]["isDir"], true);

        // Subsequence: "rmd" matches "README.md"
        let res_sub = handle_files_index(
            &state,
            "q3",
            &json!({ "cwd": tmp.path().display().to_string(), "q": "rmd" }),
        );
        assert_eq!(res_sub["ok"], true);
        let matches_sub = res_sub["data"]["matches"].as_array().unwrap();
        assert!(!matches_sub.is_empty());
        assert_eq!(matches_sub[0]["path"], "README.md");
    }

    #[cfg(unix)]
    #[test]
    fn test_desktop_describe_paths() {
        let tmp = tempdir().unwrap();
        let file = tmp.path().join("test.png");
        std::fs::write(&file, b"\x89PNG\r\n\x1a\nfake png data").unwrap();
        let sub = tmp.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let missing = tmp.path().join("missing.txt");

        #[cfg(unix)]
        let link = tmp.path().join("link_to_file");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&file, &link).unwrap();

        let paths = vec![
            file.display().to_string(),
            sub.display().to_string(),
            missing.display().to_string(),
            #[cfg(unix)]
            link.display().to_string(),
            "relative/path".to_string(),
        ];

        let state = setup_state(tmp.path());
        state.native_drops.register(&state, &[file.clone(), sub.clone(), missing.clone(), link.clone()]);
        let res = handle_desktop_describe_paths(&state, "d1", &json!({ "paths": paths }));
        assert_eq!(res["ok"], true);
        let items = res["data"]["items"].as_array().unwrap();
        assert_eq!(items.len(), if cfg!(unix) { 5 } else { 4 });

        // First item: file, imageMime image/png
        assert_eq!(items[0]["kind"], "file");
        assert_eq!(items[0]["imageMime"], "image/png");
        assert_eq!(items[0]["size"].as_u64().unwrap(), 21);

        // Second item: directory
        assert_eq!(items[1]["kind"], "directory");

        // Unrecognized paths reveal no filesystem metadata.
        assert_eq!(items[2]["kind"], "other");

        #[cfg(unix)]
        // Fourth item: symlink is reported as other
        assert_eq!(items[3]["kind"], "other");

        // Last item: relative is other
        let last = items.last().unwrap();
        assert_eq!(last["kind"], "other");
    }

    #[cfg(unix)]
    #[test]
    fn test_desktop_read_images() {
        let tmp = tempdir().unwrap();
        let png = tmp.path().join("pic.png");
        let png_bytes = b"\x89PNG\r\n\x1a\nsome png bytes";
        std::fs::write(&png, png_bytes).unwrap();

        let txt = tmp.path().join("text.txt");
        std::fs::write(&txt, b"hello").unwrap();

        let state = setup_state(tmp.path());
        let denied = handle_desktop_read_images(&state, "unauthorized", &json!({ "paths": [png.display().to_string()] }));
        assert_eq!(denied["error"]["code"], "unauthorized_scope");
        state.native_drops.register(&state, &[png.clone(), txt.clone(), tmp.path().to_path_buf()]);
        // 1. Valid image read
        let res = handle_desktop_read_images(&state, "r1", &json!({ "paths": [png.display().to_string()] }));
        assert_eq!(res["ok"], true);
        let files = res["data"]["files"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["name"], "pic.png");
        assert_eq!(files[0]["mimeType"], "image/png");
        let b64 = files[0]["data"].as_str().unwrap();
        let decoded = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        assert_eq!(decoded, png_bytes);

        // 2. Non-image rejected
        let res_txt = handle_desktop_read_images(&state, "r2", &json!({ "paths": [txt.display().to_string()] }));
        assert_eq!(res_txt["ok"], false);
        assert_eq!(res_txt["error"]["code"], "invalid_args");
        assert!(res_txt["error"]["message"].as_str().unwrap().contains("Not an image"));

        // 3. Directory rejected
        let res_dir = handle_desktop_read_images(&state, "r3", &json!({ "paths": [tmp.path().display().to_string()] }));
        assert_eq!(res_dir["ok"], false);
        assert_eq!(res_dir["error"]["code"], "unauthorized_scope");

        // 4. Empty selection rejected
        let res_empty = handle_desktop_read_images(&state, "r4", &json!({ "paths": [] }));
        assert_eq!(res_empty["ok"], false);
        assert_eq!(res_empty["error"]["code"], "invalid_args");
    }

    #[test]
    fn test_desktop_save_file() {
        let tmp = tempdir().unwrap();
        let state = setup_state(tmp.path());

        let source = tmp.path().join("source.txt");
        std::fs::write(&source, b"hello save").unwrap();
        let dest = tmp.path().join("dest.txt");

        // 1. Save without authorization fails
        let res_unauth = handle_desktop_save_file(
            &state,
            "s1",
            &json!({
                "sourcePath": source.display().to_string(),
                "destPath": dest.display().to_string(),
            }),
        );
        assert_eq!(res_unauth["ok"], false);
        assert_eq!(res_unauth["error"]["code"], "unauthorized_scope");

        // 2. Authorize destination (pseudo dialog selection) and save sourcePath
        state.authorize_save_destination(&dest, Duration::from_secs(60));
        let res_ok = handle_desktop_save_file(
            &state,
            "s2",
            &json!({
                "sourcePath": source.display().to_string(),
                "destPath": dest.display().to_string(),
            }),
        );
        assert_eq!(res_ok["ok"], true);
        assert_eq!(std::fs::read(&dest).unwrap(), b"hello save");

        // 3. Second save to same dest without re-authorization fails (single-use consumption)
        let res_consumed = handle_desktop_save_file(
            &state,
            "s3",
            &json!({
                "sourcePath": source.display().to_string(),
                "destPath": dest.display().to_string(),
            }),
        );
        assert_eq!(res_consumed["ok"], false);
        assert_eq!(res_consumed["error"]["code"], "unauthorized_scope");

        // 4. Save raw base64 data to authorized dest
        let dest_data = tmp.path().join("dest_data.txt");
        state.authorize_save_destination(&dest_data, Duration::from_secs(60));
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"hello bytes");
        let res_data = handle_desktop_save_file(
            &state,
            "s4",
            &json!({
                "destPath": dest_data.display().to_string(),
                "data": b64,
            }),
        );
        assert_eq!(res_data["ok"], true);
        assert_eq!(std::fs::read(&dest_data).unwrap(), b"hello bytes");
    }

    #[test]
    fn test_chats_extract_attachment_text() {
        let tmp = tempdir().unwrap();
        let state = setup_state(tmp.path());

        // 1. Empty data rejected before management invocation
        let res_empty = handle_chats_extract_attachment_text(&state, "e1", &json!({ "data": "" }));
        assert_eq!(res_empty["ok"], false);
        assert_eq!(res_empty["error"]["message"], "not-text");

        // 2. Unconfigured management answers management_unavailable
        let bad_b64 = base64::engine::general_purpose::STANDARD.encode(b"not a docx at all");
        let res_unconfigured = handle_chats_extract_attachment_text(&state, "e2", &json!({ "data": bad_b64 }));
        assert_eq!(res_unconfigured["ok"], false);
        assert_eq!(res_unconfigured["error"]["code"], "management_unavailable");
    }

    #[test]
    fn test_chats_reveal_folder() {
        let tmp = tempdir().unwrap();
        let state = setup_state(tmp.path());
        *state.task_agent_dir.lock().unwrap() = Some(tmp.path().to_path_buf());

        // 1. Missing session id
        let res_missing = handle_chats_reveal_folder(&state, "f1", &json!({}));
        assert_eq!(res_missing["ok"], false);
        assert_eq!(res_missing["error"]["message"], "sessionId-required");

        // 2. Unknown session
        let res_unknown = handle_chats_reveal_folder(&state, "f2", &json!({ "sessionId": "unknown-123" }));
        assert_eq!(res_unknown["ok"], false);
        assert_eq!(res_unknown["error"]["code"], "not_found");
    }

    #[test]
    fn test_chats_reveal_download() {
        // 1. Missing path
        let res_missing = handle_chats_reveal_download("d1", &json!({}));
        assert_eq!(res_missing["ok"], false);
        assert_eq!(res_missing["error"]["message"], "path-required");

        // 2. Missing file
        let res_not_found = handle_chats_reveal_download("d2", &json!({ "path": "/nonexistent/path/123.txt" }));
        assert_eq!(res_not_found["ok"], false);
        assert_eq!(res_not_found["error"]["code"], "not_found");
    }
}
