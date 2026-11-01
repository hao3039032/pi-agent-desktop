//! Safe single-file deletion. Multi-file cascades and chat-folder trash are
//! refused before any mutation until their recoverable journal is available.
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use serde_json::{json, Value};
use crate::pi_ipc::IpcHostState;

fn error(code: &str, message: impl ToString) -> (String, String) { (code.into(), message.to_string()) }

fn files_in(root: &Path, files: &mut Vec<PathBuf>) -> Result<(), (String, String)> {
    for entry in std::fs::read_dir(root).map_err(|e| error("io", e))? {
        let entry = entry.map_err(|e| error("io", e))?;
        let kind = entry.file_type().map_err(|e| error("io", e))?;
        if kind.is_symlink() {
            return Err(error("not_supported", "Cannot safely verify session references through a symbolic link."));
        }
        if kind.is_dir() { files_in(&entry.path(), files)?; }
        else if kind.is_file() && entry.path().extension().is_some_and(|s| s == "jsonl") { files.push(entry.path()); }
    }
    Ok(())
}

fn bounded_line(reader: &mut impl BufRead, max: u64) -> Result<Option<Value>, (String, String)> {
    let mut bytes = Vec::new();
    reader.take(max).read_until(b'\n', &mut bytes).map_err(|e| error("io", e))?;
    if bytes.is_empty() { return Ok(None); }
    if bytes.len() as u64 == max && !bytes.ends_with(b"\n") {
        return Err(error("not_supported", "Session reference metadata exceeds the safe scan limit."));
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| error("not_supported", "Cannot verify malformed session reference metadata."))
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) { a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()) } else { a == b }
}

fn verified_subagent_parent(entry: &Value) -> Result<&str, (String, String)> {
    if entry.pointer("/data/version").and_then(Value::as_u64) != Some(1)
        || entry.pointer("/data/parentSessionPath").and_then(Value::as_str).is_none_or(str::is_empty) {
        return Err(error("not_supported", "Cannot verify subagent metadata."));
    }
    entry.pointer("/data/parentSessionId").and_then(Value::as_str).filter(|id| !id.is_empty())
        .ok_or_else(|| error("not_supported", "Cannot verify a subagent parent."))
}

#[derive(Debug)]
struct SessionReference {
    id: String,
    path: PathBuf,
    parent: Option<PathBuf>,
    subagent_parent: Option<String>,
    file: std::fs::File,
    metadata: std::fs::Metadata,
}
struct AffectedSessions { ids: Vec<String>, proofs: Vec<DeleteMemberProof> }

/// Discover every session whose bytes the deletion would remove or rewrite.
/// The caller repeats this after acquiring all returned writer gates.
fn affected_session_ids(state: &IpcHostState, target_id: &str) -> Result<AffectedSessions, (String, String)> {
    use std::collections::{HashMap, HashSet};
    let root = state.agent_dir().join("sessions").canonicalize().map_err(|e| error("io", e))?;
    let mut files = Vec::new();
    files_in(&root, &mut files)?;
    let mut records = Vec::new();
    let mut ids = HashSet::new();
    for path in files {
        let file = std::fs::File::open(&path).map_err(|e| error("io", e))?;
        let before = file.metadata().map_err(|e| error("io", e))?;
        let mut reader = std::io::BufReader::new(file);
        let header = bounded_line(&mut reader, 64 * 1024)?.ok_or_else(|| error("not_supported", "Cannot verify an empty session file."))?;
        if header.get("type").and_then(Value::as_str) != Some("session") { return Err(error("not_supported", "Cannot verify a session header.")); }
        let id = header.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())
            .ok_or_else(|| error("not_supported", "Cannot verify a session id."))?.to_string();
        if !ids.insert(id.clone()) { return Err(error("not_supported", "Duplicate session ids require manual resolution.")); }
        let parent = match header.get("parentSession") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if Path::new(value).is_absolute() => Some(PathBuf::from(value)),
            _ => return Err(error("not_supported", "Cannot verify a parent session path.")),
        };
        let mut subagent_parent = None;
        while let Some(entry) = bounded_line(&mut reader, 16 * 1024 * 1024)? {
            if entry.get("type").and_then(Value::as_str) == Some("custom")
                && entry.get("customType").and_then(Value::as_str) == Some("pi-web:subagent") {
                let parent = verified_subagent_parent(&entry)?;
                if subagent_parent.replace(parent.to_string()).is_some() {
                    return Err(error("not_supported", "Cannot verify duplicate subagent metadata."));
                }
            }
        }
        let after = reader.get_ref().metadata().map_err(|e| error("io", e))?;
        if !same_file_version(&before, &after) { return Err(error("busy", "Session changed while checking references")); }
        records.push(SessionReference { id, path, parent, subagent_parent, file: reader.into_inner(), metadata: after });
    }
    let target = records.iter().find(|record| record.id == target_id).ok_or_else(|| error("not_found", "Session not found"))?;
    let target_path = target.path.canonicalize().map_err(|e| error("io", e))?;
    if !target_path.starts_with(&root) { return Err(error("access_denied", "Session path is outside session storage.")); }
    let mut by_parent: HashMap<&str, Vec<&str>> = HashMap::new();
    for record in &records {
        if let Some(parent) = record.subagent_parent.as_deref() {
            by_parent.entry(parent).or_default().push(&record.id);
        }
    }
    let mut affected: HashSet<String> = HashSet::from([target_id.to_string()]);
    let mut pending = vec![target_id];
    while let Some(parent) = pending.pop() {
        for child in by_parent.get(parent).into_iter().flatten() {
            if affected.insert((*child).to_string()) { pending.push(child); }
        }
    }
    for record in &records {
        if let Some(parent) = &record.parent {
            let parent = parent.canonicalize().unwrap_or_else(|_| parent.clone());
            if same_path(&parent, &target_path) { affected.insert(record.id.clone()); }
        }
    }
    let mut ids: Vec<_> = affected.into_iter().collect();
    ids.sort();
    let proofs = records.into_iter().filter(|record| ids.binary_search(&record.id).is_ok())
        .map(|record| DeleteMemberProof { id: record.id, path: record.path, file: record.file, metadata: record.metadata }).collect();
    Ok(AffectedSessions { ids, proofs })
}

/// Scheduler-owned data supplies this proof after a successful, non-corrupt load.
pub(crate) trait ScheduledReferences {
    fn is_referenced(&self, session_id: &str) -> bool;
}

impl ScheduledReferences for crate::scheduled_session_index::ScheduledSessionIndex {
    fn is_referenced(&self, id: &str) -> bool { self.is_referenced(id) }
}

#[derive(Debug)]
struct DeletePreflight { path: PathBuf, file: std::fs::File, metadata: std::fs::Metadata, affected: Vec<DeleteMemberProof>, trash: Option<ChatFolderProof> }
#[derive(Debug)]
struct ChatFolderProof { path: PathBuf, file: std::fs::File, metadata: std::fs::Metadata }
#[derive(Debug)]
struct DeleteMemberProof { id: String, path: PathBuf, file: std::fs::File, metadata: std::fs::Metadata }
struct ScannedMember { id: String, path: PathBuf, header: Value, parent: Option<PathBuf>, subagent_parent: Option<String>, file: std::fs::File, metadata: std::fs::Metadata }
#[derive(Debug)]
enum DeleteOutcome { Preflight(DeletePreflight), Deleted(Value) }

