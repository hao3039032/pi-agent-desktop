//! The session-view assembly (M2): the Rust half of `GET /api/sessions/[id]`.
//!
//! The projection itself (context, tree, stats) runs in the management
//! instance over the repo's own `lib/session-projection.ts` bundle; this
//! module owns what only the host can know:
//!
//! - which session a URL id is (the live registry first, the disk scan
//!   second — the `startRpcSession`-on-demand contract);
//! - the live one-shot child snapshot (`get_entries` + `get_tree`) handed to
//!   the management instance as a private temp file (big payloads never ride
//!   the management prompt envelope);
//! - workspace classification (chats live under the agent dir's chat root —
//!   a path check, never a client claim) and git project identity
//!   (`resolveProject`'s exact semantics: one `git rev-parse` call, linked
//!   worktrees collapse to the main repo's root);
//! - the opaque snapshot revision (a validity token for the client's view
//!   cache, not a permission check and not a content hash).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use session_host::Session;

// ---------------------------------------------------------------------------
// Workspace classification (lib/chat-workspace.ts, the host-side half)
// ---------------------------------------------------------------------------

const CHAT_ROOT_DIRNAME: &str = "chats";
const LEGACY_CHAT_WORKSPACE_DIRNAME: &str = "chat-workspace";

/// The chat root (`<agentDir>/chats`): the cwd a brand-new chat is requested
/// with; the server swaps it for a fresh folder of its own.
pub fn chat_workspace_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join(CHAT_ROOT_DIRNAME)
}

/// The legacy shared chat cwd chats used before folders; those sessions keep
/// their old (weaker) policy.
pub fn legacy_chat_workspace_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join(LEGACY_CHAT_WORKSPACE_DIRNAME)
}

/// Create the chat root with private permissions (ensureChatWorkspace).
pub fn ensure_chat_workspace(agent_dir: &Path) -> std::io::Result<PathBuf> {
    let dir = chat_workspace_dir(agent_dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700).create(&dir)?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Same-path comparison with the separator/case normalization `samePath`
/// applies (case folding only where the platform does: Windows).
fn same_path(a: &Path, b: &Path) -> bool {
    let normalize = |path: &Path| -> String {
        let text = path.to_string_lossy().replace('\\', "/");
        let trimmed = text.trim_end_matches('/');
        trimmed.to_string()
    };
    let (a, b) = (normalize(a), normalize(b));
    if a == b {
        return true;
    }
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        false
    }
}

/// The root a new chat is requested with.
pub fn is_chat_root_path(cwd: &Path, agent_dir: &Path) -> bool {
    same_path(cwd, &chat_workspace_dir(agent_dir))
}

/// A chat's own folder: a direct child of the chat root.
pub fn is_chat_folder_path(cwd: &Path, agent_dir: &Path) -> bool {
    let parent = cwd.parent().map(Path::to_path_buf).unwrap_or_default();
    same_path(&parent, &chat_workspace_dir(agent_dir)) && !is_chat_root_path(cwd, agent_dir)
}

pub fn is_legacy_chat_workspace_path(cwd: &Path, agent_dir: &Path) -> bool {
    same_path(cwd, &legacy_chat_workspace_dir(agent_dir))
}

/// Whether a session cwd belongs to the chat workspace at all.
pub fn is_chat_workspace_path(cwd: &Path, agent_dir: &Path) -> bool {
    is_chat_root_path(cwd, agent_dir)
        || is_chat_folder_path(cwd, agent_dir)
        || is_legacy_chat_workspace_path(cwd, agent_dir)
}

// ---------------------------------------------------------------------------
// Git project identity (lib/worktree.ts resolveProject, the read half)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectInfo {
    pub project_root: PathBuf,
    pub branch: Option<String>,
    pub is_worktree: bool,
    pub is_top_level: bool,
}

const PROJECT_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct ProjectResolver {
    cache: Mutex<HashMap<PathBuf, (ProjectInfo, Instant)>>,
}

