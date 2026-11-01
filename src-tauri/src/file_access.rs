//! The file access allow-list (M3): the security boundary /api/files had,
//! moved into the Rust host. Semantics ported from lib/file-access.ts +
//! lib/path-security.ts:
//!
//! - an explicit set of allowed roots (session cwds, project roots,
//!   `~/pi-cwd*` scans, explicitly added roots);
//! - lexical authorization checks the path WITHOUT touching the filesystem
//!   (a path inside a root by spelling);
//! - existing-path authorization additionally canonicalizes (symlinks,
//!   junctions) and requires the RESOLVED path to stay inside the resolved
//!   roots — a symlink pointing out is refused;
//! - Windows case/UNC normalization is delegated to the caller's
//!   canonicalization (dunce-style), the containment rules are identical.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

#[cfg(unix)]
#[path = "file_directory_unix.rs"]
pub(crate) mod file_directory_unix;
#[cfg(unix)]
use file_directory_unix::{directory_entries, directory_entry_info, git_directory};
#[cfg(unix)]
#[path = "pinned_root_unix.rs"]
mod pinned_root_unix;
#[cfg(windows)]
#[path = "file_handle_windows.rs"]
pub(crate) mod file_handle_windows;

/// The allowed-root set (normalized, forward-slash, trailing-slash-free).
#[derive(Debug, Default, Clone)]
pub struct AllowedRoots {
    roots: BTreeSet<String>,
    resolved_roots: BTreeMap<String, PathBuf>,
    #[cfg(unix)]
    pinned_roots: BTreeMap<String, pinned_root_unix::PinnedRoot>,
    #[cfg(windows)]
    pinned_roots: BTreeMap<String, file_handle_windows::PinnedRoot>,
}

