//! # resource-protocol — capability-less preview resource channel
//!
//! M0 PoC of the plan's media/scriptless preview channel (§六 资源通道).
//! The desktop WebView renders local media and scriptless HTML through a
//! custom `res://`-style protocol that has NO Tauri capability: requests are
//! answered from explicitly granted scopes only, and nothing in this
//! protocol can invoke app commands, read credentials or escape the granted
//! directory.
//!
//! Frozen semantics (all covered by tests):
//! - handles are random 128-bit tokens, never frontend-supplied paths;
//! - a grant names ONE file or directory (resolved and canonicalized at
//!   GRANT time; re-validated at REQUEST time — a symlink that changed
//!   target in between is refused);
//! - pinned directory grants serve only files opened component-by-component
//!   beneath the directory handle, refusing reparse points, parent traversal,
//!   absolute escapes and UNC tricks;
//! - MIME by extension, scriptless defaults (`.html` is served as data for
//!   an opaque sandbox; scripts never execute because the consuming iframe
//!   never gets both `allow-scripts` and `allow-same-origin`);
//! - HTTP-style Range support for media seeking: at most 16 MiB per response;
//!   large requests without Range are refused rather than silently truncated;
//! - at most four reads construct responses concurrently; the budget ends
//!   when `read` returns, not when Tauri/WebView finishes consuming its body;
//! - grants expire (TTL) and can be revoked explicitly; a read admitted
//!   before revocation may finish, and new requests are refused;
//! - unknown/malformed handles, expired grants and out-of-scope paths are
//!   plain rejections with stable reasons.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

#[cfg(windows)]
pub mod windows_handle;
#[cfg(all(test, windows))]
#[path = "windows_tests.rs"]
mod windows_tests;

/// The deferred image route's 10 MiB cap and a registry-wide decoded-memory budget.
pub const MAX_RESOURCE_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_RESOURCE_IMAGE_TOTAL_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_RESOURCE_HANDLES: usize = 1024;
/// Per-response and concurrent construction bounds. Native WebView buffering
/// after the handler returns is outside this budget.
pub const MAX_RESOURCE_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_CONCURRENT_RESOURCE_READS: usize = 4;

/// A random 128-bit handle token (hex, 32 chars).
pub type Handle = String;

/// Why a request was refused (stable, machine-readable).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyReason {
    UnknownHandle,
    Expired,
    OutOfScope,
    InvalidPath,
    NotFound,
    IoError,
    TooLarge,
    Busy,
}

/// The outcome of one resource read.
#[derive(Debug)]
pub enum ResourceResponse {
    /// Bytes with content info; `range_applied` tells whether the requested
    /// range was applied (206-style) or the whole body was returned.
    Ok {
        mime: &'static str,
        bytes: Vec<u8>,
        total_len: u64,
        range_applied: bool,
    },
    Denied(DenyReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    /// Exactly this file.
    File,
    /// This directory and everything below it.
    Directory,
}

struct Grant {
    /// The canonicalized path at grant time.
    canonical: PathBuf,
    scope: Scope,
    /// Re-validate against the CURRENT canonical path of the same location:
    /// a symlink/junction whose target moved is a different resource.
    original_target: PathBuf,
    expires_at: Instant,
    pinned_file: Option<std::fs::File>,
    pinned_directory: Option<std::fs::File>,
    image_bytes: Option<(std::sync::Arc<[u8]>, &'static str)>,
}

/// The registry of grants. `create` picks the handle; nothing else does.
pub struct ResourceRegistry {
    grants: Arc<Mutex<HashMap<Handle, Arc<Grant>>>>,
    active_reads: AtomicUsize,
}

impl Default for ResourceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ResourceRegistry {
    pub fn new() -> Self {
        let grants: Arc<Mutex<HashMap<Handle, Arc<Grant>>>> = Arc::new(Mutex::new(HashMap::new()));
        let weak = Arc::downgrade(&grants);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let Some(grants) = weak.upgrade() else { break };
            grants.lock().unwrap().retain(|_, grant| grant.expires_at > Instant::now());
        });
        Self { grants, active_reads: AtomicUsize::new(0) }
    }

    fn random_handle(&self) -> Result<Handle, DenyReason> {
        let mut seed = [0u8; 16];
        getrandom::fill(&mut seed).map_err(|_| DenyReason::IoError)?;
        Ok(seed.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    /// Grant access to one file. `path` is host-picked (a dialog result, an
    /// artifact location); never a frontend string.
    pub fn grant_file(&self, path: &Path, ttl: Duration) -> Result<Handle, DenyReason> {
        self.grant(path, Scope::File, ttl)
    }

    /// Grant access to a directory tree (a preview's asset folder).
    pub fn grant_directory(&self, path: &Path, ttl: Duration) -> Result<Handle, DenyReason> {
        self.grant(path, Scope::Directory, ttl)
    }

    fn grant(&self, path: &Path, scope: Scope, ttl: Duration) -> Result<Handle, DenyReason> {
        let canonical = std::fs::canonicalize(path).map_err(|_| DenyReason::NotFound)?;
        let metadata = std::fs::metadata(&canonical).map_err(|_| DenyReason::IoError)?;
        let matches_scope = match scope {
            Scope::File => metadata.is_file(),
            Scope::Directory => metadata.is_dir(),
        };
        if !matches_scope {
            return Err(DenyReason::InvalidPath);
        }
        let handle = self.random_handle()?;
        let mut grants = self.grants.lock().unwrap();
        grants.retain(|_, grant| grant.expires_at > Instant::now());
        if grants.len() >= MAX_RESOURCE_HANDLES { return Err(DenyReason::IoError); }
        grants.insert(
            handle.clone(),
            Arc::new(Grant {
                canonical: canonical.clone(),
                scope,
                original_target: canonical,
                expires_at: Instant::now() + ttl,
                pinned_file: None,
                pinned_directory: None,
                image_bytes: None,
            }),
        );
        Ok(handle)
    }

    /// Grant an already authorized and opened regular file, pinning its inode.
    pub fn grant_open_file(&self, file: std::fs::File, name: &Path, ttl: Duration) -> Result<Handle, DenyReason> {
        let metadata = file.metadata().map_err(|_| DenyReason::IoError)?;
        if !metadata.is_file() { return Err(DenyReason::InvalidPath); }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err(DenyReason::InvalidPath); }
        }
        let handle = self.random_handle()?;
        let mut grants = self.grants.lock().unwrap();
        grants.retain(|_, grant| grant.expires_at > Instant::now());
        if grants.len() >= MAX_RESOURCE_HANDLES { return Err(DenyReason::IoError); }
        grants.insert(handle.clone(), Arc::new(Grant {
            canonical: name.to_path_buf(), scope: Scope::File,
            original_target: name.to_path_buf(), expires_at: Instant::now() + ttl,
            pinned_file: Some(file), pinned_directory: None, image_bytes: None,
        }));
        Ok(handle)
    }