impl ProjectResolver {
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve one cwd's project identity. Non-git and failing directories
    /// answer `projectRoot = cwd` (the TS fallback — a session keeps its own
    /// identity instead of disappearing).
    pub fn resolve(&self, cwd: &Path) -> ProjectInfo {
        if let Ok(cache) = self.cache.lock() {
            if let Some((info, expires_at)) = cache.get(cwd) {
                if *expires_at > Instant::now() {
                    return info.clone();
                }
            }
        }
        let info = self.resolve_uncached(cwd);
        if let Ok(mut cache) = self.cache.lock() {
            cache.insert(cwd.to_path_buf(), (info.clone(), Instant::now() + PROJECT_CACHE_TTL));
        }
        info
    }

    fn resolve_uncached(&self, cwd: &Path) -> ProjectInfo {
        let fallback = || ProjectInfo {
            project_root: cwd.to_path_buf(),
            branch: None,
            is_worktree: false,
            is_top_level: false,
        };
        if !cwd.is_dir() {
            return fallback();
        }
        // One call, exactly the TS invocation (lib/worktree.ts): the common
        // dir and git dir decide worktree-ness, the toplevel decides
        // top-level-ness, and only worktree TOP LEVELS collapse to the main
        // repo's root — a session in a repo subdirectory keeps its own
        // identity on purpose.
        let output = std::process::Command::new("git")
            .args([
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
                "--git-dir",
                "--show-toplevel",
                "--abbrev-ref",
                "HEAD",
            ])
            .current_dir(cwd)
            .output();
        let Ok(output) = output else { return fallback() };
        if !output.status.success() {
            return fallback();
        }
        let text = String::from_utf8_lossy(&output.stdout).into_owned();
        let lines: Vec<&str> = text.lines().map(str::trim).collect();
        if lines.len() < 4 {
            return fallback();
        }
        let to_native = |raw: &str| -> PathBuf {
            PathBuf::from(raw.replace('/', std::path::MAIN_SEPARATOR_STR))
        };
        let common_dir = to_native(lines[0]);
        let git_dir = to_native(lines[1]);
        let toplevel = to_native(lines[2]);
        let git_ref = lines[3];
        let real_cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
        let is_top_level = same_path(&toplevel, &real_cwd);
        let is_worktree_top_level = !same_path(&git_dir, &common_dir) && is_top_level;
        let top_level_project_root =
            if is_worktree_top_level { common_dir.parent().map(Path::to_path_buf).unwrap_or(common_dir.clone()) } else { toplevel.clone() };
        ProjectInfo {
            project_root: if is_top_level {
                top_level_project_root.canonicalize().unwrap_or(top_level_project_root)
            } else {
                real_cwd
            },
            branch: if git_ref.is_empty() || git_ref == "HEAD" {
                None
            } else {
                Some(git_ref.to_string())
            },
            is_worktree: is_worktree_top_level,
            is_top_level,
        }
    }
}

/// Stable grouping identity (lib/project-identity.ts): normalized, trailing
/// separators dropped; case-folded only on Windows.
pub fn project_identity_key(project_root: &Path) -> String {
    let text = project_root.to_string_lossy();
    let text = text.trim_end_matches(['/', '\\']);
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.to_string()
    }
}

// ---------------------------------------------------------------------------
// The snapshot revision (lib/session-revision.ts's contract, opaque token)
// ---------------------------------------------------------------------------

/// The opaque freshness token for the client's view cache: the disk
/// fingerprint (size + mtimes), the read source, the entry count, the
/// newest entry and the leaf. Deterministic and collision-free (the raw
/// parts joined — the TS hashes the same parts only to keep it short; the
/// client treats the string as opaque and compares for equality).
pub fn snapshot_revision(
    file: &Path,
    source_id: &str,
    entry_count: usize,
    latest_entry_id: Option<&str>,
    leaf_id: Option<&str>,
) -> Value {
    let fingerprint = std::fs::metadata(file)
        .ok()
        .map(|meta| {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis())
                .unwrap_or(0);
            format!("{}:{}", meta.len(), mtime)
        })
        .unwrap_or_else(|| "missing".to_string());
    json!(format!(
        "{source_id}|{fingerprint}|{entry_count}|{}|{}",
        latest_entry_id.unwrap_or("-"),
        leaf_id.unwrap_or("-"),
    ))
}

