//! Git status and file diffs for the workspace panel.
use std::path::{Path, PathBuf};
use std::time::Duration;
use serde_json::{json, Value};
use crate::file_access::AllowedRoots;
#[cfg(test)]
#[path = "git_changes_tests.rs"]
mod tests;

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut argv = vec!["-c", "core.fsmonitor=false", "--literal-pathspecs"];
    argv.extend_from_slice(args);
    crate::worktrees::git(cwd, &argv, Duration::from_secs(10))
}
struct Entry { path: String, original: Option<String>, index: char, worktree: char }
fn entries(root: &Path) -> Result<Vec<Entry>, String> {
    let output = git(root, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
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
fn repository(cwd: &Path) -> Option<PathBuf> { git(cwd, &["rev-parse", "--show-toplevel"]).ok().map(|s| PathBuf::from(s.trim())) }
fn text_file(roots: &AllowedRoots, path: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 256 * 1024 { return None; }
    #[cfg(unix)]
    let bytes = { use std::io::Read; let mut file = roots.open_file(path).ok()?; let mut bytes = Vec::new(); file.read_to_end(&mut bytes).ok()?; bytes };
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
    let Some(root) = repository(cwd) else { return Ok(json!({"isGitRepository":false,"repositoryRoot":null,"files":[],"additions":0,"deletions":0})); };
    let list = entries(&root)?; let mut files = Vec::new(); let mut additions: u64 = 0; let mut deletions: u64 = 0;
    let rel = cwd.strip_prefix(&root).unwrap_or(Path::new(".")); let spec = rel.to_string_lossy();
    if let Ok(stats) = git(&root, &["diff", "--no-color", "--no-ext-diff", "--numstat", "HEAD", "--", if spec.is_empty() { "." } else { &spec }]) {
        for line in stats.lines() { let mut parts = line.split('\t'); additions += parts.next().unwrap_or("").parse::<u64>().unwrap_or(0); deletions += parts.next().unwrap_or("").parse::<u64>().unwrap_or(0); }
    }
    for e in list { let path = root.join(&e.path); if !path.starts_with(cwd) { continue; } let (status, code) = classify(&e);
        if status == "untracked" { if let Some(text) = text_file(roots, &path) { additions += text.lines().count() as u64; } }
        files.push(json!({"filePath":path.to_string_lossy(),"status":status,"code":code,"indexStatus":e.index.to_string(),"worktreeStatus":e.worktree.to_string()}));
    }
    Ok(json!({"isGitRepository":true,"repositoryRoot":root.to_string_lossy(),"files":files,"additions":additions,"deletions":deletions}))
}
pub fn diff(roots: &AllowedRoots, cwd: &Path, path: &Path) -> Result<Value, String> {
    let Some(root) = repository(cwd) else { return Ok(json!({"supported":false})); };
    let Ok(rel) = path.strip_prefix(&root) else { return Ok(json!({"supported":false})); };
    let relative = rel.to_string_lossy().replace('\\', "/");
    let Some(entry) = entries(&root)?.into_iter().find(|e| e.path == relative) else { return Ok(json!({"supported":false})); };
    let (status, _) = classify(&entry);
    let text = if status == "deleted" { None } else { match text_file(roots, path) { Some(text) => Some(text), None => return Ok(json!({"supported":false})) } };
    let patch = if status == "untracked" { added_patch(&relative, text.as_deref().unwrap_or("")) } else {
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--unified=3", "HEAD", "--"];
        if let Some(ref original) = entry.original { args.push(original); }
        args.push(&relative);
        match git(&root, &args) { Ok(patch) => patch, Err(_) if status == "added" => added_patch(&relative, text.as_deref().unwrap_or("")), Err(_) => return Ok(json!({"supported":false})) }
    };
    if !patch.contains("\n@@ ") { return Ok(json!({"supported":false})); }
    Ok(json!({"supported":true,"status":status,"patch":patch}))
}
