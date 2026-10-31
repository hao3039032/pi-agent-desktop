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
pub const MAX_WALK_DEPTH: usize = 8;
pub const MAX_QUERY_LENGTH: usize = 500;
pub const CACHE_TTL: Duration = Duration::from_secs(10);
pub const CACHE_MAX_ENTRIES: usize = 20;
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

fn collect_files_with_git(cwd: &Path) -> Option<(Vec<String>, bool)> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .env("LC_ALL", "C")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = output.stdout;
    let mut files = Vec::new();
    let mut hard_truncated = false;
    for chunk in stdout.split(|&b| b == 0) {
        if chunk.is_empty() {
            continue;
        }
        let Ok(text) = std::str::from_utf8(chunk) else {
            continue;
        };
        if text == ".git" || text.starts_with(".git/") || text == ".DS_Store" {
            continue;
        }
        files.push(text.to_string());
        if files.len() >= GIT_HARD_CAP {
            hard_truncated = true;
            break;
        }
    }
    Some((files, hard_truncated))
}

fn collect_files_with_walk(cwd: &Path) -> (Vec<String>, bool) {
    let mut files = Vec::new();
    let mut hard_truncated = false;
    let mut queue: std::collections::VecDeque<(PathBuf, String, usize)> = std::collections::VecDeque::new();
    queue.push_back((cwd.to_path_buf(), String::new(), 0));

    while let Some((abs, rel, depth)) = queue.pop_front() {
        let Ok(read_dir) = std::fs::read_dir(&abs) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_hidden_outside_git(&name) {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let child_abs = entry.path();
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
            if is_dir {
                if depth + 1 <= MAX_WALK_DEPTH {
                    queue.push_back((child_abs, child_rel, depth + 1));
                }
            } else {
                files.push(child_rel);
                if files.len() >= WALK_HARD_CAP {
                    hard_truncated = true;
                    return (files, hard_truncated);
                }
            }
        }
    }
    (files, hard_truncated)
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

pub fn derive_entries_from_files(files: &[String]) -> Vec<FileIndexEntry> {
    let mut dirs = HashSet::new();
    for f in files {
        let mut idx = f.find('/');
        while let Some(i) = idx {
            dirs.insert(f[..i].to_string());
            idx = f[i + 1..].find('/').map(|n| n + i + 1);
        }
    }
    let mut entries = Vec::with_capacity(dirs.len() + files.len());
    for d in dirs {
        entries.push(FileIndexEntry { path: d, is_dir: true });
    }
    for f in files {
        if !f.is_empty() {
            entries.push(FileIndexEntry { path: f.clone(), is_dir: false });
        }
    }
    entries.sort_by(|a, b| {
        path_depth(&a.path)
            .cmp(&path_depth(&b.path))
            .then_with(|| a.path.cmp(&b.path))
    });
    entries
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
    {
        let roots = state.file_roots.lock().unwrap();
        if !roots.is_existing_path_allowed(&cwd_path) {
            return protocol_error(id, "unauthorized_scope", "Access denied");
        }
    }

    let query = args.get("q").and_then(Value::as_str).map(|q| {
        if q.len() > MAX_QUERY_LENGTH {
            &q[..MAX_QUERY_LENGTH]
        } else {
            q
        }
    });

    let match_limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|l| (l as usize).clamp(1, MAX_MATCH_LIMIT))
        .unwrap_or(DEFAULT_MATCH_LIMIT);

    // Retrieve or populate cache.
    let listing = {
        let mut cache = state.file_index_cache.lock().unwrap();
        let now = Instant::now();
        cache.retain(|_, v| v.expires_at > now);
        if let Some(entry) = cache.get(cwd_str) {
            entry.clone()
        } else {
            let (files, hard_truncated) = collect_files_with_git(&cwd_path)
                .unwrap_or_else(|| collect_files_with_walk(&cwd_path));
            if cache.len() >= CACHE_MAX_ENTRIES {
                cache.clear();
            }
            let entry = CachedFileIndex {
                files,
                hard_truncated,
                expires_at: now + CACHE_TTL,
            };
            cache.insert(cwd_str.to_string(), entry.clone());
            entry
        }
    };

    if let Some(q) = query {
        if !q.is_empty() {
            let all_entries = derive_entries_from_files(&listing.files);
            let matches = filter_file_entries(&all_entries, q, match_limit);
            return protocol_ok(id, json!({ "matches": matches }));
        }
    }

    let truncated = listing.hard_truncated || listing.files.len() > MAX_FILES;
    let files_slice: &[String] = if listing.files.len() > MAX_FILES {
        &listing.files[..MAX_FILES]
    } else {
        &listing.files
    };
    protocol_ok(
        id,
        json!({
            "files": files_slice,
            "truncated": truncated,
        }),
    )
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

    fn setup_state(allowed_root: &Path) -> IpcHostState {
        let state = IpcHostState::new();
        state.file_roots.lock().unwrap().add(allowed_root);
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
        state.file_roots.lock().unwrap().add(&missing);
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
        state.file_roots.lock().unwrap().add(&file);
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
