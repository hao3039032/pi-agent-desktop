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
fn is_hidden_outside_git(name: &str) -> bool {
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
    if !roots.is_existing_path_allowed(directory) {
        return Err("the path is outside the allowed roots".to_string());
    }
    let meta = std::fs::symlink_metadata(directory).map_err(|error| error.to_string())?;
    if !meta.is_dir() {
        return Err("Not a directory".to_string());
    }
    let dirents: Vec<std::fs::DirEntry> = std::fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .flatten()
        .collect();
    let names: Vec<String> = dirents.iter().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();

    // Visibility: Git's view first (tracked wins over ignored), the fixed
    // name list where git has no view (missing, outside a work tree, failed).
    let visibility = directory_visibility(directory, &names);

    let mut entries: Vec<ListedEntry> = Vec::new();
    for entry in &dirents {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !visibility(&name) {
            continue;
        }
        // Avoid per-entry stat where the dirent type is known; symlinks and
        // filesystems without type info fall back to metadata.
        let file_type = entry.file_type().ok();
        let is_dir = match file_type {
            Some(kind) if kind.is_dir() => true,
            Some(kind) if kind.is_file() => false,
            _ => match std::fs::metadata(entry.path()) {
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
        if is_symlink_dir || (is_dir && std::fs::symlink_metadata(entry.path()).map(|m| m.file_type().is_symlink()).unwrap_or(false)) {
            if let Ok(resolved) = std::fs::canonicalize(entry.path()) {
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
