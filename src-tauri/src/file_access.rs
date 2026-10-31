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
            let Ok(resolved_root) = std::fs::canonicalize(PathBuf::from(root)) else {
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
        write_beneath_root(&resolved_root, &resolved_parent, name, data)
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
fn run_git(directory: &Path, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(directory)
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
pub fn list_directory(roots: &AllowedRoots, directory: &Path) -> Result<Vec<ListedEntry>, String> {
    // Authorize on the canonical form (a directory symlink inside the roots
    // pointing inside the roots lists its target — the /api/files
    // semantics), then LIST THROUGH THE WALKED DESCRIPTOR so a component
    // swapped for a symlink after the check cannot redirect the listing
    // outside the roots. On Linux the fd lists via /proc/self/fd; elsewhere
    // the fd is (dev,ino)-verified against the canonical path and the
    // listing re-opens that path (the rename race remains, documented with
    // the write path).
    let Some((resolved_dir, resolved_root)) = resolved_read_target_with_root(roots, directory)
    else {
        return Err("the path is outside the allowed roots".to_string());
    };
    #[cfg(unix)]
    let dirents: Vec<std::fs::DirEntry> = {
        let walked = open_directory_beneath_root(&resolved_root, &resolved_dir)
            .map_err(|error| error.to_string())?;
        if !walked.metadata().map_err(|error| error.to_string())?.is_dir() {
            return Err("Not a directory".to_string());
        }
        #[cfg(target_os = "linux")]
        {
            let via_fd = format!("/proc/self/fd/{}", {
                use std::os::fd::AsRawFd;
                walked.as_raw_fd()
            });
            std::fs::read_dir(via_fd)
                .map_err(|error| error.to_string())?
                .flatten()
                .collect()
        }
        #[cfg(not(target_os = "linux"))]
        {
            // Verify the walked fd IS the canonical directory, then read the
            // canonical path (macOS has no /proc).
            use std::os::unix::fs::MetadataExt;
            let walked_meta = walked.metadata().map_err(|error| error.to_string())?;
            let path_meta = std::fs::metadata(&resolved_dir).map_err(|error| error.to_string())?;
            if walked_meta.dev() != path_meta.dev() || walked_meta.ino() != path_meta.ino() {
                return Err("the path is outside the allowed roots".to_string());
            }
            std::fs::read_dir(&resolved_dir)
                .map_err(|error| error.to_string())?
                .flatten()
                .collect()
        }
    };
    #[cfg(windows)]
    let dirents: Vec<std::fs::DirEntry> = {
        let _ = (resolved_dir, resolved_root);
        return Err("listing is not supported on this platform until the handle-based implementation ships".to_string());
    };
    let names: Vec<String> = dirents.iter().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    // Visibility: Git's view first (tracked wins over ignored), the fixed
    // name list where git has no view (missing, outside a work tree, failed).
    let visibility = directory_visibility(&resolved_dir, &names);

    let mut entries: Vec<ListedEntry> = Vec::new();
    for entry in &dirents {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !visibility(&name) {
            continue;
        }
        // Every probe goes through the CANONONICAL directory path, never the
        // /proc/self/fd listing path (stat through an fd link component is
        // not portable); the fd only sourced the NAME list.
        let entry_path = resolved_dir.join(&name);
        // Avoid per-entry stat where the dirent type is known; symlinks and
        // filesystems without type info fall back to metadata.
        let file_type = entry.file_type().ok();
        let is_dir = match file_type {
            Some(kind) if kind.is_dir() => true,
            Some(kind) if kind.is_file() => false,
            _ => match std::fs::metadata(&entry_path) {
                Ok(meta) => meta.is_dir(),
                Err(_) => continue, // raced away: skip, not an error
            },
        };
        // A directory whose dirent says "file" is a SYMLINK to a directory
        // (the TS resolveDirentIsDirectory fallback): report it as a dir and
        // resolve whether it lands outside the roots.
        let mut outside_link_target = None;
        let mut outside_link_encloses = false;
        let is_symlink_dir = is_dir && file_type.map(|kind| !kind.is_dir()).unwrap_or(false);
        if is_symlink_dir || (is_dir && std::fs::symlink_metadata(&entry_path).map(|m| m.file_type().is_symlink()).unwrap_or(false)) {
            if let Ok(resolved) = std::fs::canonicalize(&entry_path) {
                if !roots.is_existing_path_allowed(&resolved) {
                    outside_link_target = Some(resolved.to_string_lossy().into_owned());
                    outside_link_encloses = encloses_home_or_root(&resolved);
                }
            }
        }
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
fn directory_visibility<'a>(
    directory: &'a Path,
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
fn read_tracked_names(directory: &Path, names: &[String]) -> Option<std::collections::HashSet<String>> {
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
fn read_ignored_names(directory: &Path, names: &[String]) -> Option<std::collections::HashSet<String>> {
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
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(directory)
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
        let Ok(resolved_root) = std::fs::canonicalize(PathBuf::from(root)) else {
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
    use std::os::fd::FromRawFd;
    let root_fd = openat_directory_no_follow_by_path(resolved_root)?;
    let mut current = root_fd;
    let relative = resolved_target
        .strip_prefix(resolved_root)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::PermissionDenied, "outside the root"))?;
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
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    use std::os::fd::AsRawFd;
    let fd = unsafe { libc::openat(current.as_raw_fd(), c_name.as_ptr(), flags) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fd from a successful openat; File owns and closes it.
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let mut data = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut data)?;
    Ok(data)
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
    let mut current = root_fd;
    let relative = resolved_target
        .strip_prefix(resolved_root)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::PermissionDenied, "outside the root"))?;
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