impl AllowedRoots {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a root (normalized: forward slashes, no trailing slash; empty or
    /// relative roots are ignored — an allow-list root is absolute).
    pub fn add(&mut self, root: &Path) -> std::io::Result<()> {
        let normalized = normalize_root(root).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "root must be absolute"))?;
        #[cfg(unix)]
        {
            for known in &self.roots {
                if is_within(&normalized, known) && self.unchanged_root(known).is_none() {
                    return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "previously authorized root was replaced or removed"));
                }
            }
            if let Some(existing) = self.pinned_roots.get(&normalized) {
                existing.admit()?;
                return Ok(());
            }
            if self.roots.contains(&normalized) {
                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "previously missing root requires explicit selection"));
            }
            let pinned = pinned_root_unix::PinnedRoot::open(root)?;
            pinned.admit()?;
            self.resolved_roots.insert(normalized.clone(), pinned.path().to_path_buf());
            self.pinned_roots.insert(normalized.clone(), pinned);
        }
        #[cfg(windows)]
        {
            for known in &self.roots {
                if is_within(&normalized, known) && self.unchanged_root(known).is_none() {
                    return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "previously authorized root was replaced or removed"));
                }
            }
            if let Some((_, existing)) = self.pinned_roots.iter().find(|(key, _)| file_handle_windows::same_text(key, &normalized)) {
                existing.admit()?;
                return Ok(());
            }
            if self.roots.iter().any(|key| file_handle_windows::same_text(key, &normalized)) {
                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "previously missing root requires explicit selection"));
            }
            let pinned = file_handle_windows::PinnedRoot::open(root)?;
            pinned.admit()?;
            self.resolved_roots.insert(normalized.clone(), pinned.path().to_path_buf());
            self.pinned_roots.insert(normalized.clone(), pinned);
        }
        self.roots.insert(normalized);
        Ok(())
    }

    /// Only a fresh host-native selection may replace a prior grant.
    #[cfg(any(unix, windows))]
    pub fn reauthorize(&mut self, root: &Path) -> std::io::Result<()> {
        let normalized = normalize_root(root).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "root must be absolute"))?;
        #[cfg(unix)]
        let pinned = pinned_root_unix::PinnedRoot::open(root)?;
        #[cfg(windows)]
        let pinned = file_handle_windows::PinnedRoot::open(root)?;
        pinned.admit()?;
        #[cfg(windows)]
        if let Some(old) = self.roots.iter().find(|key| file_handle_windows::same_text(key, &normalized)).cloned() {
            self.roots.remove(&old);
            self.resolved_roots.remove(&old);
            self.pinned_roots.remove(&old);
        }
        let canonical = pinned.path().to_path_buf();
        self.resolved_roots.insert(normalized.clone(), canonical);
        self.pinned_roots.insert(normalized.clone(), pinned);
        self.roots.insert(normalized);
        Ok(())
    }

    /// Record a missing historical cwd for status only, without a grant.
    pub fn add_missing(&mut self, root: &Path) {
        if let Some(normalized) = normalize_root(root) {
            #[cfg(windows)]
            if self.roots.iter().any(|known| file_handle_windows::same_text(known, &normalized)) { return; }
            self.roots.insert(normalized);
        }
    }

    fn unchanged_root(&self, root: &str) -> Option<PathBuf> {
        #[cfg(any(unix, windows))]
        self.pinned_roots.get(root)?.admit().ok()?;
        let original = self.resolved_roots.get(root)?;
        #[cfg(windows)]
        { Some(original.clone()) }
        #[cfg(not(windows))]
        { let current = std::fs::canonicalize(root).ok()?; (current == *original).then_some(current) }
    }

    /// The `~/pi-cwd` and `~/pi-cwd-YYYYMMDD` scan roots (the legacy
    /// default-cwd layouts stay browsable across restarts).
    pub fn add_default_cwd_roots(&mut self, home: &Path) -> std::io::Result<()> {
        if home.join("pi-cwd").try_exists()? { self.add(&home.join("pi-cwd"))?; }
        {
            let entries = std::fs::read_dir(home)?;
            for entry in entries {
                let entry = entry?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.len() == 15
                    && name.starts_with("pi-cwd-")
                    && name[8..].chars().all(|c| c.is_ascii_digit())
                {
                    self.add(&entry.path())?;
                }
            }
        }
        Ok(())
    }

    /// Snapshot of host-authorized roots for scoped management operations.
    pub fn snapshot(&self) -> Vec<String> {
        self.roots.iter().filter(|root| self.unchanged_root(root).is_some()).cloned().collect()
    }

    /// Lexical authorization: the path is inside a root by spelling (no
    /// filesystem access; `..` never escapes, separators normalize).
    pub fn is_path_allowed(&self, target: &Path) -> bool {
        let Some(normalized) = normalize_absolute(target) else { return false };
        for root in &self.roots {
            if is_within(&normalized, root) {
                return true;
            }
        }
        false
    }

    /// Existing-path authorization: the resolved (canonical) target must be
    /// inside a root that ALSO resolves to the same spelling — a symlink or
    /// junction pointing outside the roots is refused.
    pub fn is_existing_path_allowed(&self, target: &Path) -> bool {
        #[cfg(any(unix, windows))]
        { self.open_directory(target).is_ok() || self.open_file(target).is_ok() }
        #[cfg(not(any(unix, windows)))]
        { self.is_existing_path_allowed_at(target, true) }
    }

    /// Authorization for a path that may not exist yet (a new file):
    /// the RESOLVED PARENT must sit inside a resolved root and the final
    /// component must be a plain name (never `..`, never empty) — the
    /// /api/files rule (existingAuthorizationPath = dirname for new files).
    /// A symlink final component therefore never authorizes: the write
    /// would follow it outside the roots. (Tests assert the rule; the write
    /// path itself walks beneath the root — see write_beneath_root.)
    #[cfg(test)]
    pub fn is_new_path_allowed(&self, target: &Path) -> bool {
        self.is_existing_path_allowed_at(target, false)
    }

    fn is_existing_path_allowed_at(&self, target: &Path, target_itself: bool) -> bool {
        if has_parent_segment(target) {
            // `link/..` names a path beside the link's target, outside the
            // roots (#748): refuse before any filesystem resolution.
            return false;
        }
        if !self.is_path_allowed(target) {
            return false;
        }
        let authorize = if target_itself {
            Some(target.to_path_buf())
        } else {
            target.parent().map(Path::to_path_buf)
        };
        let Some(authorize) = authorize else { return false };
        let Ok(resolved_target) = std::fs::canonicalize(&authorize) else {
            return false
        };
        for root in &self.roots {
            let Some(resolved_root) = self.unchanged_root(root) else {
                continue;
            };
            if resolved_target.starts_with(&resolved_root) {
                return true;
            }
        }
        false
    }

    #[cfg(unix)]
    fn admit_resolved(&self, target: &Path) -> std::io::Result<(PathBuf, PathBuf, std::fs::File)> {
        let normalized = normalize_absolute(target).ok_or(std::io::ErrorKind::InvalidInput)?;
        for known in &self.roots {
            if is_within(&normalized, known) && self.unchanged_root(known).is_none() {
                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "authorized root was replaced or removed"));
            }
        }
        let (resolved, root) = resolved_read_target_with_root(self, target)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::PermissionDenied, "outside authorized roots"))?;
        for (key, pinned) in &self.pinned_roots {
            if self.resolved_roots.get(key) == Some(&root) {
                return Ok((resolved, root, pinned.admit()?));
            }
        }
        Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "root not pinned"))
    }

    #[cfg(unix)]
    pub(crate) fn open_directory(&self, target: &Path) -> std::io::Result<std::fs::File> {
        let (resolved, root, handle) = self.admit_resolved(target)?;
        walk_directory(&handle, resolved.strip_prefix(root).map_err(|_| std::io::ErrorKind::PermissionDenied)?)
    }

    #[cfg(unix)]
    pub(crate) fn open_file(&self, target: &Path) -> std::io::Result<std::fs::File> {
        let (resolved, root, handle) = self.admit_resolved(target)?;
        open_file_relative(&handle, resolved.strip_prefix(root).map_err(|_| std::io::ErrorKind::PermissionDenied)?)
    }

    #[cfg(unix)]
    pub(crate) fn open_preview_directory(&self, target: &Path) -> std::io::Result<(std::fs::File, String)> {
        let (resolved, root, handle) = self.admit_resolved(target)?;
        let relative = resolved.strip_prefix(root).map_err(|_| std::io::ErrorKind::PermissionDenied)?;
        let name = relative.file_name().and_then(|name| name.to_str()).ok_or(std::io::ErrorKind::InvalidInput)?.to_owned();
        let _file = open_file_relative(&handle, relative)?;
        let directory = walk_directory(&handle, relative.parent().ok_or(std::io::ErrorKind::InvalidInput)?)?;
        Ok((directory, name))
    }

    #[cfg(windows)]
    fn open_windows_target(&self, target: &Path, directory: bool) -> std::io::Result<std::fs::File> {
        if has_parent_segment(target) { return Err(std::io::ErrorKind::PermissionDenied.into()); }
        let normalized = normalize_absolute(target).ok_or(std::io::ErrorKind::InvalidInput)?;
        for known in &self.roots {
            if is_within(&normalized, known) && self.unchanged_root(known).is_none() {
                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "authorized root was replaced or removed"));
            }
        }
        let (root, pinned) = self.pinned_roots.iter().filter(|(root, _)| is_within(&normalized, root))
            .max_by_key(|(root, _)| root.split('/').count()).ok_or(std::io::ErrorKind::PermissionDenied)?;
        let mut current = pinned.admit()?;
        let root_parts = root.split('/').count();
        let parts: Vec<&str> = normalized.split('/').skip(root_parts).collect();
        if parts.is_empty() { return if directory { Ok(current) } else { Err(std::io::ErrorKind::InvalidInput.into()) }; }
        for (index, part) in parts.iter().enumerate() {
            current = file_handle_windows::open_child(&current, std::ffi::OsStr::new(part), directory || index + 1 < parts.len())?;
        }
        Ok(current)
    }

    #[cfg(windows)]
    pub(crate) fn open_directory(&self, target: &Path) -> std::io::Result<std::fs::File> { self.open_windows_target(target, true) }
    #[cfg(windows)]
    pub(crate) fn open_file(&self, target: &Path) -> std::io::Result<std::fs::File> { self.open_windows_target(target, false) }

    /// Open an already-authorized directory without following swapped path
    /// components. The returned descriptor pins the directory across spawn.
    #[cfg(unix)]
    pub(crate) fn open_terminal_directory(&self, target: &Path) -> Option<(PathBuf, std::fs::File)> {
        let (resolved, root, handle) = self.admit_resolved(target).ok()?;
        let directory = walk_directory(&handle, resolved.strip_prefix(root).ok()?).ok()?;
        Some((resolved, directory))
    }

    /// The canonical, resolved PARENT of a write target, authorized against
    /// the resolved roots. Returns None when the parent does not resolve or
    /// escapes the roots. This is the ONE authorization point for writes:
    /// the final component is never resolved here (that is the open's job,
    /// symlink-refusing — see write_through_allowed_parent).
    /// Like [`Self::resolved_write_parent`], but also returns WHICH root
    /// (canonicalized) the parent sits under — the anchor a beneath-walk
    /// starts from, so no path component between the root and the parent
    /// is ever resolved through a symlink (an ancestor swapped for a link
    /// after the check is refused at the walk, not followed).
    pub fn resolved_write_parent_with_root(&self, target: &Path) -> Option<(PathBuf, PathBuf)> {
        if has_parent_segment(target) {
            return None;
        }
        if !self.is_path_allowed(target) {
            return None;
        }
        let parent = target.parent()?;
        let resolved = std::fs::canonicalize(parent).ok()?;
        for root in &self.roots {
            let Some(resolved_root) = self.unchanged_root(root) else {
                continue;
            };
            if resolved.starts_with(&resolved_root) {
                return Some((resolved, resolved_root));
            }
        }
        None
    }

    #[cfg(test)]
    pub fn resolved_write_parent(&self, target: &Path) -> Option<PathBuf> {
        self.resolved_write_parent_with_root(target).map(|(parent, _root)| parent)
    }
}