#[cfg(unix)]
fn same_file_version(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino() && left.len() == right.len()
        && left.mtime() == right.mtime() && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime() && left.ctime_nsec() == right.ctime_nsec()
}
#[cfg(not(unix))]
fn same_file_version(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    left.len() == right.len() && left.modified().ok() == right.modified().ok()
}
#[cfg(unix)]
fn same_directory(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.is_dir() && right.is_dir() && left.dev() == right.dev() && left.ino() == right.ino()
}
#[cfg(not(unix))]
fn same_directory(_left: &std::fs::Metadata, _right: &std::fs::Metadata) -> bool { false }

fn same_existing_folder(left: &Path, right: &Path) -> Result<bool, (String, String)> {
    if same_path(left, right) { return Ok(true); }
    let left = left.canonicalize().map_err(|e| error("busy", format!("Cannot verify a session folder reference: {e}")))?;
    let right = right.canonicalize().map_err(|e| error("busy", format!("Cannot verify a session folder reference: {e}")))?;
    Ok(same_path(&left, &right))
}

fn open_chat_folder(path: &Path) -> Result<ChatFolderProof, (String, String)> {
    let mut options = std::fs::OpenOptions::new(); options.read(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC); }
    let file = options.open(path).map_err(|e| error("io", e))?;
    let metadata = file.metadata().map_err(|e| error("io", e))?;
    if !metadata.is_dir() { return Err(error("access_denied", "Chat folder is not a directory")); }
    Ok(ChatFolderProof { path: path.to_path_buf(), file, metadata })
}

fn refuse_pending_writer_targets(agent: &Path) -> Result<(), (String, String)> {
    let parent = agent.join("pi-web");
    let path = parent.join("session-writer-fences");
    for directory in [&parent, &path] {
        match std::fs::symlink_metadata(directory) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(error("io", e)),
            Ok(metadata) if metadata.file_type().is_dir() => {},
            Ok(_) => return Err(error("busy", "Session writer fence directory is unsafe")),
        }
    }
    #[cfg(target_os = "linux")]
    let mut entries = {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        let dir = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&path).map_err(|e| error("io", e))?;
        std::fs::read_dir(format!("/proc/self/fd/{}", dir.as_raw_fd())).map_err(|e| error("io", e))?
    };
    #[cfg(not(target_os = "linux"))]
    let mut entries = std::fs::read_dir(&path).map_err(|e| error("io", e))?;
    match entries.next() {
        None => Ok(()),
        Some(Ok(_)) => Err(error("busy", "An unresolved session writer may reference the chat folder")),
        Some(Err(e)) => Err(error("io", e)),
    }
}

pub(crate) fn delete(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    delete_with_policy_hook(state, args, || {})
}

fn delete_with_policy_hook(state: &IpcHostState, args: &Value, after_unlock: impl FnOnce()) -> Result<Value, (String, String)> {
    delete_with_policy_hooks(state, args, after_unlock, || {})
}

fn delete_with_policy_hooks(state: &IpcHostState, args: &Value, after_unlock: impl FnOnce(), after_exclusive: impl FnOnce()) -> Result<Value, (String, String)> {
    let policy = state.policy_gate.try_read().map_err(|_| error("busy", "Session policy change is in progress"))?;
    let agent = state.agent_dir();
    if crate::trust_policy_fence::is_pending(&agent) {
        return Err(error("busy", "Trust policy outcome is unresolved"));
    }
    let id = args.get("session").and_then(Value::as_str).filter(|value| !value.is_empty())
        .ok_or_else(|| error("invalid_args", "session is required"))?;
    if args.get("trashChatFolder").is_some_and(|value| !value.is_boolean()) {
        return Err(error("invalid_args", "trashChatFolder must be a boolean"));
    }
    let mut preflight_proof = None;
    let live = state.registry.get(id).is_some();
    if live || args.get("trashChatFolder").and_then(Value::as_bool) == Some(true) {
        // Check every disk-side refusal before closing an idle child. The
        // actual deletion repeats all checks after the child really exits.
        {
            let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(&agent)
                .map_err(|e| error("busy", format!("Scheduler transaction unavailable: {e}")))?;
            crate::session_deletion_journal::recover_pending(state, &agent)?;
            if !state.deletion_fork_writer_proven_stopped() {
                return Err(error("busy", "Session deletion is blocked until prior fork or clone writers are confirmed stopped"));
            }
            let index = crate::scheduled_session_index::ScheduledSessionIndex::load_for_deletion(&agent)
                .map_err(|e| error("io", format!("Cannot verify scheduled session references: {e}")))?;
            match delete_with_index(state, args, &index, true, None)? {
                DeleteOutcome::Preflight(proof) => preflight_proof = Some(proof),
                DeleteOutcome::Deleted(_) => return Err(error("io", "Unexpected deletion preflight result")),
            }
        }
        if live {
            state.registry.with_offline_session_writer(id, std::time::Duration::from_secs(5), || Ok::<_, (String, String)>(()))
                .map_err(|failure| match failure {
                    session_host::SessionWriterError::Busy(message) => error("busy", message),
                    session_host::SessionWriterError::Operation(error) => error,
                })?;
        }
    }
    if preflight_proof.as_ref().is_some_and(|proof| proof.trash.is_some()) {
        // Never upgrade a held read lock. The final complete disk/live scan is
        // repeated under exclusive policy admission and the scheduler gate.
        drop(policy);
        after_unlock();
        let _policy = state.policy_gate.try_write().map_err(|_| error("busy", "Session policy change is in progress"))?;
        after_exclusive();
        if crate::trust_policy_fence::is_pending(&agent) { return Err(error("busy", "Trust policy outcome is unresolved")); }
        refuse_pending_writer_targets(&agent)?;
        return delete_after_policy(state, args, &agent, preflight_proof.as_ref());
    }
    delete_after_policy(state, args, &agent, preflight_proof.as_ref())
}

fn delete_after_policy(state: &IpcHostState, args: &Value, agent: &Path, proof: Option<&DeletePreflight>) -> Result<Value, (String, String)> {
    let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(&agent)
        .map_err(|e| error("busy", format!("Scheduler transaction unavailable: {e}")))?;
    crate::session_deletion_journal::recover_pending(state, &agent)?;
    if !state.deletion_fork_writer_proven_stopped() {
        return Err(error("busy", "Session deletion is blocked until prior fork or clone writers are confirmed stopped"));
    }
    let index = crate::scheduled_session_index::ScheduledSessionIndex::load_for_deletion(&agent)
        .map_err(|e| error("io", format!("Cannot verify scheduled session references: {e}")))?;
    match delete_with_index(state, args, &index, false, proof)? {
        DeleteOutcome::Deleted(result) => Ok(result),
        DeleteOutcome::Preflight(_) => Err(error("io", "Unexpected deletion result")),
    }
}