    /// Host-only grant for one already-authorized deferred raster image.
    /// There is deliberately no IPC operation accepting arbitrary bytes.
    pub fn grant_image_bytes(&self, bytes: Vec<u8>, mime: &str, ttl: Duration) -> Result<Handle, DenyReason> {
        let mime = match mime {
            "image/png" => "image/png", "image/jpeg" => "image/jpeg",
            "image/webp" => "image/webp", "image/gif" => "image/gif",
            "image/bmp" => "image/bmp", "image/avif" => "image/avif",
            _ => return Err(DenyReason::InvalidPath),
        };
        if bytes.is_empty() || bytes.len() > MAX_RESOURCE_IMAGE_BYTES { return Err(DenyReason::InvalidPath); }
        let handle = self.random_handle()?;
        let mut grants = self.grants.lock().unwrap();
        grants.retain(|_, grant| grant.expires_at > Instant::now());
        let used: usize = grants.values().filter_map(|grant| grant.image_bytes.as_ref()).map(|(bytes, _)| bytes.len()).sum();
        if grants.len() >= MAX_RESOURCE_HANDLES || used + bytes.len() > MAX_RESOURCE_IMAGE_TOTAL_BYTES { return Err(DenyReason::IoError); }
        grants.insert(handle.clone(), Arc::new(Grant {
            canonical: PathBuf::new(), original_target: PathBuf::new(), scope: Scope::File,
            expires_at: Instant::now() + ttl, pinned_file: None, pinned_directory: None,
            image_bytes: Some((bytes.into(), mime)),
        }));
        Ok(handle)
    }

    fn snapshot(&self, handle: &str) -> Result<Arc<Grant>, DenyReason> {
        let mut grants = self.grants.lock().unwrap();
        let grant = grants.get(handle).ok_or(DenyReason::UnknownHandle)?;
        if Instant::now() >= grant.expires_at {
            let expired = grants.remove(handle);
            drop(grants);
            drop(expired);
            return Err(DenyReason::Expired);
        }
        Ok(Arc::clone(grant))
    }