/// Why a checked write was refused (the protocol error's details).
#[derive(Debug)]
pub enum WriteRefusal {
    /// The path (parent) is not inside the allowed roots.
    OutsideRoots,
    /// A path component is a symlink the write must not follow (the file's
    /// own name, or an ancestor directory swapped for a link mid-walk).
    FinalComponentSymlink,
    /// The filesystem refused the open/write.
    Io(std::io::Error),
    /// Windows until a handle-based implementation ships (fail-closed,
    /// never a silently weaker path).
    #[cfg(windows)]
    UnsupportedPlatform,
}

impl std::fmt::Display for WriteRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteRefusal::OutsideRoots => write!(f, "the path is outside the allowed roots"),
            WriteRefusal::FinalComponentSymlink => {
                write!(f, "a path component is a symbolic link the write must not follow")
            }
            WriteRefusal::Io(error) => write!(f, "{error}"),
            #[cfg(windows)]
            WriteRefusal::UnsupportedPlatform => write!(
                f,
                "writes are not supported on this platform until the handle-based implementation ships"
            ),
        }
    }
}

/// Write `data` at `target`, refusing every symlink-escape class the
/// original /api/files write refused — plus the ancestor-swap race:
///
/// - the target's parent canonicalizes and must sit inside a canonicalized
///   allowed root (lexical `..` and out-of-root spellings refuse);
/// - the walk to the parent starts at a file descriptor opened on the
///   AUTHORIZED ROOT and descends one component at a time with
///   `openat(..., O_NOFOLLOW | O_DIRECTORY)` — a component swapped for a
///   symlink at ANY depth below the root (an ancestor directory, not just
///   the file's own name) is ELOOP-refused, never followed;
/// - the file itself opens `openat(parent_fd, name, O_NOFOLLOW)` — a
///   symlinked final component (dangling or not) refuses atomically.
///
/// Residual, inherent to path-based APIs and shared with the original TS
/// implementation: a component legitimately RENAMED (not linked) between
/// authorization and the open makes the walk enter the new directory at
/// the old name. Only holding descriptors from authorization time (or an
/// openat2 RESOLVE_BENEATH kernel API) closes that; the rename race is
/// documented rather than claimed closed.
///
/// Windows: the host refuses the write outright (`UnsupportedPlatform`)
/// rather than shipping the earlier \?\-prefix + reparse-probe code —
/// the prefix does not disable reparse resolution and probe-then-open is
/// itself a TOCTOU. A handle-based (NtCreateFile relative opens)
/// implementation is required before the static app ships on Windows.
pub fn write_through_allowed_parent(
    roots: &AllowedRoots,
    target: &Path,
    data: &[u8],
) -> Result<(), WriteRefusal> {
    let Some((resolved_parent, resolved_root)) = roots.resolved_write_parent_with_root(target) else {
        return Err(WriteRefusal::OutsideRoots);
    };
    let Some(name) = target.file_name().and_then(|name| name.to_str()) else {
        return Err(WriteRefusal::OutsideRoots);
    };
    if name.is_empty() || name == "." || name == ".." {
        return Err(WriteRefusal::OutsideRoots);
    }

    #[cfg(unix)]
    {
        let _ = (resolved_root, resolved_parent);
        let parent = roots.open_directory(target.parent().ok_or(WriteRefusal::OutsideRoots)?)
            .map_err(WriteRefusal::Io)?;
        crate::project_upload::atomic_replace_os(&parent, std::ffi::OsStr::new(name), &mut &*data, None)
            .map_err(|error| if error.kind() == std::io::ErrorKind::PermissionDenied { WriteRefusal::FinalComponentSymlink } else { WriteRefusal::Io(error) })
    }

    #[cfg(windows)]
    {
        let _ = (resolved_parent, resolved_root);
        Err(WriteRefusal::UnsupportedPlatform)
    }
}

