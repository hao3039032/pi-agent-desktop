use super::*;
use serde_json::json;
use std::process::Command;

#[cfg(unix)]
#[test]
fn deadline_kills_hook_process_group_and_bounds_pipe_drain() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path();
    git(repo, &["init"]);
    git(repo, &["config", "user.email", "fixture@example.invalid"]);
    git(repo, &["config", "user.name", "Fixture"]);
    std::fs::write(repo.join("file"), "one").unwrap();
    git(repo, &["add", "file"]);
    git(repo, &["commit", "-m", "initial"]);
    git(repo, &["branch", "other"]);
    let hook = repo.join(".git/hooks/post-checkout");
    std::fs::write(&hook, "#!/bin/sh\nsleep 30 &\nexit 0\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let start = Instant::now();
    let result = super::git(repo, &["checkout", "other"], Duration::from_millis(400));
    assert!(result.unwrap_err().contains("timed out"));
    assert!(start.elapsed() < Duration::from_secs(3));
}

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[cfg(unix)]
#[test]
fn create_rejects_symlinked_worktree_base() {
    let temp = tempfile::tempdir().unwrap(); let repo = temp.path().join("repo"); let outside = temp.path().join("outside");
    std::fs::create_dir(&repo).unwrap(); std::fs::create_dir(&outside).unwrap();
    git(&repo, &["init"]); git(&repo, &["config", "user.email", "fixture@example.invalid"]); git(&repo, &["config", "user.name", "Fixture"]); git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
    std::os::unix::fs::symlink(&outside, temp.path().join("repo-worktrees")).unwrap();
    let project = crate::session_view::ProjectResolver::new().resolve(&repo);
    assert!(execute("worktrees.create", &repo, &json!({"branch":"escape"}), &project).is_err());
    assert!(!outside.join("escape").exists());
}

#[cfg(unix)]
#[test]
fn create_does_not_follow_base_swapped_after_open() {
    let temp = tempfile::tempdir().unwrap(); let repo = temp.path().join("repo"); let outside = temp.path().join("outside");
    std::fs::create_dir(&repo).unwrap(); std::fs::create_dir(&outside).unwrap();
    git(&repo, &["init"]); git(&repo, &["config", "user.email", "fixture@example.invalid"]); git(&repo, &["config", "user.name", "Fixture"]); git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
    let base = temp.path().join("repo-worktrees"); let moved = temp.path().join("moved");
    let result = create_with_base_opened(&repo, "new", || {
        std::fs::rename(&base, &moved).unwrap();
        std::os::unix::fs::symlink(&outside, &base).unwrap();
    });
    assert!(result.is_err()); assert!(!outside.join("new").exists());
}

#[test]
fn ipc_worktree_lifecycle_preserves_grants_dirty_and_removed_identity() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo"); std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init"]); git(&repo, &["config", "user.email", "fixture@example.invalid"]); git(&repo, &["config", "user.name", "Fixture"]);
    std::fs::write(repo.join("file"), "original\n").unwrap(); git(&repo, &["add", "file"]); git(&repo, &["commit", "-m", "initial"]);
    let state = crate::pi_ipc::IpcHostState::new(); state.propose_path(&repo);
    let call = |op: &str, args: Value| crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"fixture","op":op,"args":args}));
    let created = call("worktrees.create", json!({"cwd":repo,"branch":"new"})); assert_eq!(created["ok"], true, "{created}");
    let path = PathBuf::from(created["data"]["path"].as_str().unwrap());
    assert!(state.file_roots.lock().unwrap().is_existing_path_allowed(&path));
    let listed = call("worktrees.list", json!({"cwd":repo,"branches":true})); assert_eq!(listed["data"]["worktrees"].as_array().unwrap().len(), 2);
    std::fs::write(path.join("file"), "dirty\n").unwrap();
    let dirty = call("worktrees.delete", json!({"cwd":repo,"path":path})); assert_eq!(dirty["error"]["details"]["dirty"], true, "{dirty}");
    let removed = call("worktrees.delete", json!({"cwd":repo,"path":path,"force":true})); assert_eq!(removed["ok"], true, "{removed}");
    let missing = call("worktrees.list", json!({"cwd":path})); assert_eq!(missing["data"]["projectRoot"], repo.to_string_lossy().as_ref(), "{missing}");
    let switched = call("worktrees.switch", json!({"cwd":repo,"branch":"new"})); assert_eq!(switched["ok"], true, "{switched}");
}

#[test]
fn worktree_operations_use_real_isolated_repository_and_remote() {
    let temp = tempfile::tempdir().unwrap();
    let repo = temp.path().join("repo");
    let remote = temp.path().join("remote.git");
    std::fs::create_dir(&repo).unwrap();
    git(temp.path(), &["init", "--bare", remote.to_str().unwrap()]);
    git(&repo, &["init"]);
    git(&repo, &["config", "user.email", "fixture@example.invalid"]);
    git(&repo, &["config", "user.name", "Fixture"]);
    std::fs::write(repo.join("file"), "original\n").unwrap();
    git(&repo, &["add", "file"]);
    git(&repo, &["commit", "-m", "initial"]);
    git(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
    git(&repo, &["push", "-u", "origin", "HEAD"]);
    let project = crate::session_view::ProjectResolver::new().resolve(&repo);
    let (listed, _) = execute("worktrees.list", &repo, &json!({"branches":true}), &project).unwrap();
    assert_eq!(listed["worktrees"].as_array().unwrap().len(), 1);
    let (created, _) = execute("worktrees.create", &repo, &json!({"branch":"feature/test"}), &project).unwrap();
    let path = PathBuf::from(created["path"].as_str().unwrap());
    assert!(path.join("file").exists());
    assert_eq!(run(&path, &["rev-parse", "--show-toplevel"]).unwrap(), path.to_string_lossy());
    let (listed, _) = execute("worktrees.list", &repo, &json!({}), &project).unwrap();
    assert_eq!(listed["worktrees"].as_array().unwrap().len(), 2);
    std::fs::write(path.join("file"), "dirty\n").unwrap();
    let error = execute("worktrees.delete", &repo, &json!({"path":path}), &project).unwrap_err();
    assert!(error.contains("modified or untracked"), "{error}");
    execute("worktrees.delete", &repo, &json!({"path":path,"force":true}), &project).unwrap();
    assert!(!path.exists());
    execute("worktrees.switch", &repo, &json!({"branch":"feature/test"}), &project).unwrap();
    assert_eq!(run(&repo, &["branch", "--show-current"]).unwrap(), "feature/test");
    execute("worktrees.fetch", &repo, &json!({}), &project).unwrap();
    assert!(execute("worktrees.create", &repo, &json!({"branch":"--force"}), &project).is_err());
}