    /// Metadata of a pinned file for explicit live-change polling.
    pub fn file_metadata(&self, handle: &str) -> Result<(u64, String), DenyReason> {
        let grant = self.snapshot(handle)?;
        let file = grant.pinned_file.as_ref().ok_or(DenyReason::InvalidPath)?;
        let meta = file.metadata().map_err(|_| DenyReason::IoError)?;
        let modified = meta.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_nanos()).unwrap_or(0);
        #[cfg(unix)]
        let identity = { use std::os::unix::fs::MetadataExt; format!("{}:{}:{}:{}:{}", meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec(), modified) };
        #[cfg(not(unix))]
        let identity = modified.to_string();
        Ok((meta.len(), format!("{identity}:{}", meta.len())))
    }

    /// Share a live bounded raster grant for native save without copying bytes.
    pub fn clone_image_bytes(&self, handle: &str) -> Result<std::sync::Arc<[u8]>, DenyReason> {
        let grant = self.snapshot(handle)?;
        let (bytes, _) = grant.image_bytes.as_ref().ok_or(DenyReason::InvalidPath)?;
        Ok(std::sync::Arc::clone(bytes))
    }

    /// Duplicate a live single-file descriptor for an authorized native save.
    pub fn clone_open_file(&self, handle: &str) -> Result<std::fs::File, DenyReason> {
        let grant = self.snapshot(handle)?;
        let file = grant.pinned_file.as_ref().ok_or(DenyReason::InvalidPath)?;
        #[cfg(windows)]
        { windows_handle::reopen_file(file).map_err(|_| DenyReason::IoError) }
        #[cfg(not(windows))]
        { file.try_clone().map_err(|_| DenyReason::IoError) }
    }

    /// Grant a directory descriptor opened beneath an authorized root.
    #[cfg(any(unix, windows))]
    pub fn grant_open_directory(&self, directory: std::fs::File, ttl: Duration) -> Result<Handle, DenyReason> {
        let metadata = directory.metadata().map_err(|_| DenyReason::IoError)?;
        if !metadata.is_dir() { return Err(DenyReason::InvalidPath); }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err(DenyReason::InvalidPath); }
        }
        let handle = self.random_handle()?;
        let mut grants = self.grants.lock().unwrap();
        grants.retain(|_, grant| grant.expires_at > Instant::now());
        if grants.len() >= MAX_RESOURCE_HANDLES { return Err(DenyReason::IoError); }
        grants.insert(handle.clone(), Arc::new(Grant {
            canonical: PathBuf::new(), original_target: PathBuf::new(), scope: Scope::Directory,
            expires_at: Instant::now() + ttl, pinned_file: None, pinned_directory: Some(directory), image_bytes: None,
        }));
        Ok(handle)
    }

    /// Revoke a grant (the preview closed, the window went away).
    pub fn revoke(&self, handle: &str) -> bool {
        let removed = self.grants.lock().unwrap().remove(handle);
        removed.is_some()
    }

    /// Drop expired grants; returns how many were removed.
    pub fn sweep_expired(&self) -> usize {
        let mut grants = self.grants.lock().unwrap();
        let now = Instant::now();
        let before = grants.len();
        grants.retain(|_, grant| grant.expires_at > now);
        before - grants.len()
    }

    /// Serve one request. `subpath` is only legal for directory grants;
    /// empty for file grants. `range` is an optional inclusive byte range.
    pub fn read(
        &self,
        handle: &str,
        subpath: &str,
        range: Option<(u64, u64)>,
    ) -> ResourceResponse {
        self.read_inner(handle, subpath, range, || {})
    }

    // Snapshot first: a read admitted before revoke may finish, while every
    // later request observes revoke/expiry. No filesystem IO holds grants.
    fn read_inner(&self, handle: &str, subpath: &str, range: Option<(u64, u64)>, after_snapshot: impl FnOnce()) -> ResourceResponse {
        let grant = match self.snapshot(handle) {
            Ok(grant) => grant,
            Err(reason) => return ResourceResponse::Denied(reason),
        };
        let mut count = self.active_reads.load(Ordering::Acquire);
        loop {
            if count >= MAX_CONCURRENT_RESOURCE_READS { return ResourceResponse::Denied(DenyReason::Busy); }
            match self.active_reads.compare_exchange_weak(count, count + 1, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => break,
                Err(actual) => count = actual,
            }
        }
        let _permit = ReadPermit(&self.active_reads);
        after_snapshot();
        if let Some((bytes, mime)) = &grant.image_bytes {
            if !subpath.is_empty() { return ResourceResponse::Denied(DenyReason::InvalidPath); }
            let total_len = bytes.len() as u64;
            let (start, length, range_applied) = match bounded_range(total_len, range, mime) {
                Ok(bounds) => bounds,
                Err(reason) => return ResourceResponse::Denied(reason),
            };
            return ResourceResponse::Ok { mime, bytes: bytes[start as usize..(start + length) as usize].to_vec(), total_len, range_applied };
        }
        if let Some(file) = grant.pinned_file.as_ref() {
            if !subpath.is_empty() { return ResourceResponse::Denied(DenyReason::InvalidPath); }
            return read_open_file(file, &grant.canonical, range);
        }
        #[cfg(any(unix, windows))]
        if let Some(directory) = grant.pinned_directory.as_ref() {
            return match open_beneath_directory(directory, subpath) {
                Ok(file) => read_open_file(&file, Path::new(subpath), range),
                Err(_) => ResourceResponse::Denied(DenyReason::OutOfScope),
            };
        }
        // Re-validate the anchor itself: the canonical location must still
        // resolve to the SAME target (a replaced symlink is a different
        // resource — refuse rather than follow the new target).
        match std::fs::canonicalize(&grant.canonical) {
            Ok(current) if current == grant.original_target => {}
            _ => return ResourceResponse::Denied(DenyReason::OutOfScope),
        }

        let target: PathBuf = match grant.scope {
            Scope::File => {
                if !subpath.is_empty() {
                    return ResourceResponse::Denied(DenyReason::InvalidPath);
                }
                grant.canonical.clone()
            }
            Scope::Directory => {
                if subpath.is_empty() {
                    return ResourceResponse::Denied(DenyReason::InvalidPath);
                }
                // Containment FIRST, on the joined path, then canonicalize:
                // traversal segments never survive to the filesystem.
                if subpath.contains("..") || subpath.contains('\\') || subpath.starts_with('/') {
                    return ResourceResponse::Denied(DenyReason::InvalidPath);
                }
                let joined = grant.canonical.join(subpath);
                let canonical = match std::fs::canonicalize(&joined) {
                    Ok(path) => path,
                    Err(_) => return ResourceResponse::Denied(DenyReason::NotFound),
                };
                // Symlinked entries INSIDE the tree are followed, but the
                // result must still be inside the granted directory (an
                // in-tree symlink to /etc/passwd escapes — refuse).
                if !canonical.starts_with(&grant.canonical) {
                    return ResourceResponse::Denied(DenyReason::OutOfScope);
                }
                canonical
            }
        };

        // Read through a beneath-walk anchored at the GRANT's canonical
        // directory: openat(O_DIRECTORY|O_NOFOLLOW) per component, the file
        // itself O_NOFOLLOW — a component swapped for a symlink between the
        // containment check above and this read refuses instead of reading
        // outside the granted tree (the same hardening the files domain's
        // write/read/list paths carry).
        match open_beneath_anchor(&grant.canonical, &target) {
            Ok(file) => read_open_file(&file, &target, range),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => ResourceResponse::Denied(DenyReason::NotFound),
            Err(_) => ResourceResponse::Denied(DenyReason::OutOfScope),
        }
    }
}