/// The beneath-walk + write, separated from the authorization step so the
/// check→open race is testable deterministically (a test can authorize on an
/// honest layout, swap an ancestor, then call THIS with the stale pair).
#[cfg(unix)]
pub(crate) fn write_beneath_root(
    resolved_root: &Path,
    resolved_parent: &Path,
    name: &str,
    data: &[u8],
) -> Result<(), WriteRefusal> {
    use std::io::Write;
    {
        // 1. Open the authorized ROOT: the anchor every later step hangs off.
        let root_fd = openat_directory_no_follow_by_path(resolved_root)
            .map_err(WriteRefusal::Io)?;
        // 2. Descend component by component beneath the root. resolved_parent
        //    is canonical (symlink-free at authorization time), so every
        //    component here names a real directory — a component swapped for
        //    a symlink since is ELOOP-refused, never followed.
        let mut current = root_fd;
        let relative = resolved_parent
            .strip_prefix(resolved_root)
            .map_err(|_| WriteRefusal::OutsideRoots)?;
        for component in relative.components() {
            let Some(step) = component.as_os_str().to_str() else {
                return Err(WriteRefusal::OutsideRoots);
            };
            if step == "." || step == ".." {
                return Err(WriteRefusal::OutsideRoots);
            }
            let next = openat_directory_no_follow(&current, step).map_err(|error| {
                // Linux returns ELOOP for O_NOFOLLOW|O_DIRECTORY on a
                // self-referential link and ENOTDIR for one pointing at a
                // directory; both mean "this component is now a symlink" —
                // the walk refuses instead of following either way.
                if matches!(error.raw_os_error(), Some(libc::ELOOP) | Some(libc::ENOTDIR)) {
                    WriteRefusal::FinalComponentSymlink
                } else {
                    WriteRefusal::Io(error)
                }
            })?;
            current = next;
        }
        // 3. The file itself, relative to the walked parent descriptor.
        let file = openat_no_follow(&current, name).map_err(|error| {
            if error.raw_os_error() == Some(libc::ELOOP) {
                WriteRefusal::FinalComponentSymlink
            } else {
                WriteRefusal::Io(error)
            }
        })?;
        let mut file = file;
        file.write_all(data).map_err(WriteRefusal::Io)?;
        file.flush().map_err(WriteRefusal::Io)?;
        Ok(())
    }
}

