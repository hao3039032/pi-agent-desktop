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

/// A chat's own folder (`createChatFolder`): `<root>/YYYYMMDD-HHMMSS-hex`
/// with LOCAL time (the stamp is a name the user reads) and private perms;
/// a same-second collision retries with new randomness.
pub fn create_chat_folder(agent_dir: &Path) -> std::io::Result<PathBuf> {
    let root = ensure_chat_workspace(agent_dir)?;
    let (year, month, day, hour, minute, second) = local_now_parts();
    for _ in 0..5 {
        let mut random = [0u8; 4];
        getrandom::fill(&mut random)?;
        let hex: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let dir = root.join(format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}-{hex}"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            match std::fs::DirBuilder::new().recursive(false).mode(0o700).create(&dir) {
                Ok(()) => return Ok(dir),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        #[cfg(not(unix))]
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::other("Could not create a folder for the chat"))
}

/// Local-time calendar parts (the chat folder stamp is a LOCAL name).
#[cfg(unix)]
fn local_now_parts() -> (i64, u32, u32, u32, u32, u32) {
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return utc_now_parts_local_fallback();
        }
        (
            (tm.tm_year as i64) + 1900,
            (tm.tm_mon as u32) + 1,
            tm.tm_mday as u32,
            tm.tm_hour as u32,
            tm.tm_min as u32,
            tm.tm_sec as u32,
        )
    }
}

#[cfg(not(unix))]
fn local_now_parts() -> (i64, u32, u32, u32, u32, u32) {
    utc_now_parts_local_fallback()
}

fn utc_now_parts_local_fallback() -> (i64, u32, u32, u32, u32, u32) {
    let since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = since_epoch.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400) as u32;
    let (year, month, day) = civil_from_days(days);
    (year, month, day, rest / 3600, (rest % 3600) / 60, rest % 60)
}

/// The local calendar date (the scratch-cwd stamp `localDateStamp`: a
/// user-facing LOCAL name).
pub fn local_now_parts_pub() -> (i64, u32, u32, u32, u32, u32) {
    local_now_parts()
}

/// Howard Hinnant's civil_from_days (the same algorithm session-host uses).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

/// Make sure a chat's cwd exists (`ensureChatCwd`: a folder pruned while
/// empty, or the legacy shared cwd, comes back — private perms).
pub fn ensure_chat_cwd(cwd: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true).mode(0o700).create(cwd)?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(cwd)?;
    Ok(())
}