struct ReadPermit<'a>(&'a AtomicUsize);
impl Drop for ReadPermit<'_> {
    fn drop(&mut self) { self.0.fetch_sub(1, Ordering::AcqRel); }
}

fn bounded_range(total: u64, range: Option<(u64, u64)>, _mime: &str) -> Result<(u64, u64, bool), DenyReason> {
    let cap = MAX_RESOURCE_RESPONSE_BYTES as u64;
    match range {
        Some((start, end)) if start > end => Err(DenyReason::InvalidPath),
        Some((start, _)) if start >= total => Ok((0, 0, true)),
        Some((start, end)) => Ok((start, (end.min(total - 1) - start + 1).min(cap), true)),
        None if total <= cap => Ok((0, total, false)),
        None => Err(DenyReason::TooLarge),
    }
}

#[cfg(unix)]
fn read_open_file(file: &std::fs::File, name: &Path, range: Option<(u64, u64)>) -> ResourceResponse {
    use std::os::unix::fs::FileExt;
    let Ok(total_len) = file.metadata().map(|m| m.len()) else { return ResourceResponse::Denied(DenyReason::IoError) };
    let mime = mime_for(name);
    let (start, length, applied) = match bounded_range(total_len, range, mime) {
        Ok(bounds) => bounds,
        Err(reason) => return ResourceResponse::Denied(reason),
    };
    let mut bytes = vec![0; length as usize];
    let mut offset = 0;
    while offset < bytes.len() {
        match file.read_at(&mut bytes[offset..], start + offset as u64) {
            Ok(0) => return ResourceResponse::Denied(DenyReason::IoError),
            Ok(count) => offset += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return ResourceResponse::Denied(DenyReason::IoError),
        }
    }
    ResourceResponse::Ok { mime, bytes, total_len, range_applied: applied }
}

#[cfg(windows)]
fn read_open_file(file: &std::fs::File, name: &Path, range: Option<(u64, u64)>) -> ResourceResponse {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = windows_handle::reopen_file(file) else { return ResourceResponse::Denied(DenyReason::IoError) };
    let Ok(total_len) = file.metadata().map(|m| m.len()) else { return ResourceResponse::Denied(DenyReason::IoError) };
    let mime = mime_for(name);
    let (start, length, applied) = match bounded_range(total_len, range, mime) {
        Ok(bounds) => bounds,
        Err(reason) => return ResourceResponse::Denied(reason),
    };
    if file.seek(SeekFrom::Start(start)).is_err() { return ResourceResponse::Denied(DenyReason::IoError); }
    let mut bytes = vec![0; length as usize];
    if file.read_exact(&mut bytes).is_err() { return ResourceResponse::Denied(DenyReason::IoError); }
    ResourceResponse::Ok { mime, bytes, total_len, range_applied: applied }
}

#[cfg(not(any(unix, windows)))]
fn read_open_file(_file: &std::fs::File, _name: &Path, _range: Option<(u64, u64)>) -> ResourceResponse {
    ResourceResponse::Denied(DenyReason::OutOfScope)
}

#[cfg(unix)]
fn open_beneath_directory(directory: &std::fs::File, path: &str) -> std::io::Result<std::fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let invalid = || std::io::Error::new(std::io::ErrorKind::PermissionDenied, "invalid resource path");
    if path.is_empty() || path.contains('\\') || path.split('/').any(|p| p.is_empty() || p == "." || p == "..") { return Err(invalid()); }
    let parts: Vec<_> = path.split('/').collect();
    let mut current = directory.try_clone()?;
    for (i, part) in parts.iter().enumerate() {
        let name = std::ffi::CString::new(*part).map_err(|_| invalid())?;
        let mut flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        if i + 1 < parts.len() { flags |= libc::O_DIRECTORY; }
        let fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 { return Err(std::io::Error::last_os_error()); }
        current = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    if !current.metadata()?.is_file() { return Err(invalid()); }
    Ok(current)
}

#[cfg(windows)]
fn open_beneath_directory(directory: &std::fs::File, path: &str) -> std::io::Result<std::fs::File> {
    let invalid = || std::io::Error::new(std::io::ErrorKind::PermissionDenied, "invalid resource path");
    if path.is_empty() || path.contains('\\') || path.split('/').any(|p| p.is_empty() || p == "." || p == "..") { return Err(invalid()); }
    let parts: Vec<_> = path.split('/').collect();
    let mut current = directory.try_clone()?;
    for (i, part) in parts.iter().enumerate() {
        current = windows_handle::open_child(&current, std::ffi::OsStr::new(part), i + 1 < parts.len())?;
    }
    Ok(current)
}

/// MIME by extension — scriptless defaults; HTML is served as data for an
/// opaque sandbox (the consuming iframe decides rendering, never execution).
pub fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "css" => "text/css; charset=utf-8",
        "txt" | "md" | "log" => "text/plain; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "json" => "application/json",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