fn delete_with_index(state: &IpcHostState, args: &Value, scheduled: &impl ScheduledReferences, preflight: bool, proof: Option<&DeletePreflight>) -> Result<DeleteOutcome, (String, String)> {
    let id = args.get("session").and_then(Value::as_str).filter(|v| !v.is_empty())
        .ok_or_else(|| error("invalid_args", "session is required"))?;
    if args.get("trashChatFolder").is_some_and(|v| !v.is_boolean()) {
        return Err(error("invalid_args", "trashChatFolder must be a boolean"));
    }
    let trash_chat_folder = args.get("trashChatFolder").and_then(Value::as_bool) == Some(true);
    let affected = affected_session_ids(state, id)?;
    state.registry.with_idle_session_writers(&affected.ids, |_| {
        let checked = affected_session_ids(state, id)?;
        if checked.ids != affected.ids { return Err(error("busy", "Session references changed during deletion preflight")); }
        verify_member_proofs(&affected.proofs, &checked.proofs)?;
        if affected.ids.iter().any(|id| scheduled.is_referenced(id)) {
            return Err(error("not_supported", "Session is still referenced by a scheduled run or archive."));
        }
        delete_locked(state, id, scheduled, trash_chat_folder, preflight, proof, &checked)
    })
        .map_err(|error| match error {
            session_host::SessionWriterError::Busy(message) => self::error("busy", message),
            session_host::SessionWriterError::Operation(error) => error,
        })
}

fn verify_member_proofs(before: &[DeleteMemberProof], after: &[DeleteMemberProof]) -> Result<(), (String, String)> {
    if before.len() != after.len() { return Err(error("busy", "Affected sessions changed during deletion")); }
    for old in before {
        let current = after.iter().find(|member| member.id == old.id).ok_or_else(|| error("busy", "Affected sessions changed during deletion"))?;
        let retained = old.file.metadata().map_err(|e| error("io", e))?;
        if !same_path(&old.path, &current.path) || !same_file_version(&old.metadata, &retained) || !same_file_version(&old.metadata, &current.metadata) {
            return Err(error("busy", "Affected session changed during deletion"));
        }
    }
    Ok(())
}