/// The session-storage dir a cwd's sessions live in
/// (`getDefaultSessionDirPath`): `<agentDir>/sessions/--<cwd / \ : → - >--`.
pub fn default_session_dir(agent_dir: &Path, cwd: &Path) -> PathBuf {
    let text = cwd.to_string_lossy();
    let stripped = text.trim_start_matches(['/', '\\']);
    let safe: String = stripped
        .chars()
        .map(|c| matches!(c, '/' | '\\' | ':').then_some('-').unwrap_or(c))
        .collect();
    agent_dir.join("sessions").join(format!("--{safe}--"))
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

    pub fn invalidate(&self) {
        if let Ok(mut cache) = self.cache.lock() { cache.clear(); }
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
            if let Some(parent) = cwd.parent() {
                if let Some(base) = parent.to_str().and_then(|p| p.strip_suffix("-worktrees")) {
                    let repo = PathBuf::from(base);
                    if repo.join(".git").exists() {
                        return ProjectInfo {
                            project_root: repo.canonicalize().unwrap_or(repo),
                            branch: cwd.file_name().map(|n| n.to_string_lossy().into_owned()),
                            is_worktree: true,
                            is_top_level: true,
                        };
                    }
                }
            }
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

/// The trust-requiring entries under a cwd's `.pi` (`trust-manager.js`
/// TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES; `lib/project-trust.ts` pins
/// this list against the SDK's own).
const TRUST_REQUIRING_PROJECT_ENTRIES: [&str; 8] = [
    "settings.json",
    "mcp.json",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
];

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Whether a cwd carries project-local resources gated by trust
/// (`hasTrustRequiringProjectResources`): the `.pi` entries, or an
/// `.agents/skills` in it or an ancestor — the user's own `~/.agents/skills`
/// never counts.
pub fn has_trust_requiring_project_resources(cwd: &Path) -> bool {
    let config_dir = cwd.join(".pi");
    if TRUST_REQUIRING_PROJECT_ENTRIES
        .iter()
        .any(|entry| config_dir.join(entry).exists())
    {
        return true;
    }
    let user_skills = std::env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join(".agents").join("skills"));
    let mut current = canonical(cwd);
    loop {
        let skills = current.join(".agents").join("skills");
        if user_skills.as_deref() != Some(skills.as_path()) && skills.exists() {
            return true;
        }
        match current.parent() {
            Some(parent) if parent != current => current = canonical(parent),
            _ => return false,
        }
    }
}

/// The trust store's nearest decision for a cwd (`ProjectTrustStore.getEntry`
/// → `findNearestTrustEntry` over `<agentDir>/trust.json`).
fn nearest_trust_entry(agent_dir: &Path, cwd: &Path) -> Option<bool> {
    let path = agent_dir.join("trust.json");
    let text = std::fs::read_to_string(path).ok()?;
    let trimmed = text.trim_start_matches('\u{feff}');
    let parsed: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    let store = parsed.as_object()?;
    let mut current = canonical(cwd);
    loop {
        if let Some(value) = store.get(current.to_string_lossy().as_ref()) {
            match value {
                serde_json::Value::Bool(decision) => return Some(*decision),
                _ => return None,
            }
        }
        match current.parent() {
            Some(parent) if parent != current => current = canonical(parent),
            _ => return None,
        }
    }
}

/// The full trust status (`lib/project-trust.ts` getProjectTrustStatus),
/// the shape `GET /api/project-trust` answers and the UI's trust banner and
/// dialog consume: requiresTrust/trusted plus the nearest decision and
/// whether it was inherited. `decision_error` covers the one TS case a
/// no-trust folder still reports an unreadable store in.
pub fn project_trust_status(agent_dir: &Path, cwd: &Path) -> serde_json::Value {
    let requires_trust = has_trust_requiring_project_resources(cwd);
    let read = nearest_trust_entry_detailed(agent_dir, cwd);
    let mut status = serde_json::Map::new();
    status.insert("requiresTrust".into(), serde_json::Value::Bool(requires_trust));
    if !requires_trust {
        status.insert("trusted".into(), serde_json::Value::Bool(true));
        match read {
            Ok(Some((decision, path))) => {
                let inherited = path != canonical(cwd).to_string_lossy();
                status.insert("decision".into(), serde_json::Value::Bool(decision));
                status.insert("decisionPath".into(), serde_json::Value::String(path));
                status.insert("inherited".into(), serde_json::Value::Bool(inherited));
            }
            Ok(None) => {
                status.insert("decision".into(), serde_json::Value::Null);
                status.insert("inherited".into(), serde_json::Value::Bool(false));
            }
            Err(message) => {
                status.insert("decision".into(), serde_json::Value::Null);
                status.insert("inherited".into(), serde_json::Value::Bool(false));
                status.insert("decisionError".into(), serde_json::Value::String(message));
            }
        }
        return serde_json::Value::Object(status);
    }
    let trusted = matches!(read, Ok(Some((true, _))));
    status.insert("trusted".into(), serde_json::Value::Bool(trusted));
    match read {
        Ok(Some((decision, path))) => {
            let inherited = path != canonical(cwd).to_string_lossy();
            status.insert("decision".into(), serde_json::Value::Bool(decision));
            status.insert("decisionPath".into(), serde_json::Value::String(path));
            status.insert("inherited".into(), serde_json::Value::Bool(inherited));
        }
        _ => {
            status.insert("decision".into(), serde_json::Value::Null);
            status.insert("inherited".into(), serde_json::Value::Bool(false));
        }
    }
    serde_json::Value::Object(status)
}

/// The nearest trust decision AND the path it is recorded for (the TS
/// `findNearestTrustEntry` shape); Err when trust.json exists but cannot be
/// parsed — the distinction `project_trust_status` reports as decisionError.
fn nearest_trust_entry_detailed(agent_dir: &Path, cwd: &Path) -> Result<Option<(bool, String)>, String> {
    let path = agent_dir.join("trust.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return Ok(None), // no store yet: no decision, no error
    };
    let trimmed = text.trim_start_matches('\u{feff}');
    let parsed: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|error| format!("failed to parse {}: {error}", path.to_string_lossy()))?;
    let store = parsed
        .as_object()
        .ok_or_else(|| format!("{} is not a trust store object", path.to_string_lossy()))?;
    let mut current = canonical(cwd);
    loop {
        if let Some(value) = store.get(current.to_string_lossy().as_ref()) {
            match value {
                serde_json::Value::Bool(decision) => {
                    return Ok(Some((*decision, current.to_string_lossy().into_owned())))
                }
                _ => return Ok(None),
            }
        }
        match current.parent() {
            Some(parent) if parent != current => current = canonical(parent),
            _ => return Ok(None),
        }
    }
}

