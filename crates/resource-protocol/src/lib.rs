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
//! - directory grants serve only files strictly below the granted directory
//!   (canonical containment), refusing parent traversal, absolute escapes
//!   and UNC tricks (Windows normalization is enforced by the caller via
//!   the same canonicalize step);
//! - MIME by extension, scriptless defaults (`.html` is served as data for
//!   an opaque sandbox; scripts never execute because the consuming iframe
//!   never gets both `allow-scripts` and `allow-same-origin`);
//! - HTTP-style Range support for media seeking;
//! - grants expire (TTL) and can be revoked explicitly;
//! - unknown/malformed handles, expired grants and out-of-scope paths are
//!   plain rejections with stable reasons.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
}

/// The outcome of one resource read.
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
}

/// The registry of grants. `create` picks the handle; nothing else does.
pub struct ResourceRegistry {
    grants: Mutex<HashMap<Handle, Grant>>,
    counter: AtomicU64,
    entropy: Mutex<u64>,
}

impl Default for ResourceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ResourceRegistry {
    pub fn new() -> Self {
        Self {
            grants: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            entropy: Mutex::new(0),
        }
    }

    fn random_handle(&self) -> Handle {
        // 128 bits from the OS entropy pool (getrandom/OsRng equivalent via
        // /dev/urandom on unix, RtlGenRandom on windows) — the crate keeps
        // zero dependencies, so read the platform source directly.
        let mut seed = [0u8; 16];
        let filled = fill_entropy(&mut seed);
        if !filled {
            // Fall back to a time+counter token; still unguessable to a
            // sandboxed iframe (which cannot read the clock source either).
            let count = self.counter.fetch_add(1, Ordering::Relaxed);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos() as u64)
                .unwrap_or(0);
            let mut state = self.entropy.lock().unwrap();
            *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15).rotate_left(17) ^ now ^ count;
            seed[..8].copy_from_slice(&state.to_le_bytes());
            seed[8..].copy_from_slice(&count.to_le_bytes());
        }
        seed.iter().map(|byte| format!("{byte:02x}")).collect()
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
        let handle = self.random_handle();
        self.grants.lock().unwrap().insert(
            handle.clone(),
            Grant {
                canonical: canonical.clone(),
                scope,
                original_target: canonical,
                expires_at: Instant::now() + ttl,
            },
        );
        Ok(handle)
    }

    /// Revoke a grant (the preview closed, the window went away).
    pub fn revoke(&self, handle: &str) -> bool {
        self.grants.lock().unwrap().remove(handle).is_some()
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
        let grants = self.grants.lock().unwrap();
        let Some(grant) = grants.get(handle) else {
            return ResourceResponse::Denied(DenyReason::UnknownHandle);
        };
        if Instant::now() >= grant.expires_at {
            return ResourceResponse::Denied(DenyReason::Expired);
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
        let bytes = match read_beneath_anchor(&grant.canonical, &target) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return ResourceResponse::Denied(DenyReason::NotFound)
            }
            Err(_) => return ResourceResponse::Denied(DenyReason::OutOfScope),
        };
        let mime = mime_for(&target);
        let total_len = bytes.len() as u64;
        let (bytes, range_applied) = match range {
            Some((start, end)) if start <= end && start < total_len => {
                let end = end.min(total_len - 1);
                (bytes[start as usize..=end as usize].to_vec(), true)
            }
            Some((start, _)) if start >= total_len => (Vec::new(), true),
            Some(_) | None => (bytes, false),
        };
        ResourceResponse::Ok { mime, bytes, total_len, range_applied }
    }
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

#[cfg(unix)]
fn fill_entropy(buf: &mut [u8]) -> bool {
    use std::io::Read;
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(buf))
        .is_ok()
}

#[cfg(windows)]
fn fill_entropy(buf: &mut [u8]) -> bool {
    // RtlGenRandom via the BCryptGenRandom path without extra crates.
    use std::os::windows::io::AsRawHandle;
    let ok = unsafe {
        windows_gen_random(buf.as_mut_ptr(), buf.len() as u32)
    };
    ok == 1
}

#[cfg(windows)]
#[link(name = "bcrypt")]
extern "system" {
    #[link_name = "BCryptGenRandom"]
    fn windows_gen_random(buffer: *mut u8, length: u32) -> i32;
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
        assert_eq!(registry.sweep_expired(), 1);

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
fn read_beneath_anchor(anchor: &Path, target: &Path) -> std::io::Result<Vec<u8>> {
    use std::ffi::CString;
    use std::io::Read;
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
        let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let fd = unsafe { libc::open(c_path.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: fd from a successful open; File owns and closes it.
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        return Ok(data);
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
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = unsafe { libc::openat(current.as_raw_fd(), c_name.as_ptr(), flags) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fd from a successful openat; File owns and closes it.
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;
    Ok(data)
}

/// Windows until a handle-based implementation ships: the granted read
/// falls back to the plain path read (the anchor's identity was just
/// re-validated); the component-swap race is documented in the migration
/// README and closes with the Windows files work.
#[cfg(windows)]
fn read_beneath_anchor(_anchor: &Path, target: &Path) -> std::io::Result<Vec<u8>> {
    std::fs::read(target)
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
            let outcome = read_beneath_anchor(&tree.canonicalize().unwrap(), &stale);
            assert!(outcome.is_err(), "the stale in-tree target must refuse: {outcome:?}");
        }
    }
}