// ---------------------------------------------------------------------------
// The live child snapshot (get_entries + get_tree, one-shot)
// ---------------------------------------------------------------------------

/// Take the live child's one-shot snapshot: every entry plus the child's
/// in-memory leaf (navigate_tree moves it while the file keeps the abandoned
/// branch's tail) and the tree. A failure is an error — never the disk tail
/// passed off as the live branch.
pub fn live_child_snapshot(session: &Session) -> Result<(Vec<Value>, Option<String>, Vec<Value>), String> {
    let entries_result = session
        .command("get_entries", json!({}), Some(Duration::from_secs(60)))
        .map_err(|error| format!("pi RPC 'get_entries' failed: {error}"))?;
    let entries = entries_result
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "pi RPC 'get_entries' did not return an entries array".to_string())?;
    let leaf_id = match entries_result.get("leafId") {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Null) | None => None,
        Some(other) => return Err(format!("pi RPC 'get_entries' returned a non-string leafId: {other}")),
    };
    if let Some(leaf) = &leaf_id {
        if !entries
            .iter()
            .any(|entry| entry.get("id").and_then(Value::as_str) == Some(leaf.as_str()))
        {
            return Err("pi RPC 'get_entries' returned a leaf missing from its entries".to_string());
        }
    }
    let tree_result = session
        .command("get_tree", json!({}), Some(Duration::from_secs(60)))
        .map_err(|error| format!("pi RPC 'get_tree' failed: {error}"))?;
    let tree = tree_result
        .get("tree")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "pi RPC 'get_tree' did not return a tree array".to_string())?;
    Ok((entries, leaf_id, tree))
}

