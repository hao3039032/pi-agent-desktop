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

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

/// The allowed-root set (normalized, forward-slash, trailing-slash-free).
#[derive(Debug, Default, Clone)]
pub struct AllowedRoots {
    roots: BTreeSet<String>,
}

impl AllowedRoots {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a root (normalized: forward slashes, no trailing slash; empty or
    /// relative roots are ignored — an allow-list root is absolute).
    pub fn add(&mut self, root: &Path) {
        if let Some(normalized) = normalize_root(root) {
            self.roots.insert(normalized);
        }
    }

    /// The `~/pi-cwd` and `~/pi-cwd-YYYYMMDD` scan roots (the legacy
    /// default-cwd layouts stay browsable across restarts).
    pub fn add_default_cwd_roots(&mut self, home: &Path) {
        self.add(&home.join("pi-cwd"));
        if let Ok(entries) = std::fs::read_dir(home) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.len() == 15
                    && name.starts_with("pi-cwd-")
                    && name[8..].chars().all(|c| c.is_ascii_digit())
                {
                    self.add(&entry.path());
                }
            }
        }
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
        self.is_existing_path_allowed_at(target, true)
    }

    /// Authorization for a path that may not exist yet (a new file):
    /// the RESOLVED PARENT must sit inside a resolved root and the final
    /// component must be a plain name (never `..`, never empty) — the
    /// /api/files rule (existingAuthorizationPath = dirname for new files).
    /// A symlink final component therefore never authorizes: the write
    /// would follow it outside the roots.
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
            let root_path = PathBuf::from(root);
            let Ok(resolved_root) = std::fs::canonicalize(&root_path) else {
                continue;
            };
            if resolved_target.starts_with(&resolved_root) {
                return true;
            }
        }
        false
    }

    /// The canonical, resolved PARENT of a write target, authorized against
    /// the resolved roots. Returns None when the parent does not resolve or
    /// escapes the roots. This is the ONE authorization point for writes:
    /// the final component is never resolved here (that is the open's job,
    /// symlink-refusing — see write_through_allowed_parent).
    pub fn resolved_write_parent(&self, target: &Path) -> Option<PathBuf> {
        if has_parent_segment(target) {
            return None;
        }
        if !self.is_path_allowed(target) {
            return None;
        }
        let parent = target.parent()?;
        let resolved = std::fs::canonicalize(parent).ok()?;
        for root in &self.roots {
            let Ok(resolved_root) = std::fs::canonicalize(PathBuf::from(root)) else {
                continue;
            };
            if resolved.starts_with(&resolved_root) {
                return Some(resolved);
            }
        }
        None
    }
}

/// Why a checked write was refused (the protocol error's details).
#[derive(Debug)]
pub enum WriteRefusal {
    /// The path (parent) is not inside the allowed roots.
    OutsideRoots,
    /// The final component is a symlink: the write would follow it.
    FinalComponentSymlink,
    /// The filesystem refused the open/write.
    Io(std::io::Error),
}

impl std::fmt::Display for WriteRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteRefusal::OutsideRoots => write!(f, "the path is outside the allowed roots"),
            WriteRefusal::FinalComponentSymlink => {
                write!(f, "the final path component is a symbolic link")
            }
            WriteRefusal::Io(error) => write!(f, "{error}"),
        }
    }
}

/// Write `data` at `target`, refusing to follow a symlinked FINAL component
/// and closing the authorization→open TOCTOU window:
///
/// - the parent is canonicalized and authorized INSIDE this function (the
///   caller passes the roots, never a pre-computed verdict);
/// - Unix: the open happens `openat(dirfd, name, O_NOFOLLOW)` on a directory
///   descriptor opened O_NOFOLLOW itself — the name resolves atomically
///   against the FIXED directory, so swapping the parent for a symlink (or
///   the final component between check and open) cannot redirect the write;
/// - Windows (untested here): the canonicalized parent is prefixed `\\?\`
///   (no reparse resolution) and the final component is checked as a
///   reparse point, refusing known link types before the write.
pub fn write_through_allowed_parent(
    roots: &AllowedRoots,
    target: &Path,
    data: &[u8],
) -> Result<(), WriteRefusal> {
    use std::io::Write;
    let Some(resolved_parent) = roots.resolved_write_parent(target) else {
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
        use std::os::unix::fs::OpenOptionsExt;
        // O_NOFOLLOW on the directory: a parent swapped to a symlink between
        // the canonicalize above and this open refuses rather than resolving
        // through the link.
        let parent_fd = std::fs::File::options()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
            .open(&resolved_parent)
            .map_err(WriteRefusal::Io)?;
        // openat against the fixed descriptor with O_NOFOLLOW: a symlinked
        // final component is ELOOP, atomically — no window between an
        // lstat check and the open.
        let file = openat_no_follow(&parent_fd, name).map_err(|error| {
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

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // The canonicalized parent with the NT prefix keeps the path from
        // being re-resolved through intermediate reparse points.
        let full = std::path::PathBuf::from(format!(
            "\\\\?\\{}\\{}",
            resolved_parent.to_string_lossy().replace('/', "\\"),
            name
        ));
        // A reparse-point final component (symlink/junction) is REFUSED:
        // probe with FILE_FLAG_OPEN_REPARSE_POINT (which opens the link
        // itself instead of following it) and inspect the file type.
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        let probe = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&full);
        match probe {
            Ok(handle) => {
                let meta = handle.metadata().map_err(WriteRefusal::Io)?;
                drop(handle);
                if meta.file_type().is_symlink() {
                    return Err(WriteRefusal::FinalComponentSymlink);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // A new file: no reparse point to refuse.
            }
            Err(error) => return Err(WriteRefusal::Io(error)),
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&full)
            .map_err(WriteRefusal::Io)?;
        file.write_all(data).map_err(WriteRefusal::Io)?;
        file.flush().map_err(WriteRefusal::Io)?;
        Ok(())
    }
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
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Prefix(prefix) => {
                // Windows drive/UNC prefix: keep its spelling (e.g. "C:").
                let text = prefix.as_os_str().to_string_lossy().replace('\\', "/");
                parts.push(text);
            }
            Component::Normal(part) => {
                let text = part.to_string_lossy().to_string();
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
    if candidate == root {
        return true;
    }
    candidate.starts_with(root) && candidate.as_bytes().get(root.len()) == Some(&b'/')
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
            roots.add(Path::new(item));
        }
        roots
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
        roots.add(&project);
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
        roots.add_default_cwd_roots(dir.path());
        assert!(roots.is_path_allowed(&dir.path().join("pi-cwd")));
        assert!(roots.is_path_allowed(&dir.path().join("pi-cwd-20260101/inner")));
        assert!(!roots.is_path_allowed(&dir.path().join("pi-cwd-not-a-date")));
    }
}
