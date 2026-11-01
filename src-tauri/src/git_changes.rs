//! Git status and file diffs for the workspace panel.
use std::path::{Path, PathBuf};
use std::time::Duration;
use serde_json::{json, Value};
use crate::file_access::AllowedRoots;
#[cfg(test)]
#[path = "git_changes_tests.rs"]
mod tests;

#[cfg(unix)]
pub(crate) type CheckoutStamp = ((u64, u64, i64, i64), (u64, u64, i64, i64, u64));
#[cfg(not(unix))]
pub(crate) type CheckoutStamp = ();

pub(crate) struct GitCwd {
    pub(crate) path: PathBuf,
    #[cfg(unix)]
    directory: std::fs::File,
}
impl GitCwd {
    pub(crate) fn open(roots: &AllowedRoots, cwd: &Path) -> Result<Self, String> {
        #[cfg(unix)]
        {
            let (path, directory) = roots.open_terminal_directory(cwd).ok_or("Git cwd is not authorized")?;
            Ok(Self { path, directory })
        }
        #[cfg(not(unix))]
        { let _ = roots; Ok(Self { path: cwd.to_path_buf() }) }
    }
    pub(crate) fn git(&self, args: &[&str]) -> Result<String, String> {
        self.git_timeout(args, Duration::from_secs(10))
    }
    pub(crate) fn git_timeout(&self, args: &[&str], timeout: Duration) -> Result<String, String> {
        let mut argv = vec!["--no-optional-locks", "--literal-pathspecs"];
        argv.extend_from_slice(args);
        #[cfg(unix)]
        { crate::worktrees::git_in_directory(&self.directory, &argv, timeout) }
        #[cfg(not(unix))]
        { crate::worktrees::git(&self.path, &argv, timeout) }
    }
    #[cfg(unix)]
    pub(crate) fn pin_repository(&self, _roots: &AllowedRoots, root: &Path) -> Result<Self, String> {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::fs::MetadataExt;
        let relative = self.path.strip_prefix(root).map_err(|_| "Git repository is outside cwd ancestry")?;
        let visible_cwd = std::fs::metadata(&self.path).map_err(|e| e.to_string())?;
        let held_cwd = self.directory.metadata().map_err(|e| e.to_string())?;
        if (visible_cwd.dev(), visible_cwd.ino()) != (held_cwd.dev(), held_cwd.ino()) { return Err("Git cwd identity changed".into()); }
        let mut ancestor = self.directory.try_clone().map_err(|e| e.to_string())?;
        for _ in relative.components() {
            let fd = unsafe { libc::openat(ancestor.as_raw_fd(), c"..".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
            if fd < 0 { return Err(std::io::Error::last_os_error().to_string()); }
            ancestor = unsafe { std::fs::File::from_raw_fd(fd) };
        }
        let visible = crate::file_access::open_directory_beneath_root(root, root).map_err(|e| e.to_string())?;
        let a = ancestor.metadata().map_err(|e| e.to_string())?;
        let b = visible.metadata().map_err(|e| e.to_string())?;
        if (a.dev(), a.ino()) != (b.dev(), b.ino()) { return Err("Git repository identity changed".into()); }
        Ok(Self { path: root.to_path_buf(), directory: ancestor })
    }
    #[cfg(not(unix))]
    pub(crate) fn pin_repository(&self, roots: &AllowedRoots, root: &Path) -> Result<Self, String> { Self::open(roots, root) }
    #[cfg(unix)]
    pub(crate) fn checkout_stamp(&self) -> Result<CheckoutStamp, String> {
        use std::os::unix::fs::MetadataExt;
        let held = self.directory.metadata().map_err(|e| e.to_string())?;
        let visible = std::fs::symlink_metadata(&self.path).map_err(|e| e.to_string())?;
        if !visible.is_dir() || (held.dev(), held.ino()) != (visible.dev(), visible.ino()) {
            return Err("Git checkout identity changed".into());
        }
        let marker = std::fs::symlink_metadata(self.path.join(".git")).map_err(|e| e.to_string())?;
        if !marker.is_dir() { return Err("Git metadata pointer identity cannot be verified".into()); }
        Ok(((held.dev(), held.ino(), held.ctime(), held.ctime_nsec()),
            (marker.dev(), marker.ino(), marker.ctime(), marker.ctime_nsec(), marker.len())))
    }
    #[cfg(not(unix))]
    pub(crate) fn checkout_stamp(&self) -> Result<(), String> { Err("Git checkout identity is unavailable".into()) }
    fn pathspec(&self, root: &Path, path: &Path) -> Option<String> {
        let prefix = self.path.strip_prefix(root).ok()?;
        let relative = path.strip_prefix(root).ok()?;
        let mut spec = PathBuf::new();
        for _ in prefix.components() { spec.push(".."); }
        spec.push(relative);
        Some(if spec.as_os_str().is_empty() { ".".into() } else { spec.to_string_lossy().into_owned() })
    }
}
struct Entry { path: String, original: Option<String>, index: char, worktree: char }
fn entries(cwd: &GitCwd) -> Result<Vec<Entry>, String> {
    let output = cwd.git(&["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    let mut records = output.split('\0'); let mut result = Vec::new();
    while let Some(record) = records.next() {
        let bytes = record.as_bytes(); if bytes.len() < 4 || bytes[2] != b' ' { continue; }
        let index = bytes[0] as char; let worktree = bytes[1] as char;
        let original = if "RC".contains(index) || "RC".contains(worktree) { records.next().map(str::to_string) } else { None };
        result.push(Entry { path: record[3..].to_string(), original, index, worktree });
    }
    Ok(result)
}
fn classify(e: &Entry) -> (&'static str, &'static str) {
    let pair = format!("{}{}", e.index, e.worktree);
    if pair == "??" { ("untracked", "U") }
    else if ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].contains(&pair.as_str()) || pair.contains('U') { ("conflict", "C") }
    else if pair.contains('D') { ("deleted", "D") }
    else if pair.contains('R') || pair.contains('C') { ("renamed", "R") }
    else if pair.contains('A') { ("added", "A") }
    else { ("modified", "M") }
}
pub(crate) fn repository(cwd: &GitCwd) -> Result<Option<PathBuf>, String> {
    match cwd.git(&["rev-parse", "--show-toplevel"]) {
        Ok(output) => Ok(Some(PathBuf::from(output.trim()))),
        Err(error) if error.contains("not a git repository") => Ok(None),
        Err(error) => Err(error),
    }
}
fn text_file(roots: &AllowedRoots, path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 256 * 1024 { return None; }
    #[cfg(unix)]
    let bytes = { let (resolved, root) = crate::file_access::resolved_read_target_with_root(roots, path)?; crate::file_access::read_beneath_root(&root, &resolved).ok()? };
    #[cfg(not(unix))]
    let bytes: Vec<u8> = { let _ = roots; return None; };
    if bytes.len() > 256 * 1024 || bytes.contains(&0) { return None; }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}
fn added_patch(path: &str, text: &str) -> String {
    let lines: Vec<_> = text.split_terminator('\n').collect();
    let body = lines.iter().map(|line| format!("+{line}")).collect::<Vec<_>>().join("\n");
    let marker = if !text.ends_with('\n') && !lines.is_empty() { "\n\\ No newline at end of file" } else { "" };
    format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n{body}{marker}", lines.len())
}
pub fn status(roots: &AllowedRoots, cwd: &Path) -> Result<Value, String> {
    let anchor = GitCwd::open(roots, cwd)?;
    let Some(root) = repository(&anchor)? else { return Ok(json!({"isGitRepository":false,"repositoryRoot":null,"files":[],"additions":0,"deletions":0})); };
    let scope = anchor.path.clone();
    let anchor = anchor.pin_repository(roots, &root)?;
    let stamp = anchor.checkout_stamp()?;
    let list = entries(&anchor)?; let mut files = Vec::new(); let mut additions: u64 = 0; let mut deletions: u64 = 0;
    let spec = anchor.pathspec(&root, &scope).ok_or("Git cwd is outside repository")?;
    if let Ok(stats) = anchor.git(&["diff", "--no-color", "--no-ext-diff", "--numstat", "HEAD", "--", &spec]) {
        for line in stats.lines() { let mut parts = line.split('\t'); additions += parts.next().unwrap_or("").parse::<u64>().unwrap_or(0); deletions += parts.next().unwrap_or("").parse::<u64>().unwrap_or(0); }
    }
    for e in list { let path = root.join(&e.path); if !path.starts_with(&scope) { continue; } let (status, code) = classify(&e);
        if status == "untracked" { if let Some(text) = text_file(roots, &path) { additions += text.lines().count() as u64; } }
        files.push(json!({"filePath":path.to_string_lossy(),"status":status,"code":code,"indexStatus":e.index.to_string(),"worktreeStatus":e.worktree.to_string()}));
    }
    if stamp != anchor.checkout_stamp()? { return Err("Git checkout metadata changed during status".into()); }
    Ok(json!({"isGitRepository":true,"repositoryRoot":root.to_string_lossy(),"files":files,"additions":additions,"deletions":deletions}))
}
pub fn diff(roots: &AllowedRoots, cwd: &Path, path: &Path) -> Result<Value, String> {
    let anchor = GitCwd::open(roots, cwd)?;
    let Some(root) = repository(&anchor)? else { return Ok(json!({"supported":false})); };
    let anchor = anchor.pin_repository(roots, &root)?;
    let stamp = anchor.checkout_stamp()?;
    let result = (|| {
    let Ok(rel) = path.strip_prefix(&root) else { return Ok(json!({"supported":false})); };
    let relative = rel.to_string_lossy().replace('\\', "/");
    let Some(entry) = entries(&anchor)?.into_iter().find(|e| e.path == relative) else { return Ok(json!({"supported":false})); };
    let (status, _) = classify(&entry);
    let text = if status == "deleted" { None } else { match text_file(roots, path) { Some(text) => Some(text), None => return Ok(json!({"supported":false})) } };
    let patch = if status == "untracked" { added_patch(&relative, text.as_deref().unwrap_or("")) } else {
        let spec = anchor.pathspec(&root, path).ok_or("Git path is outside repository")?;
        let original = entry.original.as_ref().and_then(|name| anchor.pathspec(&root, &root.join(name)));
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--unified=3", "HEAD", "--"];
        if let Some(ref original) = original { args.push(original); }
        args.push(&spec);
        match anchor.git(&args) { Ok(patch) => patch, Err(_) if status == "added" => added_patch(&relative, text.as_deref().unwrap_or("")), Err(_) => return Ok(json!({"supported":false})) }
    };
    if !patch.contains("\n@@ ") { return Ok(json!({"supported":false})); }
    Ok(json!({"supported":true,"status":status,"patch":patch}))
    })();
    if stamp != anchor.checkout_stamp()? { return Err("Git checkout metadata changed during diff".into()); }
    result
}