fn delete_locked(state: &IpcHostState, id: &str, scheduled: &impl ScheduledReferences, trash_chat_folder: bool, preflight: bool, proof: Option<&DeletePreflight>, discovery: &AffectedSessions) -> Result<DeleteOutcome, (String, String)> {
    let affected = &discovery.ids;
    if scheduled.is_referenced(id) {
        return Err(error("not_supported", "Session is still referenced by a scheduled run or archive."));
    }
    // Never stop a writer on the user's behalf; removal waits for a truly
    // inactive child, and prevents a stale queued message from disappearing.
    if affected.iter().any(|session| (!preflight || session != id) && state.registry.get(session).is_some()) {
        return Err(error("busy", "Close affected sessions and wait for queued messages before deleting them."));
    }
    let root = state.agent_dir().join("sessions").canonicalize().map_err(|e| error("io", e))?;
    let mut files = Vec::new();
    files_in(&root, &mut files)?;
    let mut target: Option<(PathBuf, std::fs::File, std::fs::Metadata)> = None;
    let mut target_cwd: Option<PathBuf> = None;
    let mut session_cwds = Vec::new();
    let mut members = Vec::new();
    let mut path_ids = Vec::new();
    for file in files {
        let handle = std::fs::File::open(&file).map_err(|e| error("io", e))?;
        let before = handle.metadata().map_err(|e| error("io", e))?;
        let mut reader = std::io::BufReader::new(handle);
        let header = bounded_line(&mut reader, 64 * 1024)?.ok_or_else(|| error("not_supported", "Cannot verify an empty session file."))?;
        if header.get("type").and_then(Value::as_str) != Some("session") { return Err(error("not_supported", "Cannot verify a session header.")); }
        let child_id = header.get("id").and_then(Value::as_str).ok_or_else(|| error("not_supported", "Cannot verify a session id."))?;
        let cwd = match header.get("cwd") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(PathBuf::from(value)),
            _ => return Err(error("not_supported", "Cannot verify a session working directory.")),
        };
        let parent = match header.get("parentSession") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(PathBuf::from(value)),
            _ => return Err(error("not_supported", "Cannot verify a parent session path.")),
        };
        // The metadata may appear anywhere in the transcript, not just after
        // the header. A malformed or oversized entry makes absence unprovable.
        let mut subagent_parent = None;
        while let Some(entry) = bounded_line(&mut reader, 16 * 1024 * 1024)? {
            if entry.get("type").and_then(Value::as_str) == Some("custom")
                && entry.get("customType").and_then(Value::as_str) == Some("pi-web:subagent")
            {
                let parent = verified_subagent_parent(&entry)?;
                if subagent_parent.is_some() {
                    return Err(error("not_supported", "Cannot verify duplicate subagent metadata."));
                }
                subagent_parent = Some(parent.to_string());
            }
        }
        let after = reader.get_ref().metadata().map_err(|e| error("io", e))?;
        if before.len() != after.len() || before.modified().map_err(|e| error("io", e))? != after.modified().map_err(|e| error("io", e))? {
            return Err(error("busy", "Session changed while checking references"));
        }
        path_ids.push((file.clone(), child_id.to_string()));
        if affected.binary_search_by(|candidate| candidate.as_str().cmp(child_id)).is_ok() {
            members.push(ScannedMember { id: child_id.to_string(), path: file.clone(), header: header.clone(), parent: parent.clone(),
                subagent_parent: subagent_parent.clone(), file: reader.get_ref().try_clone().map_err(|e| error("io", e))?, metadata: after.clone() });
        }
        if child_id == id {
            if target.is_some() { return Err(error("not_supported", "Duplicate session ids require manual resolution.")); }
            target_cwd = cwd.clone();
            target = Some((file.clone(), reader.into_inner(), after));
        }
        session_cwds.push((child_id.to_string(), cwd));
    }
    let (target, target_handle, target_metadata) = target.ok_or_else(|| error("not_found", "Session not found"))?;
    let current_metadata = target_handle.metadata().map_err(|e| error("io", e))?;
    if !same_file_version(&target_metadata, &current_metadata) {
        return Err(error("busy", "Session changed after reference scan"));
    }
    let canonical_target = target.canonicalize().map_err(|e| error("io", e))?;
    if !canonical_target.starts_with(&root) { return Err(error("access_denied", "Session path is outside session storage.")); }
    if let Some(proof) = proof {
        let original = proof.file.metadata().map_err(|e| error("io", e))?;
        if !same_path(&proof.path, &canonical_target) || !same_file_version(&proof.metadata, &original)
            || !same_file_version(&proof.metadata, &target_metadata) || proof.affected.len() != members.len() {
            return Err(error("busy", "Session file changed after deletion preflight"));
        }
        for old in &proof.affected {
            let current = members.iter().find(|member| member.id == old.id).ok_or_else(|| error("busy", "Affected sessions changed after deletion preflight"))?;
            let original = old.file.metadata().map_err(|e| error("io", e))?;
            if !same_path(&old.path, &current.path) || !same_file_version(&old.metadata, &original) || !same_file_version(&old.metadata, &current.metadata) {
                return Err(error("busy", "Affected session changed after deletion preflight"));
            }
        }
    }
    let member_proofs = members.iter().map(|member| Ok(DeleteMemberProof { id: member.id.clone(), path: member.path.clone(),
        file: member.file.try_clone().map_err(|e| error("io", e))?, metadata: member.metadata.clone() })).collect::<Result<Vec<_>, (String, String)>>()?;
    verify_member_proofs(&discovery.proofs, &member_proofs)?;
    for member in &members {
        if !same_file_version(&member.metadata, &member.file.metadata().map_err(|e| error("io", e))?) {
            return Err(error("busy", "Affected session changed after reference scan"));
        }
    }
    let mut deleted = std::collections::HashSet::from([id.to_string()]);
    loop {
        let mut changed = false;
        for member in &members {
            if member.subagent_parent.as_ref().is_some_and(|parent| deleted.contains(parent)) && deleted.insert(member.id.clone()) { changed = true; }
        }
        if !changed { break; }
    }
    if let Some(cwd) = &target_cwd {
        for session_id in state.registry.ids() {
            if deleted.contains(&session_id) { continue; }
            let session = state.registry.get(&session_id).ok_or_else(|| error("busy", "Cannot verify a live session"))?;
            if !session.session_file.is_file() && same_existing_folder(&session.cwd, cwd)? {
                return Err(error("busy", "An unpersisted live session may reference this session's workspace"));
            }
        }
    }
    let mut moving_chat = None;
    if trash_chat_folder {
        if let Some(cwd) = target_cwd.filter(|cwd| crate::session_view::is_chat_folder_path(cwd, &state.agent_dir())) {
            let exists = match std::fs::symlink_metadata(&cwd) {
                Ok(_) => true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                Err(e) => return Err(error("io", e)),
            };
            if exists {
                let mut shared = false;
                for (session_id, other) in &session_cwds {
                    if deleted.contains(session_id) { continue; }
                    let other = other.as_ref().ok_or_else(|| error("busy", "Cannot verify another session's working directory"))?;
                    if same_existing_folder(other, &cwd)? { shared = true; break; }
                }
                if !shared {
                    for session_id in state.registry.ids() {
                        if deleted.contains(&session_id) { continue; }
                        let session = state.registry.get(&session_id).ok_or_else(|| error("busy", "Cannot verify a live session's working directory"))?;
                        if same_existing_folder(&session.cwd, &cwd)? { shared = true; break; }
                    }
                }
                if shared {
                    if proof.is_some_and(|proof| proof.trash.is_some()) {
                        return Err(error("busy", "Another session now references the chat folder"));
                    }
                } else {
                    let current = open_chat_folder(&cwd)?;
                    if !preflight {
                        let old = proof.and_then(|proof| proof.trash.as_ref()).ok_or_else(|| error("busy", "Chat folder requires exclusive policy admission"))?;
                        if !same_path(&old.path, &current.path) || !same_directory(&old.metadata, &old.file.metadata().map_err(|e| error("io", e))?)
                            || !same_directory(&old.metadata, &current.metadata) {
                            return Err(error("busy", "Chat folder changed after deletion preflight"));
                        }
                    }
                    moving_chat = Some(current);
                }
            } else if proof.is_some_and(|proof| proof.trash.is_some()) {
                return Err(error("busy", "Chat folder disappeared after deletion preflight"));
            }
        }
    }
    let root_member = members.iter().find(|member| member.id == id).ok_or_else(|| error("busy", "Target session changed during scan"))?;
    let target_parent = root_member.parent.clone();
    if let Some(parent) = &target_parent {
        let resolved = parent.canonicalize().unwrap_or_else(|_| parent.clone());
        if members.iter().filter(|member| deleted.contains(&member.id))
            .any(|member| same_path(&member.path.canonicalize().unwrap_or_else(|_| member.path.clone()), &resolved)) {
            return Err(error("not_supported", "Cannot reparent through a deleted session"));
        }
    }
    let parent_id = target_parent.as_ref().and_then(|parent| {
        let resolved = parent.canonicalize().unwrap_or_else(|_| parent.clone());
        path_ids.iter().find(|(path, _)| same_path(&path.canonicalize().unwrap_or_else(|_| path.clone()), &resolved)).map(|(_, id)| id.clone())
    });
    for member in &members {
        if deleted.contains(&member.id) { continue; }
        if let Some(parent) = &member.parent {
            if same_path(&parent.canonicalize().unwrap_or_else(|_| parent.clone()), &canonical_target)
                && member.path.parent() != canonical_target.parent() {
                return Err(error("not_supported", "Cannot safely reparent a child outside the session directory."));
            }
        }
    }
    if preflight {
        let affected = members.iter().map(|member| Ok(DeleteMemberProof { id: member.id.clone(), path: member.path.clone(),
            file: member.file.try_clone().map_err(|e| error("io", e))?, metadata: member.metadata.clone() })).collect::<Result<Vec<_>, (String, String)>>()?;
        return Ok(DeleteOutcome::Preflight(DeletePreflight { path: canonical_target, file: target_handle, metadata: target_metadata, affected, trash: moving_chat }));
    }
    let folder_trashed = moving_chat.is_some();
    if members.len() == 1 && !folder_trashed {
        crate::session_deletion_journal::remove(&root, &state.agent_dir(), id, &canonical_target, &target_metadata)?;
    } else {
        let mut mutations = Vec::new();
        for mut member in members {
            let remove = deleted.contains(&member.id);
            let direct_child = member.parent.as_ref().is_some_and(|parent| same_path(&parent.canonicalize().unwrap_or_else(|_| parent.clone()), &canonical_target));
            if !remove && !direct_child { continue; }
            let replacement_header = if remove { None } else {
                let header = member.header.as_object_mut().ok_or_else(|| error("io", "Invalid session header"))?;
                match &target_parent {
                    Some(parent) => { header.insert("parentSession".into(), json!(parent.to_string_lossy())); },
                    None => { header.remove("parentSession"); },
                }
                Some(serde_json::to_string(&member.header).map_err(|e| error("io", e))?)
            };
            let marker_parent = if !remove { target_parent.as_ref().zip(parent_id.as_ref()).map(|(path, parent)| (parent.clone(), path.to_string_lossy().into_owned())) } else { None };
            let path = member.path.canonicalize().map_err(|e| error("io", e))?;
            if !path.starts_with(&root) { return Err(error("access_denied", "Session path is outside session storage.")); }
            mutations.push(crate::session_deletion_journal::GroupMutation { session: member.id, path, handle: member.file, metadata: member.metadata, replacement_header, marker_parent });
        }
        let trash = match moving_chat {
            Some(chat) => {
                let trash = crate::session_deletion_journal::prepare_trash(&state.agent_dir(), &chat.path, state.deletion_prefers_fixture_trash())?;
                if !same_directory(&chat.metadata, &chat.file.metadata().map_err(|e| error("io", e))?) || !same_directory(&chat.metadata, &trash.metadata) {
                    return Err(error("busy", "Chat folder changed before Trash staging"));
                }
                Some(trash)
            }
            None => None,
        };
        crate::session_deletion_journal::remove_group(&root, &state.agent_dir(), mutations, trash)?;
    }
    Ok(DeleteOutcome::Deleted(json!({"ok": true, "folderTrashed": folder_trashed})))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixtureIndex(Vec<String>);
    impl ScheduledReferences for FixtureIndex {
        fn is_referenced(&self, id: &str) -> bool { self.0.iter().any(|entry| entry == id) }
    }
    fn delete(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
        match delete_with_index(state, args, &FixtureIndex(Vec::new()), false, None)? {
            DeleteOutcome::Deleted(result) => Ok(result),
            DeleteOutcome::Preflight(_) => Err(error("io", "Unexpected test deletion result")),
        }
    }

    fn fixture() -> (tempfile::TempDir, IpcHostState, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions/project");
        std::fs::create_dir_all(&root).unwrap();
        let state = IpcHostState::new();
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        state.deletion_fork_writer_exclusive.store(true, std::sync::atomic::Ordering::SeqCst);
        state.deletion_use_app_trash.store(true, std::sync::atomic::Ordering::SeqCst);
        (dir, state, root)
    }
    fn session(root: &Path, id: &str, parent: Option<&Path>) -> PathBuf {
        let path = root.join(format!("{id}.jsonl"));
        let header = json!({"type":"session", "version":3, "id":id, "cwd":root, "timestamp":"2026-01-01T00:00:00Z", "parentSession":parent});
        std::fs::write(&path, format!("{header}\n")).unwrap();
        path
    }
    #[test]
    fn scheduler_references_and_missing_index_fail_closed() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let args = json!({"session":"target"});
        assert_eq!(delete_with_index(&state, &args, &FixtureIndex(vec!["target".into()]), false, None).unwrap_err().0, "not_supported");
        assert!(target.exists());
    }
    #[cfg(unix)]
    #[test]
    fn idle_live_child_is_closed_only_after_preflight_and_real_exit() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let bridge = dir.path().join("bridge.mjs");
        std::fs::write(&bridge, "// fixture").unwrap();
        let script = r##"#!/usr/bin/env node