/// Write the snapshot handoff file for the management instance (private
/// perms; the mgmt protocol's prompt envelope never carries big payloads).
pub fn write_snapshot_handoff(entries: &[Value], leaf_id: Option<&str>, tree: &[Value]) -> std::io::Result<PathBuf> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random)?;
    let name = random.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let path = std::env::temp_dir().join(format!("pi-web-snapshot-{name}.json"));
    let payload = json!({ "entries": entries, "leafId": leaf_id, "tree": tree });
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut handle = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        handle.write_all(payload.to_string().as_bytes())?;
        handle.flush()?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, payload.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_classification_follows_the_agent_dir_layout() {
        let dir = tempfile::tempdir().expect("tempdir");
        let agent = dir.path().join("agent");
        let root = chat_workspace_dir(&agent);
        let folder = root.join("20260201-100000-abcd");
        assert!(is_chat_root_path(&root, &agent));
        assert!(is_chat_folder_path(&folder, &agent));
        assert!(!is_chat_folder_path(&root, &agent), "the root itself is not a folder chat");
        assert!(is_chat_workspace_path(&folder, &agent));
        assert!(is_legacy_chat_workspace_path(&legacy_chat_workspace_dir(&agent), &agent));
        // Trailing separators and case differences on Windows still match.
        assert!(is_chat_folder_path(
            &PathBuf::from(format!("{}{}", folder.display(), "/")),
            &agent
        ));
        // An unrelated project cwd is not a chat.
        assert!(!is_chat_workspace_path(&dir.path().join("work"), &agent));
    }

    #[test]
    fn ensure_chat_workspace_creates_a_private_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let agent = dir.path().join("agent");
        let root = ensure_chat_workspace(&agent).expect("chat root");
        assert!(root.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&root).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "the chat root is private");
        }
    }

    #[test]
    fn a_git_repo_resolves_the_way_the_ts_resolver_does() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).expect("repo");
        let git = || {
            let output = std::process::Command::new("git")
                .arg("rev-parse")
                .arg("--is-inside-work-tree")
                .current_dir(&repo)
                .output()
                .expect("git");
            output.status.success()
        };
        if !std::process::Command::new("git")
            .args(["init", "--initial-branch=main"])
            .current_dir(&repo)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
            || !git()
        {
            eprintln!("skipping: git is not usable in this environment");
            return;
        }
        // --abbrev-ref HEAD needs a commit to resolve; a repo with no
        // commits falls back (exactly the TS resolver's catch path).
        std::fs::write(repo.join(".git-ignore-marker"), "x").expect("marker");
        let committed = std::process::Command::new("git")
            .args(["add", "."])
            .current_dir(&repo)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
            && {
                std::env::set_var("GIT_AUTHOR_NAME", "test");
                std::env::set_var("GIT_AUTHOR_EMAIL", "test@example.com");
                std::env::set_var("GIT_COMMITTER_NAME", "test");
                std::env::set_var("GIT_COMMITTER_EMAIL", "test@example.com");
                std::process::Command::new("git")
                    .args(["commit", "-m", "init"])
                    .current_dir(&repo)
                    .output()
                    .map(|output| output.status.success())
                    .unwrap_or(false)
            };
        let resolver = ProjectResolver::new();
        let top = resolver.resolve(&repo);
        let real = repo.canonicalize().expect("real");
        assert_eq!(top.project_root, real);
        if committed {
            assert_eq!(top.branch.as_deref(), Some("main"));
        } else {
            eprintln!("note: no commit could be created; branch stayed unset");
            assert_eq!(top.branch, None);
        }
        assert!(top.is_top_level);
        assert!(!top.is_worktree);

        // A subdirectory keeps its own identity by design.
        let sub = repo.join("packages/app");
        std::fs::create_dir_all(&sub).expect("sub");
        let sub_info = resolver.resolve(&sub);
        assert_eq!(sub_info.project_root, sub.canonicalize().expect("sub real"));
        assert!(!sub_info.is_top_level);

        // A non-git dir falls back to itself.
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).expect("plain");
        let plain_info = resolver.resolve(&plain);
        assert_eq!(plain_info.project_root, plain.canonicalize().expect("plain real"));
        assert_eq!(plain_info.branch, None);
    }

    #[test]
    fn snapshot_revisions_track_the_read_source_and_content() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("s.jsonl");
        std::fs::write(&file, "{}\n").expect("file");
        let first = snapshot_revision(&file, "disk", 10, Some("e10"), Some("e10"));
        let same = snapshot_revision(&file, "disk", 10, Some("e10"), Some("e10"));
        assert_eq!(first, same, "deterministic while the file is untouched");
        let other_leaf = snapshot_revision(&file, "disk", 10, Some("e10"), Some("e9"));
        assert_ne!(first, other_leaf, "the leaf is part of the token");
        let live = snapshot_revision(&file, "runtime:s", 10, Some("e10"), Some("e10"));
        assert_ne!(first, live, "the read source is part of the token");
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&file, "{}\n{}\n").expect("grow");
        let grown = snapshot_revision(&file, "disk", 10, Some("e10"), Some("e10"));
        assert_ne!(first, grown, "the disk fingerprint changed with the file");
    }

    #[test]
    fn the_snapshot_handoff_file_is_private_and_round_trips() {
        let entries = vec![json!({ "id": "u1", "type": "message" })];
        let path = write_snapshot_handoff(&entries, Some("u1"), &vec![json!({ "entry": { "id": "u1" }, "children": [] })])
            .expect("handoff");
        let text = std::fs::read_to_string(&path).expect("read");
        let parsed: Value = serde_json::from_str(&text).expect("json");
        assert_eq!(parsed["entries"][0]["id"], "u1");
        assert_eq!(parsed["leafId"], "u1");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "the snapshot handoff is private");
        }
        std::fs::remove_file(&path).expect("cleanup");
    }
}
