//! Git worktree operations for the desktop host. All arguments are passed as argv.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use serde_json::{json, Value};

#[cfg(test)]
#[path = "worktrees_tests.rs"]
mod tests;

#[cfg(unix)]
pub(crate) fn git(cwd: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    git_with_cwd(cwd, args, timeout, None)
}
/// Execute Git from an already-authorized, held directory descriptor.
#[cfg(unix)]
pub(crate) fn git_in_directory(directory: &std::fs::File, args: &[&str], timeout: Duration) -> Result<String, String> {
    git_with_cwd(Path::new("."), args, timeout, Some(directory))
}
#[cfg(unix)]
fn git_with_cwd(cwd: &Path, args: &[&str], timeout: Duration, directory: Option<&std::fs::File>) -> Result<String, String> {
    use std::io::Read;
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    use std::sync::mpsc;
    let mut command = Command::new("git");
    if let Some(directory) = directory {
        let fd = directory.as_raw_fd();
        // The descriptor remains open in the parent until spawn returns; only
        // async-signal-safe fchdir runs in the forked child before exec.
        unsafe { command.pre_exec(move || {
            if libc::fchdir(fd) == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
        }); }
    } else { command.arg("-C").arg(cwd); }
    let mut child = command.args(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"])
        .args(args).env("LC_ALL", "C").env("GIT_TERMINAL_PROMPT", "0")
        .process_group(0).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| e.to_string())?;
    let pgid = child.id() as i32;
    let (tx, rx) = mpsc::channel();
    let read = |pipe: Box<dyn Read + Send>, index: usize, tx: mpsc::Sender<(usize, Result<Vec<u8>, String>)>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes)
                .map_err(|e| e.to_string()).and_then(|_| {
                    if bytes.len() > 8 * 1024 * 1024 { Err("Git output exceeded the limit".into()) } else { Ok(bytes) }
                });
            let _ = tx.send((index, result));
        });
    };
    read(Box::new(child.stdout.take().unwrap()), 0, tx.clone());
    read(Box::new(child.stderr.take().unwrap()), 1, tx);
    let deadline = Instant::now() + timeout;
    let mut outputs: [Option<Vec<u8>>; 2] = [None, None];
    let mut status = None;
    let result = 'wait: loop {
        while let Ok((index, data)) = rx.try_recv() {
            match data { Ok(data) => outputs[index] = Some(data), Err(error) => break 'wait Err(error) }
        }
        if status.is_none() {
            match child.try_wait() { Ok(value) => status = value, Err(error) => break Err(error.to_string()) }
        }
        if let (Some(status), Some(out), Some(err)) = (status, &outputs[0], &outputs[1]) {
            let output = String::from_utf8_lossy(out).into_owned();
            let error = String::from_utf8_lossy(err).trim().to_string();
            break if status.success() { Ok(output) } else { Err(if error.is_empty() { format!("git exited with {status}") } else { error }) };
        }
        if Instant::now() >= deadline { break Err("Git command timed out; its outcome may have changed the repository".into()); }
        std::thread::sleep(Duration::from_millis(10));
    };
    // Also terminate descendants when git exited before its inherited pipes closed.
    unsafe { libc::kill(-pgid, libc::SIGKILL); }
    if status.is_none() { let _ = child.wait(); }
    result
}