// Shared test helper: an Arc<Registry> is not needed (no interior threads),
// but tests exercise the public API exactly as Tauri commands will call it.
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const TTL: Duration = Duration::from_secs(60);

    fn setup_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn bounded_sparse_file_responses_apply_to_pinned_directory_and_legacy() {
        let dir = setup_dir();
        let video = dir.path().join("large.mp4");
        let file = fs::File::create(&video).unwrap();
        let total = MAX_RESOURCE_RESPONSE_BYTES as u64 * 2 + 17;
        file.set_len(total).unwrap();
        let registry = ResourceRegistry::new();
        let pinned = registry.grant_open_file(fs::File::open(&video).unwrap(), &video, TTL).unwrap();
        let directory = registry.grant_open_directory(fs::File::open(dir.path()).unwrap(), TTL).unwrap();
        let legacy = registry.grant_file(&video, TTL).unwrap();
        let legacy_directory = registry.grant_directory(dir.path(), TTL).unwrap();
        for (handle, subpath) in [(&pinned, ""), (&directory, "large.mp4"), (&legacy, ""), (&legacy_directory, "large.mp4")] {
            assert!(matches!(registry.read(handle, subpath, None), ResourceResponse::Denied(DenyReason::TooLarge)));
            for range in [Some((0, u64::MAX)), Some((7, u64::MAX))] {
                match registry.read(handle, subpath, range) {
                    ResourceResponse::Ok { bytes, total_len, range_applied, .. } => {
                        assert_eq!(bytes.len(), MAX_RESOURCE_RESPONSE_BYTES);
                        assert_eq!(total_len, total);
                        assert!(range_applied);
                    }
                    _ => panic!("bounded media response expected"),
                }
            }
            match registry.read(handle, subpath, Some((total - 3, u64::MAX))) {
                ResourceResponse::Ok { bytes, .. } => assert_eq!(bytes.len(), 3),
                _ => panic!("short final range expected"),
            }
        }
        let text = dir.path().join("large.html");
        fs::File::create(&text).unwrap().set_len(total).unwrap();
        let text_handle = registry.grant_open_file(fs::File::open(&text).unwrap(), &text, TTL).unwrap();
        assert!(matches!(registry.read(&text_handle, "", None), ResourceResponse::Denied(DenyReason::TooLarge)));
    }

    #[test]
    fn simultaneous_ranges_use_independent_file_offsets() {
        let dir = setup_dir();
        let path = dir.path().join("x.bin");
        let content: Vec<u8> = (0..65536).map(|n| ((n / 256) % 251) as u8).collect();
        fs::write(&path, &content).unwrap();
        let registry = Arc::new(ResourceRegistry::new());
        let handle = registry.grant_open_file(fs::File::open(&path).unwrap(), &path, TTL).unwrap();
        let mut workers = Vec::new();
        for n in 0..4 {
            let registry = Arc::clone(&registry); let handle = handle.clone(); let expected = content.clone();
            workers.push(std::thread::spawn(move || {
                let start = n * 4096;
                for _ in 0..40 {
                    match registry.read(&handle, "", Some((start, start + 2047))) {
                        ResourceResponse::Ok { bytes, .. } => assert_eq!(bytes, expected[start as usize..(start + 2048) as usize]),
                        _ => panic!("concurrent read failed"),
                    }
                }
            }));
        }
        for worker in workers { worker.join().unwrap(); }
    }

    #[test]
    fn blocked_read_does_not_lock_registry_and_admitted_read_survives_revoke() {
        let dir = setup_dir(); let path = dir.path().join("x.txt"); fs::write(&path, b"fixture").unwrap();
        let registry = Arc::new(ResourceRegistry::new());
        let handle = registry.grant_open_file(fs::File::open(&path).unwrap(), &path, TTL).unwrap();
        let other = registry.grant_open_file(fs::File::open(&path).unwrap(), &path, TTL).unwrap();
        let entered = Arc::new(std::sync::Barrier::new(2)); let resume = Arc::new(std::sync::Barrier::new(2));
        let worker = { let registry = Arc::clone(&registry); let handle = handle.clone(); let entered = Arc::clone(&entered); let resume = Arc::clone(&resume);
            std::thread::spawn(move || registry.read_inner(&handle, "", None, || { entered.wait(); resume.wait(); })) };
        entered.wait();
        assert!(registry.revoke(&handle));
        assert!(matches!(registry.read(&handle, "", None), ResourceResponse::Denied(DenyReason::UnknownHandle)));
        assert!(matches!(registry.read(&other, "", None), ResourceResponse::Ok { .. }));
        resume.wait();
        assert!(matches!(worker.join().unwrap(), ResourceResponse::Ok { .. }));
    }

    #[test]
    fn concurrent_read_budget_refuses_excess_and_releases_after_completion() {
        let dir = setup_dir(); let path = dir.path().join("x.txt"); fs::write(&path, b"x").unwrap();
        let registry = Arc::new(ResourceRegistry::new());
        let handle = registry.grant_open_file(fs::File::open(&path).unwrap(), &path, TTL).unwrap();
        let entered = Arc::new(std::sync::Barrier::new(MAX_CONCURRENT_RESOURCE_READS + 1));
        let resume = Arc::new(std::sync::Barrier::new(MAX_CONCURRENT_RESOURCE_READS + 1));
        let mut workers = Vec::new();
        for _ in 0..MAX_CONCURRENT_RESOURCE_READS {
            let registry = Arc::clone(&registry); let handle = handle.clone(); let entered = Arc::clone(&entered); let resume = Arc::clone(&resume);
            workers.push(std::thread::spawn(move || registry.read_inner(&handle, "", None, || { entered.wait(); resume.wait(); })));
        }
        entered.wait();
        assert!(matches!(registry.read(&handle, "", None), ResourceResponse::Denied(DenyReason::Busy)));
        resume.wait();
        for worker in workers { assert!(matches!(worker.join().unwrap(), ResourceResponse::Ok { .. })); }
        assert!(matches!(registry.read(&handle, "", None), ResourceResponse::Ok { .. }));
    }

    #[test]
    fn read_budget_is_released_on_expiry_and_unwind() {
        let dir = setup_dir(); let path = dir.path().join("x.txt"); fs::write(&path, b"x").unwrap();
        let registry = ResourceRegistry::new();
        let expired = registry.grant_open_file(fs::File::open(&path).unwrap(), &path, Duration::ZERO).unwrap();
        assert!(matches!(registry.read(&expired, "", None), ResourceResponse::Denied(DenyReason::Expired)));
        let handle = registry.grant_open_file(fs::File::open(&path).unwrap(), &path, TTL).unwrap();
        let _ = std::panic::catch_unwind(|| registry.read_inner(&handle, "", None, || panic!("cancelled fixture")));
        assert_eq!(registry.active_reads.load(Ordering::Acquire), 0);
        assert!(matches!(registry.read(&handle, "", None), ResourceResponse::Ok { .. }));
    }

    #[test]
    fn file_grant_serves_bytes_with_mime_and_range() {
        let dir = setup_dir();
        let image = dir.path().join("shot.png");
        let body: Vec<u8> = (0..2500u32).map(|i| (i % 251) as u8).collect();
        fs::write(&image, &body).expect("write");
        let registry = ResourceRegistry::new();
        let handle = registry.grant_file(&image, TTL).expect("grant");
        assert_eq!(handle.len(), 32, "128-bit hex handle");

        match registry.read(&handle, "", None) {
            ResourceResponse::Ok { mime, bytes, total_len, range_applied } => {
                assert_eq!(mime, "image/png");
                assert_eq!(bytes.len(), 2500);
                assert_eq!(total_len, 2500);
                assert!(!range_applied);
            }
            _ => panic!("expected Ok"),
        }
        // Range: bytes 100-199.
        match registry.read(&handle, "", Some((100, 199))) {
            ResourceResponse::Ok { bytes, range_applied, .. } => {
                assert!(range_applied);
                assert_eq!(bytes, body[100..=199].to_vec());
            }
            _ => panic!("expected ranged Ok"),
        }
        // Out-of-bounds range start → empty body, still 206-style.
        match registry.read(&handle, "", Some((10_000, 10_100))) {
            ResourceResponse::Ok { bytes, range_applied, .. } => {
                assert!(range_applied);
                assert!(bytes.is_empty());
            }
            _ => panic!("expected out-of-bounds Ok"),
        }
        // A file grant refuses subpaths.
        assert!(matches!(
            registry.read(&handle, "other.png", None),
            ResourceResponse::Denied(DenyReason::InvalidPath)
        ));
    }

    #[test]
    fn image_bytes_are_bounded_raster_only_and_revocable() {
        let registry = ResourceRegistry::new();
        for mime in ["image/svg+xml", "text/html", "image/svg", "application/octet-stream"] {
            assert!(matches!(registry.grant_image_bytes(vec![1], mime, TTL), Err(DenyReason::InvalidPath)));
        }
        assert!(matches!(registry.grant_image_bytes(Vec::new(), "image/png", TTL), Err(DenyReason::InvalidPath)));
        assert!(matches!(registry.grant_image_bytes(vec![0; MAX_RESOURCE_IMAGE_BYTES + 1], "image/png", TTL), Err(DenyReason::InvalidPath)));
        for mime in ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif"] {
            let handle = registry.grant_image_bytes(b"012345".to_vec(), mime, TTL).unwrap();
            match registry.read(&handle, "", Some((1, 3))) {
                ResourceResponse::Ok { mime: got, bytes, total_len, range_applied } => {
                    assert_eq!(got, mime); assert_eq!(bytes, b"123"); assert_eq!(total_len, 6); assert!(range_applied);
                }
                _ => panic!("expected ranged image"),
            }
            assert!(matches!(registry.read(&handle, "other", None), ResourceResponse::Denied(DenyReason::InvalidPath)));
            assert!(registry.revoke(&handle));
            assert!(matches!(registry.read(&handle, "", None), ResourceResponse::Denied(DenyReason::UnknownHandle)));
        }
        let mut handles = Vec::new();
        for _ in 0..6 { handles.push(registry.grant_image_bytes(vec![0; MAX_RESOURCE_IMAGE_BYTES], "image/png", TTL).unwrap()); }
        assert!(matches!(registry.grant_image_bytes(vec![0; MAX_RESOURCE_IMAGE_BYTES], "image/png", TTL), Err(DenyReason::IoError)));
        assert!(registry.revoke(&handles[0]));
        assert!(registry.grant_image_bytes(vec![0; MAX_RESOURCE_IMAGE_BYTES], "image/png", TTL).is_ok());
        let expired = registry.grant_image_bytes(vec![1], "image/png", Duration::ZERO).unwrap();
        assert!(matches!(registry.read(&expired, "", None), ResourceResponse::Denied(DenyReason::Expired)));
    }

    #[test]
    fn expired_image_memory_is_reclaimed_without_a_request() {
        let registry = ResourceRegistry::new();
        let handle = registry.grant_image_bytes(vec![1; 1024], "image/png", Duration::from_millis(10)).unwrap();
        std::thread::sleep(Duration::from_millis(1250));
        assert!(!registry.grants.lock().unwrap().contains_key(&handle));
    }

    #[test]
    fn each_grant_has_a_distinct_128_bit_hex_handle() {
        let dir = setup_dir();
        let file = dir.path().join("x.txt");
        fs::write(&file, b"x").unwrap();
        let registry = ResourceRegistry::new();
        let mut handles = std::collections::HashSet::new();
        for _ in 0..100 {
            let handle = registry.grant_file(&file, TTL).unwrap();
            assert_eq!(handle.len(), 32);
            assert!(handle.bytes().all(|byte| byte.is_ascii_hexdigit()));
            assert!(handles.insert(handle));
        }
    }

    #[test]
    fn directory_grant_contains_traversal_and_escapes() {
        let dir = setup_dir();
        let assets = dir.path().join("assets");
        fs::create_dir(&assets).expect("mkdir");
        fs::write(assets.join("a.css"), b"body{}").expect("css");
        fs::create_dir_all(assets.join("img")).expect("img dir");
        fs::write(assets.join("img/b.png"), b"png").expect("png");
        let outside = dir.path().join("secret.txt");
        fs::write(&outside, b"credentials").expect("outside");

        let registry = ResourceRegistry::new();
        let handle = registry.grant_directory(&assets, TTL).expect("grant");

        let ok = |sub: &str, registry: &ResourceRegistry, handle: &str| matches!(
            registry.read(handle, sub, None),
            ResourceResponse::Ok { .. }
        );
        assert!(ok("a.css", &registry, &handle));
        assert!(ok("img/b.png", &registry, &handle));

        // Parent traversal, absolute paths, backslashes: refused.
        for bad in ["../secret.txt", "a.css/../../secret.txt", "/etc/passwd", "img\\b.png"] {
            assert!(
                matches!(
                    registry.read(&handle, bad, None),
                    ResourceResponse::Denied(DenyReason::InvalidPath)
                ),
                "refuse {bad}"
            );
        }
        // A path that escapes via symlink inside the tree.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, assets.join("leak")).expect("symlink");
            assert!(matches!(
                registry.read(&handle, "leak", None),
                ResourceResponse::Denied(DenyReason::OutOfScope)
            ));
        }
        // Unknown handle and empty subpath.
        assert!(matches!(
            registry.read("deadbeef", "a.css", None),
            ResourceResponse::Denied(DenyReason::UnknownHandle)
        ));
        assert!(matches!(
            registry.read(&handle, "", None),
            ResourceResponse::Denied(DenyReason::InvalidPath)
        ));
    }

    #[test]
    fn grants_expire_revoke_and_sweep() {
        let dir = setup_dir();
        let file = dir.path().join("x.txt");
        fs::write(&file, b"x").expect("write");
        let registry = ResourceRegistry::new();
        let handle = registry.grant_file(&file, Duration::from_millis(80)).expect("grant");
        assert!(matches!(registry.read(&handle, "", None), ResourceResponse::Ok { .. }));
        std::thread::sleep(Duration::from_millis(120));
        assert!(matches!(
            registry.read(&handle, "", None),
            ResourceResponse::Denied(DenyReason::Expired)
        ));
        assert_eq!(registry.sweep_expired(), 0, "the expired read removed its grant");

        let handle = registry.grant_file(&file, TTL).expect("grant");
        assert!(registry.revoke(&handle));
        assert!(matches!(
            registry.read(&handle, "", None),
            ResourceResponse::Denied(DenyReason::UnknownHandle)
        ));
    }

    #[test]
    fn grants_bind_to_the_resolved_target_and_refuse_anchor_replacement() {
        let dir = setup_dir();
        let real = dir.path().join("real");
        fs::create_dir(&real).expect("mkdir");
        fs::write(real.join("data.bin"), b"ok").expect("data");
        let link = dir.path().join("link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).expect("symlink");

        let registry = ResourceRegistry::new();
        #[cfg(unix)]
        {
            // Granted through the symlink: the grant binds to the RESOLVED
            // directory, so later retargeting of the link cannot move it.
            let handle = registry.grant_directory(&link, TTL).expect("grant");
            assert!(matches!(
                registry.read(&handle, "data.bin", None),
                ResourceResponse::Ok { bytes, .. } if bytes == b"ok"
            ));
            let other = dir.path().join("other");
            fs::create_dir(&other).expect("other");
            fs::write(other.join("data.bin"), b"impostor").expect("other data");
            std::fs::remove_file(&link).expect("unlink");
            std::os::unix::fs::symlink(&other, &link).expect("relink");
            // Still the ORIGINAL resolved tree — never the new target.
            match registry.read(&handle, "data.bin", None) {
                ResourceResponse::Ok { bytes, .. } => assert_eq!(bytes, b"ok"),
                _ => panic!("grant still serves its resolved target"),
            }
        }

        // Replacing the granted directory itself with a symlink to another
        // tree: the anchor's current target differs from the grant's — refuse.
        let granted = dir.path().join("granted");
        fs::create_dir(&granted).expect("granted");
        fs::write(granted.join("data.bin"), b"ok").expect("data");
        let handle = registry.grant_directory(&granted, TTL).expect("grant");
        let impostor = dir.path().join("impostor");
        fs::create_dir(&impostor).expect("impostor");
        fs::write(impostor.join("data.bin"), b"impostor").expect("data");
        fs::remove_dir_all(&granted).expect("remove granted");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&impostor, &granted).expect("replaced by symlink");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&impostor, &granted).expect("replaced by junction");
        assert!(matches!(
            registry.read(&handle, "data.bin", None),
            ResourceResponse::Denied(DenyReason::OutOfScope)
        ));
    }

    #[test]
    fn grant_refuses_missing_or_wrong_kind() {
        let dir = setup_dir();
        let registry = ResourceRegistry::new();
        assert!(matches!(
            registry.grant_file(&dir.path().join("missing.png"), TTL),
            Err(DenyReason::NotFound)
        ));
        // A directory cannot be granted as a file.
        assert!(matches!(
            registry.grant_file(dir.path(), TTL),
            Err(DenyReason::InvalidPath)
        ));
        // A file cannot be granted as a directory.
        let file = dir.path().join("f.txt");
        fs::write(&file, b"f").expect("write");
        assert!(matches!(
            registry.grant_directory(&file, TTL),
            Err(DenyReason::InvalidPath)
        ));
    }

    #[test]
    fn mime_map_is_scriptless_friendly() {
        assert_eq!(mime_for(Path::new("a.png")), "image/png");
        assert_eq!(mime_for(Path::new("a.HTML")), "text/html; charset=utf-8");
        assert_eq!(mime_for(Path::new("noext")), "application/octet-stream");
    }
}