const readline = require('node:readline');
const bridge = BRIDGE_PATH;
const emit = x => process.stdout.write(JSON.stringify(x) + '\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  const reply = data => emit({type:'response',id:r.id,command:r.type,success:true,data});
  if (r.type === 'get_state') return reply({sessionId:'target',isStreaming:false,isCompacting:false,thinkingLevel:'off'});
  if (r.type === 'get_commands') return reply({commands:[{name:'pi-web:bridge',source:'extension',sourceInfo:{path:bridge}}]});
  if (r.type === 'prompt' && r.message.startsWith('/pi-web:bridge ')) {
    const [, rid, encoded] = r.message.split(' '); const payload = JSON.parse(Buffer.from(encoded,'base64url'));
    reply({disposition:'handled'});
    return emit({type:'extension_ui_request',id:'notice',method:'notify',message:'PI_WEB_BRIDGE_V1 '+JSON.stringify({sid:'target',rid,nonce:payload.nonce,ok:true,result:{}})});
  }
  if (r.type === 'prompt') { emit({type:'agent_start'}); return reply({}); }
  if (r.type === 'interrupt') { emit({type:'agent_settled'}); return reply({}); }
  reply({});
});
"##.replace("BRIDGE_PATH", &serde_json::to_string(&bridge.to_string_lossy()).unwrap());
        let executable = dir.path().join("mock-pi");
        std::fs::write(&executable, script).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = session_host::SessionSpawnConfig {
            executable: executable.to_string_lossy().into_owned(), agent_dir: Some(dir.path().to_path_buf()),
            session_dir: Some(root.clone()), bridge_asset: bridge, artifacts_asset: None, chat_asset: None,
            chat_asset_sha256: None, shape: session_host::SessionSpawnShape::Project { tool_args: None },
            initial_model: None, thinking_level: None, extra_args: Vec::new(),
        };
        let live = state.registry.start("target", &target, "target", &root, &config).unwrap();
        let runs = dir.path().join("scheduled-tasks/runs"); std::fs::create_dir_all(&runs).unwrap();
        let archive = runs.join("12345678-1234-1234-1234-123456789abc.archive.jsonl");
        std::fs::write(&archive, format!("{}\n", json!({"runId":"r","sessionId":"target"}))).unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(state.registry.get("target").is_some() && target.exists());
        std::fs::remove_file(archive).unwrap();
        let child = session(&root, "child", Some(&target));
        let queue = state.registry.composer_outbox_for("child");
        let pending = queue.enqueue("pending", None).unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap_err().0, "busy");
        assert!(state.registry.get("target").is_some() && target.exists());
        queue.take(&pending.id);
        std::fs::remove_file(child).unwrap();
        live.command("prompt", json!({"message":"fixture only"}), Some(std::time::Duration::from_secs(2))).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !live.run_state().is_running() { assert!(std::time::Instant::now() < deadline); std::thread::sleep(std::time::Duration::from_millis(5)); }
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap_err().0, "busy");
        assert!(state.registry.get("target").is_some() && target.exists());
        live.command("interrupt", json!({}), Some(std::time::Duration::from_secs(2))).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while live.run_state().is_running() { assert!(std::time::Instant::now() < deadline); std::thread::sleep(std::time::Duration::from_millis(5)); }
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap()["ok"], true);
        assert!(state.registry.get("target").is_none());
        assert!(!target.exists());
        drop(live);
    }
    #[test]
    fn deletion_refuses_a_parent_inside_its_own_deleted_subtree() {
        let (_dir, state, root) = fixture();
        let sub = session(&root, "sub", None);
        let target = session(&root, "target", Some(&sub));
        use std::io::Write;
        writeln!(std::fs::OpenOptions::new().append(true).open(&sub).unwrap(), "{}", json!({"type":"custom","customType":"pi-web:subagent","data":{"version":1,"parentSessionId":"target","parentSessionPath":target}})).unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists() && sub.exists());
    }
    #[test]
    fn group_deletion_reparents_forks_and_removes_transitive_subagents() {
        let (_dir, state, root) = fixture();
        let grandparent = session(&root, "grandparent", None);
        let target = session(&root, "target", Some(&grandparent));
        let fork = session(&root, "fork", Some(&target));
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&fork, std::fs::Permissions::from_mode(0o640)).unwrap(); }
        #[cfg(target_os = "linux")] {
            use std::os::unix::ffi::OsStrExt;
            let path = std::ffi::CString::new(fork.as_os_str().as_bytes()).unwrap();
            let name = std::ffi::CString::new("user.pi-fixture").unwrap();
            assert_eq!(unsafe { libc::setxattr(path.as_ptr(), name.as_ptr(), b"fixture".as_ptr().cast(), 7, 0) }, 0);
        }
        let sub1 = session(&root, "sub1", None);
        let sub2 = session(&root, "sub2", None);
        use std::io::Write;
        for (path, parent) in [(&sub1, "target"), (&sub2, "sub1"), (&fork, "other")] {
            let marker = json!({"type":"custom","customType":"pi-web:subagent","data":{"version":1,"parentSessionId":parent,"parentSessionPath":"old"}});
            writeln!(std::fs::OpenOptions::new().append(true).open(path).unwrap(), "{marker}").unwrap();
        }
        writeln!(std::fs::OpenOptions::new().append(true).open(&fork).unwrap(), "{}", json!({"type":"message","message":{"role":"user","content":"keep"}})).unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap()["ok"], true);
        assert!(!target.exists() && !sub1.exists() && !sub2.exists());
        assert!(grandparent.exists());
        let content = std::fs::read_to_string(&fork).unwrap();
        let mut lines = content.lines();
        let header: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        let marker: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(header["parentSession"], grandparent.to_string_lossy().as_ref());
        assert_eq!(marker["data"]["parentSessionId"], "grandparent");
        assert_eq!(marker["data"]["parentSessionPath"], grandparent.to_string_lossy().as_ref());
        assert!(lines.next().unwrap().contains("keep"));
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(&fork).unwrap().permissions().mode() & 0o777, 0o640); }
        #[cfg(target_os = "linux")] {
            use std::os::unix::ffi::OsStrExt;
            let path = std::ffi::CString::new(fork.as_os_str().as_bytes()).unwrap();
            let name = std::ffi::CString::new("user.pi-fixture").unwrap();
            let mut value = [0u8; 16];
            let count = unsafe { libc::getxattr(path.as_ptr(), name.as_ptr(), value.as_mut_ptr().cast(), value.len()) };
            assert_eq!(count, 7);
            assert_eq!(&value[..7], b"fixture");
        }
    }
    #[test]
    fn affected_set_includes_transitive_subagents_and_direct_forks() {
        let (dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let fork = session(&root, "fork", Some(&target));
        let sub1 = session(&root, "sub1", None);
        let sub2 = session(&root, "sub2", None);
        let unrelated = session(&root, "unrelated", None);
        use std::io::Write;
        for (path, parent) in [(&sub1, "target"), (&sub2, "sub1")] {
            let marker = json!({"type":"custom","customType":"pi-web:subagent","data":{"version":1,"parentSessionId":parent,"parentSessionPath":"fixture"}});
            writeln!(std::fs::OpenOptions::new().append(true).open(path).unwrap(), "{marker}").unwrap();
        }
        assert_eq!(affected_session_ids(&state, "target").unwrap().ids, vec!["fork", "sub1", "sub2", "target"]);
        let args = json!({"session":"target"});
        assert_eq!(delete_with_index(&state, &args, &FixtureIndex(vec!["sub2".into()]), false, None).unwrap_err().0, "not_supported");
        crate::session_writer_fence::begin(dir.path(), "fork", "op", "chat", &fork, None).unwrap();
        assert_eq!(super::delete(&state, &args).unwrap_err().0, "busy");
        assert!(target.exists() && fork.exists() && sub1.exists() && sub2.exists() && unrelated.exists());
    }
    #[test]
    fn affected_discovery_keeps_identity_when_a_child_is_replaced() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let child = session(&root, "child", Some(&target));
        let before = affected_session_ids(&state, "target").unwrap();
        std::fs::rename(&child, root.join("old-child.saved")).unwrap();
        std::fs::write(&child, format!("{}\n", json!({"type":"session","id":"child","cwd":root,"parentSession":target,"replacement":true}))).unwrap();
        let after = affected_session_ids(&state, "target").unwrap();
        assert_eq!(before.ids, after.ids);
        assert_eq!(verify_member_proofs(&before.proofs, &after.proofs).unwrap_err().0, "busy");
        assert!(std::fs::read_to_string(&child).unwrap().contains("replacement"));
    }
    #[test]
    fn deletion_preflight_keeps_identity_across_replacement() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let args = json!({"session":"target"});
        let index = FixtureIndex(Vec::new());
        let proof = match delete_with_index(&state, &args, &index, true, None).unwrap() {
            DeleteOutcome::Preflight(proof) => proof,
            other => panic!("unexpected result: {other:?}"),
        };
        std::fs::rename(&target, root.join("original.saved")).unwrap();
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":root,"replacement":true}))).unwrap();
        assert_eq!(delete_with_index(&state, &args, &index, false, Some(&proof)).unwrap_err().0, "busy");
        assert!(std::fs::read_to_string(&target).unwrap().contains("replacement"));
        assert!(root.join("original.saved").exists());
    }
    #[test]
    fn deletion_preflight_refuses_post_scan_append() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let args = json!({"session":"target"});
        let index = FixtureIndex(Vec::new());
        let proof = match delete_with_index(&state, &args, &index, true, None).unwrap() {
            DeleteOutcome::Preflight(proof) => proof,
            other => panic!("unexpected result: {other:?}"),
        };
        use std::io::Write;
        writeln!(std::fs::OpenOptions::new().append(true).open(&target).unwrap(), "{}", json!({"type":"custom","customType":"new"})).unwrap();
        assert_eq!(delete_with_index(&state, &args, &index, false, Some(&proof)).unwrap_err().0, "busy");
        assert!(std::fs::read_to_string(&target).unwrap().contains("new"));
    }
    #[test]
    fn unknown_prior_fork_writer_blocks_deletion_before_side_effects() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        state.deletion_fork_writer_exclusive.store(false, std::sync::atomic::Ordering::SeqCst);
        let result = super::delete(&state, &json!({"session":"target"})).unwrap_err();
        assert_eq!(result.0, "busy");
        assert!(result.1.contains("fork or clone writers"));
        assert!(target.exists());
        assert!(!crate::session_deletion_journal::has_pending(&state.agent_dir()).unwrap());
    }
    #[test]
    fn production_delete_rejects_policy_and_unresolved_writer_fences() {
        let (dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let args = json!({"session":"target"});
        let policy = state.policy_gate.try_write().unwrap();
        assert_eq!(super::delete(&state, &args).unwrap_err().0, "busy");
        drop(policy);
        let lock = state.registry.start_lock_for("target");
        let writer = lock.lock().unwrap();
        assert_eq!(super::delete(&state, &args).unwrap_err().0, "busy");
        drop(writer);
        crate::session_writer_fence::begin(dir.path(), "target", "op", "chat", &target, None).unwrap();
        assert_eq!(super::delete(&state, &args).unwrap_err().0, "busy");
        assert!(target.exists());
        crate::session_writer_fence::finish(dir.path(), "target", "op").unwrap();
        let trust = crate::trust_policy_fence::marker_path(dir.path());
        std::fs::write(&trust, "corrupt").unwrap();
        assert_eq!(super::delete(&state, &args).unwrap_err().0, "busy");
        assert!(target.exists());
    }
    #[test]
    fn production_delete_checks_the_strict_scheduled_index() {
        let (dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let runs = dir.path().join("scheduled-tasks/runs");
        std::fs::create_dir_all(&runs).unwrap();
        let id = "12345678-1234-1234-1234-123456789abc";
        let run = runs.join(format!("{id}.archive.jsonl"));
        std::fs::write(&run, format!("{}\n", json!({"runId":"run","sessionId":"target"}))).unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists());
        std::fs::write(&run, "{broken\n").unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap_err().0, "io");
        assert!(target.exists());
        std::fs::remove_file(run).unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap()["ok"], true);
        assert!(!target.exists());
    }
    #[test]
    fn production_ipc_deletes_an_unreferenced_offline_session() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let response = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"delete","op":"sessions.delete","args":{"session":"target","trashChatFolder":false}}));
        assert_eq!(response["ok"], true, "{response}");
        assert!(!target.exists());
    }
    #[test]
    fn scheduler_gate_covers_index_load_and_removal() {
        let (dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let guard = task_scheduler::transaction_lock::TransactionLock::acquire(dir.path()).unwrap();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| super::delete(&state, &json!({"session":"target"})));
            std::thread::sleep(std::time::Duration::from_millis(100));
            assert!(target.exists());
            let runs = dir.path().join("scheduled-tasks/runs");
            std::fs::create_dir_all(&runs).unwrap();
            std::fs::write(runs.join("12345678-1234-1234-1234-123456789abc.archive.jsonl"), format!("{}\n", json!({"runId":"r","sessionId":"target"}))).unwrap();
            drop(guard);
            assert_eq!(worker.join().unwrap().unwrap_err().0, "not_supported");
        });
        assert!(target.exists());
    }
    #[test]
    fn deletes_only_an_unreferenced_offline_file() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let sibling = session(&root, "sibling", None);
        let result = delete(&state, &json!({"session":"target"})).unwrap();
        assert_eq!(result["folderTrashed"], false);
        assert!(!target.exists());
        assert!(sibling.exists());
    }
    #[test]
    fn rejects_queued_deletion_without_side_effects() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let child = session(&root, "child", Some(&target));
        let queue = state.registry.composer_outbox_for("child");
        let pending = queue.enqueue("pending", None).unwrap();
        assert_eq!(delete(&state, &json!({"session":"target"})).unwrap_err().0, "busy");
        assert!(target.exists() && child.exists());
        queue.take(&pending.id);
        let chat = state.agent_dir().join("chats/chat-1");
        std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(&child, format!("{}\n", json!({"type":"session","id":"child","cwd":chat,"parentSession":target}))).unwrap();
        assert_eq!(delete(&state, &json!({"session":"child","trashChatFolder":true})).unwrap_err().0, "busy");
        assert!(child.exists());
        state.registry.composer_outbox_for("child").enqueue("queued", None).unwrap();
        assert_eq!(delete(&state, &json!({"session":"child"})).unwrap_err().0, "busy");
        assert!(child.exists());
    }
    #[test]
    fn unshared_chat_folder_moves_to_fixture_trash_with_session() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(chat.join("kept.txt"), "user data").unwrap();
        let target = root.join("target.jsonl");
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":chat}))).unwrap();
        let result = super::delete(&state, &json!({"session":"target","trashChatFolder":true})).unwrap();
        assert_eq!(result["folderTrashed"], true);
        assert!(!target.exists() && !chat.exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("chats-trash/chat-one/kept.txt")).unwrap(), "user data");
    }
    #[test]
    fn deleted_chat_subagents_do_not_keep_an_unshared_folder() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(chat.join("kept.txt"), "user data").unwrap();
        let target = root.join("target.jsonl"); let sub = root.join("sub.jsonl");
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":chat}))).unwrap();
        std::fs::write(&sub, format!("{}\n{}\n", json!({"type":"session","id":"sub","cwd":chat}), json!({"type":"custom","customType":"pi-web:subagent","data":{"version":1,"parentSessionId":"target","parentSessionPath":target}}))).unwrap();
        let result = super::delete(&state, &json!({"session":"target","trashChatFolder":true})).unwrap();
        assert_eq!(result["folderTrashed"], true);
        assert!(!target.exists() && !sub.exists() && !chat.exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("chats-trash/chat-one/kept.txt")).unwrap(), "user data");
    }
    #[test]
    fn new_disk_chat_reference_between_policy_gates_refuses_the_move() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(chat.join("kept.txt"), "user data").unwrap();
        let target = root.join("target.jsonl");
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":chat}))).unwrap();
        let other = root.join("new.jsonl");
        let result = delete_with_policy_hook(&state, &json!({"session":"target","trashChatFolder":true}), || {
            std::fs::write(&other, format!("{}\n", json!({"type":"session","id":"new","cwd":chat}))).unwrap();
        }).unwrap_err();
        assert_eq!(result.0, "busy");
        assert!(target.exists() && other.exists() && chat.join("kept.txt").exists());
    }
    #[cfg(unix)]
    #[test]
    fn new_unflushed_live_chat_between_policy_gates_refuses_move() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
        let target = root.join("target.jsonl");
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":chat}))).unwrap();
        let bridge = dir.path().join("bridge.mjs"); std::fs::write(&bridge, "// fixture").unwrap();
        let script = r##"#!/usr/bin/env node