#[cfg(not(unix))]
pub(crate) fn git(_cwd: &Path, _args: &[&str], _timeout: Duration) -> Result<String, String> {
    Err("Git operations are unavailable until process-tree containment is implemented on this platform".into())
}
fn run(cwd: &Path, args: &[&str]) -> Result<String, String> { git(cwd, args, Duration::from_secs(10)).map(|s| s.trim_end().to_string()) }
fn ref_exists(cwd: &Path, reference: &str) -> Result<bool, String> {
    match run(cwd, &["rev-parse", "--verify", "--quiet", reference]) {
        Ok(_) => Ok(true),
        Err(error) if error == "git exited with exit status: 1" => Ok(false),
        Err(error) => Err(error),
    }
}
fn root(cwd: &Path) -> Result<PathBuf, String> {
    let common = run(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    Ok(PathBuf::from(common).parent().ok_or("Invalid git common directory")?.to_path_buf())
}
pub fn is_chat_area(path: &Path, agent_dir: &Path) -> bool {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    [crate::session_view::chat_workspace_dir(agent_dir), crate::session_view::legacy_chat_workspace_dir(agent_dir)].iter().any(|root| {
        let root_resolved = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        path.starts_with(root) || resolved.starts_with(root_resolved)
    })
}
fn same(a: &Path, b: &Path) -> bool {
    let a = std::fs::canonicalize(a).unwrap_or_else(|_| a.to_path_buf());
    let b = std::fs::canonicalize(b).unwrap_or_else(|_| b.to_path_buf());
    if cfg!(windows) { a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()) } else { a == b }
}
fn branches(cwd: &Path) -> Result<(Vec<String>, Vec<String>, Vec<String>), String> {
    let local = run(cwd, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"])?;
    let remote = run(cwd, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes"])?;
    let local: Vec<String> = local.lines().filter(|s| !s.is_empty()).take(40).map(str::to_owned).collect();
    let refs: Vec<String> = remote.lines().filter(|s| !s.is_empty() && !s.ends_with("/HEAD")).map(str::to_owned).collect();
    let mut only = Vec::new();
    for r in refs.iter().take(40) { if let Some((_, name)) = r.split_once('/') { if !local.iter().any(|v| v == name) && !only.iter().any(|v| v == name) { only.push(name.to_owned()); } } }
    Ok((local, only, refs))
}
#[derive(Clone)]
struct Tree { path: PathBuf, branch: Option<String>, main: bool }
fn trees(cwd: &Path) -> Result<Vec<Tree>, String> {
    let output = run(cwd, &["worktree", "list", "--porcelain", "-z"])?;
    let mut trees = Vec::new(); let mut path = None; let mut branch = None; let mut prunable = false;
    for item in output.split('\0').chain(std::iter::once("")) {
        if let Some(v) = item.strip_prefix("worktree ") { path = Some(PathBuf::from(v)); }
        else if let Some(v) = item.strip_prefix("branch refs/heads/") { branch = Some(v.to_string()); }
        else if item.starts_with("prunable") { prunable = true; }
        else if item.is_empty() { if let Some(p) = path.take() { if !prunable && p.exists() { let main = trees.is_empty(); trees.push(Tree { path: p, branch: branch.take(), main }); } } branch = None; prunable = false; }
    }
    Ok(trees)
}
fn valid_branch(branch: &str) -> Result<&str, String> { let b = branch.trim(); if b.is_empty() || b.starts_with('-') { Err("Invalid branch name".into()) } else { Ok(b) } }

#[cfg(unix)]
fn create(cwd: &Path, b: &str) -> Result<PathBuf, String> { create_with_base_opened(cwd, b, || {}) }
#[cfg(unix)]
fn create_with_base_opened(cwd: &Path, b: &str, after_open: impl FnOnce()) -> Result<PathBuf, String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;
    let repo = root(cwd)?;
    let dir: String = b.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_whitespace() { '-' } else { c }).collect();
    let dir = dir.trim_matches('-');
    if dir.is_empty() || dir == "." || dir == ".." { return Err("Invalid branch name".into()); }
    let base = PathBuf::from(format!("{}-worktrees", repo.display()));
    let parent = base.parent().ok_or("Invalid worktree parent")?;
    let name = base.file_name().and_then(|v| v.to_str()).ok_or("Invalid worktree directory")?;
    let parent_fd = crate::file_access::open_directory_beneath_root(parent, parent).map_err(|e| e.to_string())?;
    let c_name = std::ffi::CString::new(name).map_err(|e| e.to_string())?;
    let made = unsafe { libc::mkdirat(parent_fd.as_raw_fd(), c_name.as_ptr(), 0o777) };
    if made != 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists { return Err(std::io::Error::last_os_error().to_string()); }
    let base_fd = crate::file_access::openat_directory_no_follow(&parent_fd, name).map_err(|e| format!("Cannot open worktree directory: {e}"))?;
    after_open();
    let path = base.join(dir);
    if path.exists() { return Err(format!("Directory already exists: {}", path.display())); }
    let local = format!("refs/heads/{b}"); let remote = format!("refs/remotes/origin/{b}");
    let local_exists = ref_exists(&repo, &local)?;
    let remote_exists = !local_exists && ref_exists(&repo, &remote)?;
    let git_dir = format!("--git-dir={}", repo.join(".git").display());
    let mut args = vec![git_dir.as_str(), "worktree", "add"];
    if !local_exists { args.extend(["-b", b]); }
    args.extend(["--", dir]);
    if local_exists { args.push(b); } else if remote_exists { args.push(&remote); }
    git_in_directory(&base_fd, &args, Duration::from_secs(300))?;
    let held = base_fd.metadata().map_err(|e| e.to_string())?;
    let visible = std::fs::symlink_metadata(&base).map_err(|e| e.to_string())?;
    if !visible.is_dir() || held.dev() != visible.dev() || held.ino() != visible.ino() { return Err("Worktree directory changed during creation; no access granted".into()); }
    let target = crate::file_access::openat_directory_no_follow(&base_fd, dir).map_err(|e| e.to_string())?;
    let held_target = target.metadata().map_err(|e| e.to_string())?;
    let visible_target = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !visible_target.is_dir() || held_target.dev() != visible_target.dev() || held_target.ino() != visible_target.ino()
        || !trees(&repo)?.iter().any(|tree| same(&tree.path, &path)) {
        return Err("Worktree identity changed during creation; no access granted".into());
    }
    Ok(path)
}
#[cfg(not(unix))]
fn create(_cwd: &Path, _b: &str) -> Result<PathBuf, String> { Err("Worktree creation is unavailable on this platform".into()) }

