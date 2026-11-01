//! Git status and file diffs for the workspace panel.
use std::path::{Path, PathBuf};
use std::time::Duration;
use serde_json::{json, Value};
use crate::file_access::AllowedRoots;
#[cfg(test)]
#[path = "git_changes_tests.rs"]
mod tests;

struct GitCwd {
    path: PathBuf,
    #[cfg(unix)]
    directory: std::fs::File,
}
impl GitCwd {
    fn open(roots: &AllowedRoots, cwd: &Path) -> Result<Self, String> {
        #[cfg(unix)]
        {
            let (path, directory) = roots.open_terminal_directory(cwd).ok_or("Git cwd is not authorized")?;
            Ok(Self { path, directory })
        }
        #[cfg(not(unix))]
        { let _ = roots; Ok(Self { path: cwd.to_path_buf() }) }
    }
    fn git(&self, args: &[&str]) -> Result<String, String> {
        let mut argv = vec!["--literal-pathspecs"];
        argv.extend_from_slice(args);
        #[cfg(unix)]
        { crate::worktrees::git_in_directory(&self.directory, &argv, Duration::from_secs(10)) }
        #[cfg(not(unix))]
        { crate::worktrees::git(&self.path, &argv, Duration::from_secs(10)) }
    }
    #[cfg(unix)]
    fn pin_repository(&self, roots: &AllowedRoots, root: &Path) -> Result<Self, String> {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::fs::MetadataExt;
        let relative = self.path.strip_prefix(root).map_err(|_| "Git repository is outside cwd ancestry")?;
        let (resolved, directory) = roots.open_terminal_directory(root).ok_or("Git repository is not authorized")?;
        if resolved != root { return Err("Git repository identity changed".into()); }
        let mut ancestor = self.directory.try_clone().map_err(|e| e.to_string())?;
        for _ in relative.components() {
            let fd = unsafe { libc::openat(ancestor.as_raw_fd(), c"..".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
            if fd < 0 { return Err(std::io::Error::last_os_error().to_string()); }
            ancestor = unsafe { std::fs::File::from_raw_fd(fd) };
        }
        let a = ancestor.metadata().map_err(|e| e.to_string())?;
        let b = directory.metadata().map_err(|e| e.to_string())?;
        if (a.dev(), a.ino()) != (b.dev(), b.ino()) { return Err("Git repository identity changed".into()); }
        Ok(Self { path: resolved, directory })
    }
    #[cfg(not(unix))]
    fn pin_repository(&self, roots: &AllowedRoots, root: &Path) -> Result<Self, String> { Self::open(roots, root) }
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
fn repository(cwd: &GitCwd) -> Option<PathBuf> { cwd.git(&["rev-parse", "--show-toplevel"]).ok().map(|s| PathBuf::from(s.trim())) }
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
    let Some(root) = repository(&anchor) else { return Ok(json!({"isGitRepository":false,"repositoryRoot":null,"files":[],"additions":0,"deletions":0})); };
    let scope = anchor.path.clone();
    let anchor = anchor.pin_repository(roots, &root)?;
    let list = entries(&anchor)?; let mut files = Vec::new(); let mut additions: u64 = 0; let mut deletions: u64 = 0;
    let spec = anchor.pathspec(&root, &scope).ok_or("Git cwd is outside repository")?;
    if let Ok(stats) = anchor.git(&["diff", "--no-color", "--no-ext-diff", "--numstat", "HEAD", "--", &spec]) {
        for line in stats.lines() { let mut parts = line.split('\t'); additions += parts.next().unwrap_or("").parse::<u64>().unwrap_or(0); deletions += parts.next().unwrap_or("").parse::<u64>().unwrap_or(0); }
    }
    for e in list { let path = root.join(&e.path); if !path.starts_with(&scope) { continue; } let (status, code) = classify(&e);
        if status == "untracked" { if let Some(text) = text_file(roots, &path) { additions += text.lines().count() as u64; } }
        files.push(json!({"filePath":path.to_string_lossy(),"status":status,"code":code,"indexStatus":e.index.to_string(),"worktreeStatus":e.worktree.to_string()}));
    }
    Ok(json!({"isGitRepository":true,"repositoryRoot":root.to_string_lossy(),"files":files,"additions":additions,"deletions":deletions}))
}
pub fn diff(roots: &AllowedRoots, cwd: &Path, path: &Path) -> Result<Value, String> {
    let anchor = GitCwd::open(roots, cwd)?;
    let Some(root) = repository(&anchor) else { return Ok(json!({"supported":false})); };
    let anchor = anchor.pin_repository(roots, &root)?;
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
}