/// Open the ANCHOR directory (the grant's canonical path — the trust anchor
/// a grant lives or dies by), then descend one component at a time with
/// openat(O_DIRECTORY|O_NOFOLLOW) and open the final file O_NOFOLLOW. Every
/// component below the anchor refuses to be a symlink; a swapped component
/// is ELOOP/ENOTDIR-refused, never followed.
#[cfg(unix)]
fn open_beneath_anchor(anchor: &Path, target: &Path) -> std::io::Result<std::fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};

    fn open_dir_no_follow(parent: Option<&std::fs::File>, path: &str) -> std::io::Result<std::fs::File> {
        let c_path = CString::new(path)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in path"))?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let fd = match parent {
            Some(parent) => unsafe { libc::openat(parent.as_raw_fd(), c_path.as_ptr(), flags) },
            None => unsafe { libc::open(c_path.as_ptr(), flags) },
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: fd from a successful open; File owns and closes it.
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    // A FILE grant's anchor IS the file: open it directly with O_NOFOLLOW
    // (its identity was just re-validated by the caller's canonicalize
    // comparison — a symlinked final component refuses here).
    if target == anchor {
        let c_path = CString::new(anchor.as_os_str().as_encoded_bytes())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in path"))?;
        let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
        let fd = unsafe { libc::open(c_path.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: fd from a successful open; File owns and closes it.
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        if !file.metadata()?.is_file() { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "not a regular file")); }
        return Ok(file);
    }
    let mut current = open_dir_no_follow(None, &anchor.to_string_lossy())?;
    let relative = target
        .strip_prefix(anchor)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::PermissionDenied, "outside the anchor"))?;
    let mut components: Vec<String> = Vec::new();
    for component in relative.components() {
        let step = component.as_os_str().to_string_lossy().into_owned();
        if step == "." || step == ".." || step.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "bad component"));
        }
        components.push(step);
    }
    let Some((name, dirs)) = components.split_last() else {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "the anchor is not a file"));
    };
    for step in dirs {
        current = open_dir_no_follow(Some(&current), step)?;
    }
    let c_name = CString::new(name.as_str())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in file name"))?;
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    let fd = unsafe { libc::openat(current.as_raw_fd(), c_name.as_ptr(), flags) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fd from a successful openat; File owns and closes it.
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    if !file.metadata()?.is_file() { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "not a regular file")); }
    Ok(file)
}