/// Open a directory BY PATH with O_NOFOLLOW (the root anchor: its own final
/// component refuses to be a symlink; ancestors resolve as the host's scan
/// saw them — see the function-level docs for the residual rename race).
#[cfg(unix)]
fn openat_directory_no_follow_by_path(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::fd::FromRawFd;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in path"))?;
    let fd = unsafe { libc::open(c_path.as_ptr(), flags) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fd comes from a successful open; File owns and closes it.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

/// Open one DIRECTORY component beneath `parent`, refusing a component that
/// is a symlink (O_NOFOLLOW: ELOOP) — the beneath-walk's every step.
#[cfg(unix)]
pub(crate) fn openat_directory_no_follow(
    parent: &std::fs::File,
    name: &str,
) -> std::io::Result<std::fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    let c_name = CString::new(name)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in path component"))?;
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let fd = unsafe { libc::openat(parent.as_raw_fd(), c_name.as_ptr(), flags) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fd comes from a successful openat; File owns and closes it.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn openat_no_follow(
    parent: &std::fs::File,
    name: &str,
) -> std::io::Result<std::fs::File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    // A file name must not carry an embedded NUL (it cannot on a real
    // filesystem, but the string came over IPC).
    let c_name = CString::new(name)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in file name"))?;
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // 0644 for new files (the /api/files write behavior); an existing file
    // keeps its own mode because O_CREAT on an existing file is a no-op.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), c_name.as_ptr(), flags, 0o644) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fd comes from a successful openat; File takes sole ownership
    // and closes it on drop.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

/// Whether the path carries a `..` segment (Windows separators included —
/// a backslash is a segment separator only in Windows paths, which is where
/// it matters for authorization).
fn has_parent_segment(path: &Path) -> bool {
    path.components().any(|component| matches!(component, Component::ParentDir))
        || path
            .to_string_lossy()
            .split(['/', '\\'])
            .any(|segment| segment == "..")
}

fn normalize_root(root: &Path) -> Option<String> {
    let normalized = normalize_absolute(root)?;
    Some(normalized)
}

/// Normalize an absolute path to forward slashes without a trailing slash.
/// Returns None for relative or empty paths.
fn normalize_absolute(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    #[cfg(windows)]
    let path = dunce::simplified(path);
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Prefix(prefix) => {
                // Windows drive/UNC prefix: keep its spelling (e.g. "C:").
                let text = prefix.as_os_str().to_str()?.replace('\\', "/");
                parts.push(text);
            }
            Component::Normal(part) => {
                let text = part.to_str()?.to_string();
                if text == ".." {
                    // Lexical climb: never below a root.
                    parts.pop();
                } else if !text.is_empty() && text != "." {
                    parts.push(text);
                }
            }
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
        }
    }
    if parts.is_empty() {
        return Some("/".to_string());
    }
    let joined = parts.join("/");
    if path.to_string_lossy().starts_with('/') {
        Some(format!("/{joined}"))
    } else {
        // Windows: "C:/x/y" style (or UNC //server/share).
        Some(joined)
    }
}

/// Containment: `candidate` equals or is below `root` (both normalized).
fn is_within(candidate: &str, root: &str) -> bool {
    #[cfg(windows)]
    {
        let mut parts = candidate.split('/');
        return root.split('/').all(|part| parts.next().is_some_and(|candidate| file_handle_windows::same_text(candidate, part)));
    }
    #[cfg(not(windows))]
    if candidate == root {
        return true;
    }
    #[cfg(not(windows))]
    { candidate.starts_with(root) && candidate.as_bytes().get(root.len()) == Some(&b'/') }
}

/// MIME by extension for file serving (scriptless defaults, the same map
/// the preview resource protocol uses).
pub fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "css" => "text/css; charset=utf-8",
        "txt" | "md" | "log" | "json" => {
            if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                "application/json"
            } else {
                "text/plain; charset=utf-8"
            }
        }
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn roots_with(items: &[&str]) -> AllowedRoots {
        let mut roots = AllowedRoots::new();
        for item in items {
            if Path::new(item).exists() { roots.add(Path::new(item)).unwrap(); } else { roots.add_missing(Path::new(item)); }
        }
        roots
    }

    #[cfg(unix)]
    #[test]
    fn admitted_root_handle_does_not_follow_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let old = temp.path().join("old");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("value"), b"old").unwrap();
        let mut roots = AllowedRoots::new();
        roots.add(&root).unwrap();
        let admitted = roots.open_directory(&root).unwrap();
        std::fs::rename(&root, &old).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("value"), b"replacement").unwrap();
        assert!(roots.open_directory(&root).is_err());
        crate::project_upload::atomic_replace_os(&admitted, std::ffi::OsStr::new("value"), &mut &b"admitted"[..], None).unwrap();
        assert_eq!(std::fs::read(old.join("value")).unwrap(), b"admitted");
        assert_eq!(std::fs::read(root.join("value")).unwrap(), b"replacement");
    }

    #[cfg(unix)]
    #[test]
    fn allowed_root_write_replaces_hardlink_without_truncating_other_name() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(&outside, b"outside").unwrap();
        std::fs::hard_link(&outside, root.join("value")).unwrap();
        let mut roots = AllowedRoots::new();
        roots.add(&root).unwrap();
        write_through_allowed_parent(&roots, &root.join("value"), b"new").unwrap();
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
        assert_eq!(std::fs::read(root.join("value")).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn replaced_nested_root_cannot_fall_back_to_parent_grant() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let child = root.join("child");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(child.join("value"), b"old").unwrap();
        let mut roots = AllowedRoots::new();
        roots.add(&root).unwrap();
        roots.add(&child).unwrap();
        std::fs::rename(&child, root.join("old")).unwrap();
        std::fs::create_dir(&child).unwrap();
        std::fs::write(child.join("value"), b"replacement").unwrap();
        assert!(roots.open_file(&child.join("value")).is_err());
        assert!(write_through_allowed_parent(&roots, &child.join("value"), b"changed").is_err());
        assert_eq!(std::fs::read(child.join("value")).unwrap(), b"replacement");
        roots.reauthorize(&child).unwrap();
        assert!(roots.open_file(&child.join("value")).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn pinned_walk_refuses_swapped_intermediate_link() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(root.join("inner")).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let mut roots = AllowedRoots::new();
        roots.add(&root).unwrap();
        let (_, _, admitted) = roots.admit_resolved(&root).unwrap();
        std::fs::rename(root.join("inner"), root.join("old-inner")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("inner")).unwrap();
        assert!(walk_directory(&admitted, Path::new("inner")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn directory_listing_uses_pinned_handle_after_rename() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(root.join("inside"), b"ok").unwrap();
        std::fs::write(outside.join("secret"), b"no").unwrap();
        let mut roots = AllowedRoots::new();
        roots.add(&root).expect("fixture root");
        let fd = open_directory_beneath_root(&root, &root).unwrap();
        std::fs::rename(&root, temp.path().join("old")).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();
        let entries = list_open_directory(&roots, &fd).unwrap();
        assert!(entries.iter().any(|entry| entry.name == "inside"));
        assert!(!entries.iter().any(|entry| entry.name == "secret"));
        let again = list_open_directory(&roots, &fd).unwrap();
        assert!(again.iter().any(|entry| entry.name == "inside"));
    }

    #[cfg(unix)]
    #[test]
    fn directory_listing_reports_directory_links_from_pinned_parent() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let mut roots = AllowedRoots::new();
        roots.add(&root).expect("fixture root");
        let entries = list_directory(&roots, &root).unwrap();
        let link = entries.iter().find(|entry| entry.name == "link").unwrap();
        assert!(link.is_dir);
        assert_eq!(link.outside_link_target.as_deref(), Some(outside.canonicalize().unwrap().to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn terminal_directory_handle_remains_pinned_after_rename() {
        use std::os::unix::fs::MetadataExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let cwd = root.join("cwd");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let mut roots = AllowedRoots::new();
        roots.add(&root).expect("fixture root");
        assert!(roots.open_terminal_directory(&outside).is_none());
        assert!(roots.open_terminal_directory(&root.join("../outside")).is_none());
        let expected = cwd.canonicalize().unwrap();
        let (resolved, handle) = roots.open_terminal_directory(&cwd).unwrap();
        assert_eq!(resolved, expected);
        let identity = handle.metadata().unwrap();
        std::fs::rename(&cwd, root.join("old-cwd")).unwrap();
        std::os::unix::fs::symlink(&outside, &cwd).unwrap();
        let pinned = std::fs::metadata(root.join("old-cwd")).unwrap();
        assert_eq!((identity.dev(), identity.ino()), (pinned.dev(), pinned.ino()));
        assert_ne!(identity.ino(), std::fs::metadata(&cwd).unwrap().ino());
        assert!(roots.open_terminal_directory(&cwd).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn lexical_containment_and_climbs() {
        let roots = roots_with(&["/home/u/proj"]);
        assert!(roots.is_path_allowed(Path::new("/home/u/proj")));
        assert!(roots.is_path_allowed(Path::new("/home/u/proj/src/main.rs")));
        assert!(roots.is_path_allowed(Path::new("/home/u/proj/a/../b")));
        assert!(!roots.is_path_allowed(Path::new("/home/u")));
        assert!(!roots.is_path_allowed(Path::new("/home/u/project2/x")));
        assert!(!roots.is_path_allowed(Path::new("/home/u/proj-evil/x")), "prefix is not containment");
        assert!(!roots.is_path_allowed(Path::new("relative/path")));
        // Lexical escape through ..: /home/u/proj/../.. stays inside only
        // if it lands inside.
        assert!(!roots.is_path_allowed(Path::new("/home/u/proj/../../etc/passwd")));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_refused_after_resolution() {
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).expect("proj");
        std::fs::write(project.join("a.txt"), b"x").expect("a");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        std::fs::write(outside.join("secret.txt"), b"s").expect("secret");
        std::os::unix::fs::symlink(&outside, project.join("leak")).expect("symlink");

        let mut roots = AllowedRoots::new();
        roots.add(&project).expect("fixture root");
        // Lexically inside; the resolved target escapes → refused.
        assert!(roots.is_path_allowed(&project.join("leak/secret.txt")));
        assert!(!roots.is_existing_path_allowed(&project.join("leak/secret.txt")));
        // A real file inside passes both.
        assert!(roots.is_existing_path_allowed(&project.join("a.txt")));
        // New-file authorization goes through the resolved PARENT: a plain
        // new name inside the project passes, a symlink final component
        // (the write would follow it outside) is refused, and a `..` in the
        // spelling is refused before any resolution (#748).
        assert!(roots.is_new_path_allowed(&project.join("brand-new.txt")));
        std::os::unix::fs::symlink("/etc", project.join("leakdir")).expect("leakdir");
        assert!(!roots.is_new_path_allowed(&project.join("leakdir/evil")));
        assert!(!roots.is_existing_path_allowed(&project.join("leakdir")));
        assert!(!roots.is_new_path_allowed(&project.join("../outside/evil")));
    }

    #[cfg(unix)]
    #[test]
    fn default_cwd_roots_scan_the_home_layout() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("pi-cwd-20260101")).expect("one");
        std::fs::create_dir_all(dir.path().join("pi-cwd-not-a-date")).expect("two");
        let mut roots = AllowedRoots::new();
        roots.add_default_cwd_roots(dir.path()).unwrap();
        assert!(!roots.is_path_allowed(&dir.path().join("pi-cwd")));
        assert!(roots.is_path_allowed(&dir.path().join("pi-cwd-20260101/inner")));
        assert!(!roots.is_path_allowed(&dir.path().join("pi-cwd-not-a-date")));
    }
}

// ============================================================================
// Directory listing (the /api/files type=list contract)
// ============================================================================

/// Conventionally generated names hidden where no Git work tree covers the
/// directory (lib/file-tree-visibility.ts HIDDEN_NAMES).
const HIDDEN_NAMES: [&str; 13] = [
    "node_modules", ".git", ".next", "dist", "build", "__pycache__", ".turbo",
    ".cache", "coverage", ".pytest_cache", ".mypy_cache", "target", "vendor",
];
/// Hidden whatever a repository says about them.
const ALWAYS_HIDDEN_NAMES: [&str; 2] = [".git", ".DS_Store"];
const HIDDEN_SUFFIXES: [&str; 1] = [".pyc"];

/// The name-based rule for directories no Git work tree covers.
pub(crate) fn is_hidden_outside_git(name: &str) -> bool {
    HIDDEN_NAMES.contains(&name)
        || ALWAYS_HIDDEN_NAMES.contains(&name)
        || HIDDEN_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

/// Run git in `directory`; None when it is missing, fails or times out (the
/// TS rules: never stall the tree on a slow git, degrade to the name list).
#[cfg(unix)]
fn run_git(directory: &std::fs::File, args: &[&str]) -> Option<String> {
    let mut command = std::process::Command::new("git");
    git_directory(&mut command, directory);
    let output = command
        // A repository-configured fsmonitor hook must not run (expanding a
        // folder must never execute repo-configured commands).
        .args(["-c", "core.fsmonitor=false"])
        .args(args)
        .env("LC_ALL", "C")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output();
    let output = output.ok()?;
    let code = output.status.code()?;
    if code != 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// One listed entry (the wire shape FileExplorer consumes).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: String,
    /// A directory entry that is a symlink resolving OUTSIDE the roots: the
    /// explorer offers "browse the link target" (an explicit, confirmed
    /// grant) instead of silently refusing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outside_link_target: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub outside_link_encloses: bool,
}

/// List one directory inside the allowed roots (the /api/files type=list
/// contract): visibility by Git where it has a view of the directory (a
/// tracked `build/` stays visible, #677), the name list otherwise; dirs
/// first then files, both alphabetically; a directory symlink resolving
/// outside the roots carries `outsideLinkTarget` for the confirmation flow.
#[cfg(unix)]
pub fn list_directory(roots: &AllowedRoots, directory: &Path) -> Result<Vec<ListedEntry>, String> {
    let walked = roots.open_directory(directory).map_err(|e| e.to_string())?;
    list_open_directory(roots, &walked)
}

#[cfg(windows)]
pub fn list_directory(roots: &AllowedRoots, directory: &Path) -> Result<Vec<ListedEntry>, String> {
    let handle = roots.open_directory(directory).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for (name, is_dir, reparse) in file_handle_windows::entries(&handle).map_err(|e| e.to_string())? {
        let name = name.to_str().ok_or("Directory contains a non-Unicode name")?.to_owned();
        if is_hidden_outside_git(&name) { continue; }
        entries.push(ListedEntry { name, is_dir: is_dir && !reparse, size: 0, modified: String::new(), outside_link_target: None, outside_link_encloses: false });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

#[cfg(unix)]
fn list_open_directory(roots: &AllowedRoots, walked: &std::fs::File) -> Result<Vec<ListedEntry>, String> {
    let dirents = directory_entries(walked).map_err(|e| e.to_string())?;
    let names: Vec<String> = dirents.iter().map(|name| name.to_string_lossy().into_owned()).collect();
    let visibility = directory_visibility(walked, &names);
    let mut entries = Vec::new();
    for entry in &dirents {
        let name = entry.to_string_lossy().into_owned();
        if !visibility(&name) { continue; }
        let Some((is_dir, target)) = directory_entry_info(walked, entry) else { continue };
        let outside_link_target = target.filter(|target| !roots.is_existing_path_allowed(target))
            .map(|target| target.to_string_lossy().into_owned());
        let outside_link_encloses = outside_link_target.as_deref().map(Path::new).map(encloses_home_or_root).unwrap_or(false);
        entries.push(ListedEntry {
            name,
            is_dir,
            size: 0,      // the TS shape carries 0 (no per-entry stat)
            modified: String::new(), // ditto
            outside_link_target,
            outside_link_encloses,
        });
    }
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return if a.is_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a.name.cmp(&b.name)
    });
    Ok(entries)
}

/// Whether allowing `target` would also open the project or the home folder
/// (a link to `/`, `~` or a parent of the project — lib/linked-directory.ts
/// enclosesProjectOrHome): the explorer confirms harder for these.
fn encloses_home_or_root(target: &Path) -> bool {
    let target = target.to_string_lossy().into_owned();
    let target = target.trim_end_matches('/');
    if target.is_empty() {
        return true; // "/"
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = home.to_string_lossy().into_owned();
        let home = home.trim_end_matches('/');
        if home == target || target.len() < home.len() {
            // A target above (or equal to) the home folder encloses it.
            return home.starts_with(target) && !target.is_empty();
        }
    }
    false
}

/// Build the visibility predicate for one directory listing: Git's tracked
/// set overrides its ignore matches (a tracked `build/` stays visible);
/// outside a work tree the fixed name list applies.
#[cfg(unix)]
fn directory_visibility<'a>(
    directory: &'a std::fs::File,
    names: &'a [String],
) -> impl Fn(&str) -> bool + 'a {
    let tracked = read_tracked_names(directory, names);
    let ignored = read_ignored_names(directory, names);
    let have_git_view = tracked.is_some();
    let tracked = tracked.unwrap_or_default();
    let ignored = ignored.unwrap_or_default();
    move |name: &str| {
        if ALWAYS_HIDDEN_NAMES.contains(&name) {
            return false;
        }
        if !have_git_view {
            return !is_hidden_outside_git(name);
        }
        if tracked.contains(name) {
            return true;
        }
        !ignored.contains(name)
    }
}

/// Names Git tracks at or below (the first path segment of every ls-files
/// record). None when git has no view of the directory.
#[cfg(unix)]
fn read_tracked_names(directory: &std::fs::File, names: &[String]) -> Option<std::collections::HashSet<String>> {
    let mut tracked = std::collections::HashSet::new();
    // Pathspec batches keep the command line well inside the OS limit.
    let mut batch: Vec<&str> = Vec::new();
    let mut size = 0usize;
    let flush = |batch: &mut Vec<&str>, tracked: &mut std::collections::HashSet<String>| -> Option<()> {
        if batch.is_empty() {
            return Some(());
        }
        let mut args: Vec<&str> = vec!["--literal-pathspecs", "ls-files", "-z", "--cached", "--"];
        args.extend(batch.iter().copied());
        let stdout = run_git(directory, &args)?;
        for record in stdout.split('\0') {
            if !record.is_empty() {
                tracked.insert(record.split('/').next().unwrap_or(record).to_string());
            }
        }
        batch.clear();
        Some(())
    };
    for name in names {
        if !batch.is_empty() && size + name.len() + 1 > 16_000 {
            flush(&mut batch, &mut tracked)?;
        }
        batch.push(name);
        size += name.len() + 1;
    }
    flush(&mut batch, &mut tracked)?;
    Some(tracked)
}

/// Names Git ignores (check-ignore --no-index: one process for every name,
/// no index read). None when git has no view.
#[cfg(unix)]
fn read_ignored_names(directory: &std::fs::File, names: &[String]) -> Option<std::collections::HashSet<String>> {
    if names.is_empty() {
        return Some(std::collections::HashSet::new());
    }
    // Feed the names on stdin (no command-line length limit). With -z the
    // INPUT is NUL-separated too (verified against git: a newline-fed -z
    // stdin matches nothing and exits 1).
    let stdin_data = {
        let mut data = names.join("\u{0}");
        data.push('\u{0}');
        data
    };
    let mut command = std::process::Command::new("git");
    git_directory(&mut command, directory);
    let output = command
        .args(["-c", "core.fsmonitor=false"])
        .args(["check-ignore", "--no-index", "-z", "--stdin"])
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()
        .and_then(|mut child| {
            use std::io::Write;
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(stdin_data.as_bytes());
            }
            drop(child.stdin.take());
            child.wait_with_output().ok()
        })?;
    // 1 = at least one name ignored (success for our purpose), 128 = not a
    // repository, 129 = bad usage: only 0/1 carry a view.
    let code = output.status.code()?;
    if code != 0 && code != 1 {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut ignored = std::collections::HashSet::new();
    for record in stdout.split('\0') {
        if !record.is_empty() {
            ignored.insert(record.split('/').next().unwrap_or(record).to_string());
        }
    }
    Some(ignored)
}

/// The outcome of a linked-directory browse request (the
/// /api/files allow-link contract mapped onto protocol codes).
pub enum LinkApproval {
    /// Approved: `target` is the resolved directory to grant.
    Ok { target: String, already_allowed: bool },
    /// Refused with a protocol error code and message.
    Denied { code: &'static str, error: &'static str },
}

/// Validate an operator's request to browse a directory link's target
/// (checkLinkedDirectoryApproval): the link must sit inside the roots after
/// resolution (a link reached through a never-allowed link does not
/// qualify), actually BE a symlink to a directory, and still point at the
/// target the listing showed — a link re-aimed since the listing is
/// refused, never granted blind.
pub fn check_linked_directory_approval(
    roots: &AllowedRoots,
    link: &Path,
    expected_target: &str,
) -> LinkApproval {
    if !roots.is_path_allowed(link) {
        return LinkApproval::Denied { code: "unauthorized_scope", error: "Access denied" };
    }
    let Some(parent) = link.parent() else {
        return LinkApproval::Denied { code: "unauthorized_scope", error: "Access denied" };
    };
    if !roots.is_existing_path_allowed(parent) {
        return LinkApproval::Denied { code: "unauthorized_scope", error: "Access denied" };
    }
    let stat = match std::fs::symlink_metadata(link) {
        Ok(stat) => stat,
        Err(_) => return LinkApproval::Denied { code: "not_found", error: "Not found" },
    };
    if !stat.file_type().is_symlink() {
        return LinkApproval::Denied { code: "invalid_args", error: "Not a linked directory" };
    }
    let target = match std::fs::canonicalize(link) {
        Ok(target) => target,
        Err(_) => return LinkApproval::Denied { code: "not_found", error: "Link target not found" },
    };
    match std::fs::metadata(&target) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return LinkApproval::Denied { code: "invalid_args", error: "Not a linked directory" },
        Err(_) => return LinkApproval::Denied { code: "not_found", error: "Link target not found" },
    }
    let target_text = target.to_string_lossy().into_owned();
    // Same-spelling comparison after resolution (samePath): a link re-aimed
    // since the listing is a conflict, not a silent grant of the new target.
    let expected = std::path::absolute(expected_target)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| expected_target.to_string());
    let same = if cfg!(windows) {
        target_text.eq_ignore_ascii_case(&expected)
    } else {
        target_text == expected
    };
    if !same {
        return LinkApproval::Denied {
            code: "invalid_args",
            error: "Link target changed; refresh the file list",
        };
    }
    let already_allowed = roots.is_existing_path_allowed(&target);
    LinkApproval::Ok { target: target_text, already_allowed }
}

/// Test seam for the check→open race: the walk with a caller-supplied
/// (possibly stale) authorized pair — production always authorizes freshly
/// inside write_through_allowed_parent.
#[cfg(all(unix, test))]
#[doc(hidden)]
pub fn write_beneath_root_for_tests(
    resolved_root: &Path,
    resolved_parent: &Path,
    name: &str,
    data: &[u8],
) -> Result<(), WriteRefusal> {
    write_beneath_root(resolved_root, resolved_parent, name, data)
}

/// A read authorized against the roots: the CANONICALIZED target (symlinks
/// resolved — a link inside the roots to another location inside the roots
/// reads its target, the /api/files semantics) must sit inside a
/// canonicalized root. Returns (canonical target, canonical root) — the
/// pair a beneath-walk descends without ever resolving a symlink again.
pub fn resolved_read_target_with_root(
    roots: &AllowedRoots,
    target: &Path,
) -> Option<(PathBuf, PathBuf)> {
    if has_parent_segment(target) {
        return None;
    }
    if !roots.is_path_allowed(target) {
        return None;
    }
    let resolved = std::fs::canonicalize(target).ok()?;
    for root in &roots.roots {
        let Some(resolved_root) = roots.unchanged_root(root) else {
            continue;
        };
        if resolved.starts_with(&resolved_root) {
            return Some((resolved, resolved_root));
        }
    }
    None
}

/// Read a file through the beneath-walk (the read twin of
/// write_beneath_root): descend from the authorized ROOT's descriptor with
/// openat(O_DIRECTORY|O_NOFOLLOW) per component, then openat the file
/// itself O_NOFOLLOW — a final component (or any ancestor) swapped for a
/// symlink after authorization refuses instead of reading outside the
/// roots. Same residual rename race as the write path (documented there).
#[cfg(unix)]
pub fn read_beneath_root(
    resolved_root: &Path,
    resolved_target: &Path,
) -> Result<Vec<u8>, std::io::Error> {
    let mut file = open_file_beneath_root(resolved_root, resolved_target)?;
    let mut data = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut data)?;
    Ok(data)
}