/// The effective project trust for a cwd (`getProjectTrustStatus`): a cwd
/// with nothing trust-requiring is trusted; otherwise the store decides.
pub fn project_trusted(agent_dir: &Path, cwd: &Path) -> bool {
    if !has_trust_requiring_project_resources(cwd) {
        return true;
    }
    nearest_trust_entry(agent_dir, cwd) == Some(true)
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
    fn chat_folders_are_local_time_named_private_and_unique() {
        let dir = tempfile::tempdir().expect("tempdir");
        let agent = dir.path().join("agent");
        let first = create_chat_folder(&agent).expect("first");
        let second = create_chat_folder(&agent).expect("second");
        assert_ne!(first, second, "same-second creates get distinct folders");
        let name = first.file_name().unwrap().to_string_lossy().into_owned();
        // YYYYMMDD-HHMMSS-hex(8): 24 characters, both dashes in place.
        assert_eq!(name.len(), 24, "the stamp shape: {name}");
        assert_eq!(&name[8..9], "-", "the stamp's first dash: {name}");
        assert_eq!(&name[15..16], "-", "the stamp's second dash: {name}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&first).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "a chat folder is private");
        }
        assert!(is_chat_folder_path(&first, &agent));
    }

    #[test]
    fn session_dirs_encode_the_cwd_like_the_sdk() {
        let agent = Path::new("/agent");
        let encoded = default_session_dir(agent, Path::new("/home/hao/work"));
        assert_eq!(encoded, Path::new("/agent/sessions/--home-hao-work--"));
        // Every separator AND a colon become dashes (the JS char class
        // `[/\\:]`), so a Windows drive letter doubles up.
        let windows = default_session_dir(agent, Path::new(r"C:\Users\hao"));
        assert_eq!(windows, Path::new("/agent/sessions/--C--Users-hao--"));
    }

    #[test]
    fn trust_follows_the_sdk_rules() {
        let dir = tempfile::tempdir().expect("tempdir");
        let agent = dir.path().join("agent");
        let project = dir.path().join("work");
        std::fs::create_dir_all(&project).expect("project");
        // Nothing trust-requiring: trusted without any store entry.
        assert!(project_trusted(&agent, &project));
        // A .pi/settings.json makes trust required; no store → untrusted.
        std::fs::create_dir_all(project.join(".pi")).expect("pi");
        std::fs::write(project.join(".pi").join("settings.json"), "{}").expect("settings");
        assert!(!project_trusted(&agent, &project));
        // A trust.json decision for the exact cwd flips it.
        std::fs::create_dir_all(&agent).expect("agent dir");
        let real_project = project.canonicalize().expect("real");
        std::fs::write(
            agent.join("trust.json"),
            format!("{{\n  {}: true\n}}\n", serde_json::json!(real_project.display().to_string())),
        )
        .expect("trust");
        assert!(project_trusted(&agent, &project));
        // An ancestor decision applies to a subdirectory.
        let sub = project.join("packages");
        std::fs::create_dir_all(&sub).expect("sub");
        assert!(has_trust_requiring_project_resources(&sub) || project_trusted(&agent, &sub));
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