const readline = require('node:readline'); const bridge = BRIDGE_PATH;
readline.createInterface({input:process.stdin}).on('line', line => {
  const r=JSON.parse(line); let data={};
  if(r.type==='get_state') data={sessionId:'live',isStreaming:false,isCompacting:false,thinkingLevel:'off'};
  if(r.type==='get_commands') data={commands:[{name:'pi-web:bridge',source:'extension',sourceInfo:{path:bridge}}]};
  process.stdout.write(JSON.stringify({type:'response',id:r.id,command:r.type,success:true,data})+'\n');
});
"##.replace("BRIDGE_PATH", &serde_json::to_string(&bridge.to_string_lossy()).unwrap());
        let executable = dir.path().join("mock-pi"); std::fs::write(&executable, script).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = session_host::SessionSpawnConfig {
            executable:executable.to_string_lossy().into_owned(), agent_dir:Some(dir.path().to_path_buf()),
            session_dir:Some(root.clone()), bridge_asset:bridge, artifacts_asset:None, chat_asset:None,
            chat_asset_sha256:None, shape:session_host::SessionSpawnShape::Project { tool_args:None },
            initial_model:None, thinking_level:None, extra_args:Vec::new(),
        };
        let livefile = root.join("transient.jsonl");
        let result = delete_with_policy_hook(&state, &json!({"session":"target","trashChatFolder":true}), || {
            std::fs::write(&livefile, format!("{}\n", json!({"type":"session","id":"live","cwd":chat}))).unwrap();
            state.registry.start("live", &livefile, "live", &chat, &config).unwrap();
            std::fs::remove_file(&livefile).unwrap();
        }).unwrap_err();
        assert_eq!(result.0, "busy");
        assert!(target.exists() && chat.exists() && state.registry.get("live").is_some());
        assert_eq!(super::delete(&state, &json!({"session":"target","trashChatFolder":false})).unwrap_err().0, "busy");
        assert!(target.exists());
        state.registry.remove("live", std::time::Duration::from_secs(2));
    }
    #[test]
    fn replacement_chat_folder_between_policy_gates_is_never_moved() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(chat.join("old"), "original").unwrap();
        let target = root.join("target.jsonl");
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":chat}))).unwrap();
        let old = dir.path().join("chats/moved-original");
        let result = delete_with_policy_hook(&state, &json!({"session":"target","trashChatFolder":true}), || {
            std::fs::rename(&chat, &old).unwrap(); std::fs::create_dir(&chat).unwrap(); std::fs::write(chat.join("new"), "new data").unwrap();
        }).unwrap_err();
        assert_eq!(result.0, "busy");
        assert!(target.exists() && old.join("old").exists());
        assert_eq!(std::fs::read_to_string(chat.join("new")).unwrap(), "new data");
    }
    #[test]
    fn exclusive_policy_contention_does_not_wait_or_move_folder() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
        let target = root.join("target.jsonl");
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":chat}))).unwrap();
        let held = std::cell::RefCell::new(None);
        let result = delete_with_policy_hook(&state, &json!({"session":"target","trashChatFolder":true}), || {
            *held.borrow_mut() = Some(state.policy_gate.try_read().unwrap());
        }).unwrap_err();
        assert_eq!(result.0, "busy");
        assert!(target.exists() && chat.exists());
    }
    #[test]
    fn exclusive_chat_move_blocks_create_and_fork_before_file_creation() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
        let target = root.join("target.jsonl");
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":chat}))).unwrap();
        let result = delete_with_policy_hooks(&state, &json!({"session":"target","trashChatFolder":true}), || {}, || {
            let created = crate::pi_ipc::create_session(&state, &json!({"cwd":chat,"type":"ensure_session"})).unwrap_err();
            assert_eq!(created.0, "busy");
            let fork = crate::session_actions::branch(&state, &json!({"session":"target","type":"fork","entryId":"entry"})).unwrap_err();
            assert_eq!(fork.0, "busy");
            assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        }).unwrap();
        assert_eq!(result["folderTrashed"], true);
        assert!(!target.exists() && !chat.exists());
    }
    #[test]
    fn corrupt_unknown_writer_record_refuses_chat_folder_move() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
        let target = root.join("target.jsonl");
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":chat}))).unwrap();
        let result = delete_with_policy_hook(&state, &json!({"session":"target","trashChatFolder":true}), || {
            let fences = dir.path().join("pi-web/session-writer-fences"); std::fs::create_dir_all(&fences).unwrap();
            std::fs::write(fences.join("broken.json"), "{broken").unwrap();
        }).unwrap_err();
        assert_eq!(result.0, "busy");
        assert!(target.exists() && chat.exists());
    }
    #[test]
    fn pending_writer_of_any_identity_refuses_chat_folder_move() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
        let target = root.join("target.jsonl");
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":chat}))).unwrap();
        let result = delete_with_policy_hook(&state, &json!({"session":"target","trashChatFolder":true}), || {
            crate::session_writer_fence::begin(dir.path(), "other", "op", "continue", &target, None).unwrap();
        }).unwrap_err();
        assert_eq!(result.0, "busy");
        assert!(target.exists() && chat.exists());
    }
    #[cfg(unix)]
    #[test]
    fn chat_folder_reference_through_symlink_is_preserved() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
        let alias = dir.path().join("chat-alias"); std::os::unix::fs::symlink(&chat, &alias).unwrap();
        let target = root.join("target.jsonl"); let other = root.join("other.jsonl");
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":chat}))).unwrap();
        std::fs::write(&other, format!("{}\n", json!({"type":"session","id":"other","cwd":alias}))).unwrap();
        let result = super::delete(&state, &json!({"session":"target","trashChatFolder":true})).unwrap();
        assert_eq!(result["folderTrashed"], false);
        assert!(!target.exists() && other.exists() && chat.exists());
    }
    #[test]
    fn unresolvable_other_cwd_blocks_folder_trash() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
        let target = root.join("target.jsonl"); let other = root.join("other.jsonl");
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":chat}))).unwrap();
        std::fs::write(&other, format!("{}\n", json!({"type":"session","id":"other","cwd":dir.path().join("missing")}))).unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target","trashChatFolder":true})).unwrap_err().0, "busy");
        assert!(target.exists() && other.exists() && chat.exists());
    }
    #[test]
    fn deleting_shared_chat_parent_reparents_fork_and_keeps_folder() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(chat.join("kept.txt"), "user data").unwrap();
        let target = root.join("target.jsonl"); let fork = root.join("fork.jsonl");
        std::fs::write(&target, format!("{}\n", json!({"type":"session","id":"target","cwd":chat}))).unwrap();
        std::fs::write(&fork, format!("{}\n", json!({"type":"session","id":"fork","cwd":chat,"parentSession":target}))).unwrap();
        let result = super::delete(&state, &json!({"session":"target","trashChatFolder":true})).unwrap();
        assert_eq!(result["folderTrashed"], false);
        assert!(!target.exists() && fork.exists() && chat.join("kept.txt").exists());
        let header: Value = serde_json::from_str(std::fs::read_to_string(&fork).unwrap().lines().next().unwrap()).unwrap();
        assert!(header.get("parentSession").is_none());
    }
    #[test]
    fn deleting_one_shared_chat_session_keeps_the_folder() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-1");
        std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(chat.join("kept.txt"), "kept").unwrap();
        let parent = root.join("parent.jsonl");
        let child = root.join("child.jsonl");
        std::fs::write(&parent, format!("{}\n", json!({"type":"session","id":"parent","cwd":chat}))).unwrap();
        std::fs::write(&child, format!("{}\n", json!({"type":"session","id":"child","cwd":chat,"parentSession":parent}))).unwrap();
        let result = super::delete(&state, &json!({"session":"child","trashChatFolder":true})).unwrap();
        assert_eq!(result["folderTrashed"], false);
        assert!(parent.exists() && chat.join("kept.txt").exists());
        assert!(!child.exists());
    }
    #[test]
    fn deletes_an_offline_leaf_subagent_without_touching_its_parent() {
        let (_dir, state, root) = fixture();
        let parent = session(&root, "parent", None);
        let child = session(&root, "sub", None);
        let marker = json!({"type":"custom","customType":"pi-web:subagent","data":{"version":1,"parentSessionId":"parent","parentSessionPath":"fixture"}});
        use std::io::Write;
        writeln!(std::fs::OpenOptions::new().append(true).open(&child).unwrap(), "{marker}").unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"sub"})).unwrap()["ok"], true);
        assert!(parent.exists());
        assert!(!child.exists());
    }
    #[test]
    fn removes_subagent_subtree_and_keeps_unrelated_chat_folder() {
        let (dir, state, root) = fixture();
        let chat = dir.path().join("chats/chat-1");
        std::fs::create_dir_all(&chat).unwrap();
        std::fs::write(chat.join("kept.txt"), "kept").unwrap();
        let target = session(&root, "target", None);
        let child = session(&root, "sub", None);
        let marker = json!({"type":"custom","customType":"pi-web:subagent","data":{"version":1,"parentSessionId":"target","parentSessionPath":"fixture"}});
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().append(true).open(&child).unwrap();
        writeln!(file, "{}", json!({"type":"model_change","provider":"fixture","modelId":"fixture"})).unwrap();
        writeln!(file, "{marker}").unwrap();
        assert_eq!(delete(&state, &json!({"session":"target"})).unwrap()["ok"], true);
        assert!(!target.exists() && !child.exists() && chat.join("kept.txt").exists());
    }
    #[test]
    fn malformed_subagent_marker_never_authorizes_a_cascade() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let other = session(&root, "other", None);
        use std::io::Write;
        writeln!(std::fs::OpenOptions::new().append(true).open(&other).unwrap(), "{}", json!({"type":"custom","customType":"pi-web:subagent","data":{"parentSessionId":"target"}})).unwrap();
        assert_eq!(super::delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists() && other.exists());
    }
    #[test]
    fn malformed_transcript_cannot_prove_absence_of_subagents() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        let other = session(&root, "other", None);
        use std::io::Write;
        writeln!(std::fs::OpenOptions::new().append(true).open(&other).unwrap(), "{{broken").unwrap();
        assert_eq!(delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists() && other.exists());
    }
    #[test]
    fn malformed_or_duplicate_metadata_never_deletes() {
        let (_dir, state, root) = fixture();
        let target = session(&root, "target", None);
        std::fs::write(root.join("corrupt.jsonl"), "{broken\\n").unwrap();
        assert_eq!(delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists());
        std::fs::remove_file(root.join("corrupt.jsonl")).unwrap();
        let duplicate = root.join("duplicate.jsonl");
        std::fs::copy(&target, &duplicate).unwrap();
        assert_eq!(delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists() && duplicate.exists());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_session_layout_before_deleting() {
        let (dir, state, root) = fixture();
        let target = session(&root, "target", None);
        std::os::unix::fs::symlink(dir.path(), root.join("link")).unwrap();
        assert_eq!(delete(&state, &json!({"session":"target"})).unwrap_err().0, "not_supported");
        assert!(target.exists());
    }
}
