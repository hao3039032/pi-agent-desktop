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
        if !self.is_path_allowed(target) {
            return false;
        }
        let Ok(resolved_target) = std::fs::canonicalize(target) else {
            return false;
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
