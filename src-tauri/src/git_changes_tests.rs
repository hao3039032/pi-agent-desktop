use super::*;
use std::process::Command;
fn git(cwd: &Path, args: &[&str]) { let out = Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap(); assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr)); }
#[test]
fn status_and_diff_real_repo_cover_tracked_untracked_deleted_and_scope() {
    let temp = tempfile::tempdir().unwrap(); let repo = temp.path();
    git(repo, &["init"]); git(repo, &["config", "user.email", "fixture@example.invalid"]); git(repo, &["config", "user.name", "Fixture"]);
    std::fs::write(repo.join("tracked"), "old\n").unwrap(); std::fs::write(repo.join("deleted"), "gone\n").unwrap();
    git(repo, &["add", "."]); git(repo, &["commit", "-m", "initial"]);
    std::fs::write(repo.join("tracked"), "new\n").unwrap(); std::fs::write(repo.join("new"), "hello\nworld\n").unwrap(); std::fs::remove_file(repo.join("deleted")).unwrap();
    let mut roots = AllowedRoots::new(); roots.add(repo).expect("fixture root");
    let state = status(&roots, repo).unwrap(); assert_eq!(state["files"].as_array().unwrap().len(), 3); assert_eq!(state["additions"], 3); assert_eq!(state["deletions"], 2);
    for name in ["tracked", "new", "deleted"] { let patch = diff(&roots, repo, &repo.join(name)).unwrap(); assert_eq!(patch["supported"], true, "{name}: {patch}"); }
    assert_eq!(diff(&roots, repo, &temp.path().join("missing")).unwrap()["supported"], false);
}