pub fn project(cwd: &Path) -> Result<crate::session_view::ProjectInfo, String> {
    let fallback = || crate::session_view::ProjectInfo { project_root: cwd.to_path_buf(), branch: None, is_worktree: false, is_top_level: false };
    let result = run(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel", "--abbrev-ref", "HEAD"]);
    let output = match result {
        Ok(output) => output,
        Err(error) if error.contains("not a git repository") => return Ok(fallback()),
        Err(error) => return Err(error),
    };
    let parts: Vec<_> = output.lines().collect();
    if parts.len() < 4 { return Err("Invalid git project identity".into()); }
    let common = PathBuf::from(parts[0]); let git_dir = PathBuf::from(parts[1]); let top = PathBuf::from(parts[2]);
    let top_level = same(&top, cwd); let linked = top_level && !same(&common, &git_dir);
    let root = if linked { common.parent().unwrap_or(&top).to_path_buf() } else if top_level { top } else { cwd.to_path_buf() };
    Ok(crate::session_view::ProjectInfo { project_root: std::fs::canonicalize(&root).unwrap_or(root), branch: if parts[3] == "HEAD" { None } else { Some(parts[3].into()) }, is_worktree: linked, is_top_level: top_level })
}
pub fn execute(op: &str, cwd: &Path, args: &Value, project: &crate::session_view::ProjectInfo) -> Result<(Value, Vec<PathBuf>), String> {
    let branch = || valid_branch(args.get("branch").and_then(Value::as_str).unwrap_or_default());
    match op {
        "worktrees.list" => {
            let base = if cwd.exists() { cwd } else { &project.project_root };
            let listed = trees(base); let is_git = listed.is_ok(); let trees = listed.unwrap_or_default();
            let current = trees.iter().find(|t| same(&t.path, cwd)).map(|t| t.path.to_string_lossy().into_owned());
            let grants = trees.iter().map(|t| t.path.clone()).collect();
            let entries: Vec<Value> = trees.iter().map(|t| json!({"path":t.path.to_string_lossy(),"branch":t.branch,"isMain":t.main})).collect();
            let mut result = json!({"projectRoot":project.project_root.to_string_lossy(),"projectKey":crate::session_view::project_identity_key(&project.project_root),"isGit":is_git,"isTopLevel":project.is_top_level,"currentWorktreePath":current,"worktrees":entries});
            if args.get("branches").and_then(Value::as_bool).unwrap_or(false) { let (local, remote, _) = branches(base).unwrap_or_default(); result["branches"] = json!(local); result["remoteBranches"] = json!(remote); }
            Ok((result, grants))
        }
        "worktrees.create" => {
            let b = branch()?;
            let path = create(cwd, b)?;
            Ok((json!({"path":path.to_string_lossy(),"branch":b}), vec![path.clone()]))
        }
        "worktrees.switch" => {
            let b = branch()?; let repo = root(cwd)?; let local = format!("refs/heads/{b}");
            if ref_exists(&repo, &local)? { run(cwd, &["checkout", b])?; }
            else { let (_, _, refs) = branches(&repo)?; let matches: Vec<_> = refs.iter().filter(|r| r.split_once('/').map(|(_, name)| name == b).unwrap_or(false)).collect(); if matches.is_empty() { return Err(format!("Branch not found: {b}")); } if matches.len() > 1 { return Err(format!("Branch exists on multiple remotes: {}", matches.into_iter().map(String::as_str).collect::<Vec<_>>().join(", "))); } run(cwd, &["checkout", "-b", b, "--track", matches[0]])?; }
            Ok((json!({"branch":b}), vec![]))
        }
        "worktrees.delete" => {
            let requested = Path::new(args.get("path").and_then(Value::as_str).unwrap_or_default());
            let target = trees(cwd)?.into_iter().find(|t| same(&t.path, requested)).ok_or("Not a worktree of this repository")?;
            if target.main { return Err("Cannot remove the main worktree".into()); }
            let path = target.path.to_str().ok_or("Invalid worktree path")?;
            if args.get("force").and_then(Value::as_bool) == Some(true) { run(cwd, &["worktree", "remove", "--force", "--", path])?; } else { run(cwd, &["worktree", "remove", "--", path])?; }
            Ok((json!({"success":true}), vec![]))
        }
        "worktrees.fetch" => { let repo = root(cwd)?; git(&repo, &["fetch", "--prune"], Duration::from_secs(90))?; let (local, remote, _) = branches(&repo)?; Ok((json!({"success":true,"branches":local,"remoteBranches":remote}), vec![])) }
        _ => Err("Unknown worktree operation".into()),
    }
}