/// Pin the authorized regular file; callers can safely retain the descriptor.
#[cfg(unix)]
pub fn open_file_beneath_root(
    resolved_root: &Path,
    resolved_target: &Path,
) -> Result<std::fs::File, std::io::Error> {
    let root_fd = openat_directory_no_follow_by_path(resolved_root)?;
    let relative = resolved_target.strip_prefix(resolved_root)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::PermissionDenied, "outside the root"))?;
    open_file_relative(&root_fd, relative)
}

#[cfg(unix)]
fn open_file_relative(root: &std::fs::File, relative: &Path) -> std::io::Result<std::fs::File> {
    use std::os::fd::FromRawFd;
    let mut current = root.try_clone()?;
    let mut components: Vec<&str> = Vec::new();
    for component in relative.components() {
        let Some(step) = component.as_os_str().to_str() else {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "bad component"));
        };
        if step == "." || step == ".." {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "bad component"));
        }
        components.push(step);
    }
    let (name, dirs) = components
        .split_last()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::PermissionDenied, "the root itself is not a file"))?;
    for step in dirs {
        current = openat_directory_no_follow(&current, step)?;
    }
    let c_name = std::ffi::CString::new(*name)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL in file name"))?;
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    use std::os::fd::AsRawFd;
    let fd = unsafe { libc::openat(current.as_raw_fd(), c_name.as_ptr(), flags) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fd from a successful openat; File owns and closes it.
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "not a regular file"));
    }
    Ok(file)
}

/// Open the directory at `resolved_target` by WALKING from the authorized
/// root's descriptor (openat O_DIRECTORY|O_NOFOLLOW per component) — the
/// listing twin of the write/read walks. A component swapped for a symlink
/// refuses; nothing below the root is ever resolved through a link.
#[cfg(unix)]
pub fn open_directory_beneath_root(
    resolved_root: &Path,
    resolved_target: &Path,
) -> std::io::Result<std::fs::File> {
    let root_fd = openat_directory_no_follow_by_path(resolved_root)?;
    let relative = resolved_target.strip_prefix(resolved_root)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::PermissionDenied, "outside the root"))?;
    walk_directory(&root_fd, relative)
}

#[cfg(unix)]
fn walk_directory(root: &std::fs::File, relative: &Path) -> std::io::Result<std::fs::File> {
    let mut current = root.try_clone()?;
    for component in relative.components() {
        let Some(step) = component.as_os_str().to_str() else {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "bad component"));
        };
        if step == "." || step == ".." {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "bad component"));
        }
        current = openat_directory_no_follow(&current, step)?;
    }
    Ok(current)
}