/// No path-based fallback on platforms without a safe handle walk.
#[cfg(not(unix))]
fn open_beneath_anchor(_anchor: &Path, _target: &Path) -> std::io::Result<std::fs::File> {
    Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "safe handle walk unavailable"))
}


#[cfg(all(test, unix))]
mod race_tests {
    use super::*;

    #[test]
    fn a_swapped_in_tree_component_refuses_instead_of_reading_out() {
        // Grant a DIRECTORY; authorize reads inside it; then swap one of its
        // files for a symlink to a secret outside. The granted read must
        // refuse (beneath-walk O_NOFOLLOW), never serve the secret.
        let dir = tempfile::tempdir().expect("tempdir");
        let tree = dir.path().join("tree");
        std::fs::create_dir_all(&tree).expect("tree");
        std::fs::write(tree.join("page.html"), b"<p>inside</p>").expect("page");
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, b"TOP SECRET").expect("secret");

        let registry = ResourceRegistry::new();
        let handle = registry
            .grant_directory(&tree, Duration::from_secs(60))
            .expect("grant");
        // The honest read works.
        assert!(matches!(
            registry.read(&handle, "page.html", None),
            ResourceResponse::Ok { .. }
        ));
        // The ATTACK: swap the file for a symlink to the secret.
        std::fs::remove_file(tree.join("page.html")).expect("remove");
        std::os::unix::fs::symlink(&secret, tree.join("page.html")).expect("swap");
        // The read refuses: the containment check resolves through the link
        // to OUTSIDE the granted tree.
        match registry.read(&handle, "page.html", None) {
            ResourceResponse::Denied(_) => {}
            ResourceResponse::Ok { .. } => panic!("the swapped component must refuse"),
        }
        // And the walk itself (the check→open race) refuses a stale pair:
        // authorize the resolved-inside spelling first via a fresh tree
        // file, swap it, then read with the stale target.
        std::fs::write(tree.join("doc.txt"), b"doc").expect("doc");
        let stale_target = tree.join("doc.txt");
        let mut walked = None;
        if let Ok(resolved) = std::fs::canonicalize(&stale_target) {
            if resolved.starts_with(&tree) {
                walked = Some(resolved);
            }
        }
        std::fs::remove_file(&stale_target).expect("remove");
        std::os::unix::fs::symlink(&secret, &stale_target).expect("swap again");
        if let Some(stale) = walked {
            let outcome = open_beneath_anchor(&tree.canonicalize().unwrap(), &stale);
            assert!(outcome.is_err(), "the stale in-tree target must refuse: {outcome:?}");
        }
    }
}
