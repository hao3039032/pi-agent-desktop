//! Recoverable isolation of one session file. Caller holds the scheduler gate
//! and the session writer gate; paths come only from the host session scan.
#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::CString;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::MetadataExt;
    use std::path::{Component, Path};
    use serde::{Deserialize, Serialize};

    type Failure = (String, String);
    fn fail(code: &str, message: impl ToString) -> Failure { (code.into(), message.to_string()) }
    fn io(e: impl ToString) -> Failure { fail("io", e) }

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Journal { version: u8, session: String, source: String, device: u64, inode: u64, size: u64, mtime: i64, mtime_nsec: i64 }

    fn journal_dir(agent: &Path) -> Result<File, Failure> {
        let path = agent.join("session-deletion-journal");
        use std::os::unix::fs::DirBuilderExt;
        match std::fs::DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => {
                File::open(agent).and_then(|f| f.sync_all()).map_err(io)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
            Err(e) => return Err(io(e)),
        }
        open_dir_path(&path)
    }
    fn open_dir_path(path: &Path) -> Result<File, Failure> {
        let p = CString::new(path.as_os_str().as_encoded_bytes()).map_err(io)?;
        let fd = unsafe { libc::open(p.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(io(std::io::Error::last_os_error())); }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    fn c(name: &str) -> Result<CString, Failure> { CString::new(name).map_err(io) }
    fn open_directory(parent: &File, name: &str) -> Result<File, Failure> {
        crate::file_access::openat_directory_no_follow(parent, name).map_err(io)
    }
    fn parent_and_name(root: &Path, relative: &str) -> Result<(File, String), Failure> {
        let path = Path::new(relative);
        let parts: Vec<_> = path.components().collect();
        if parts.is_empty() { return Err(fail("io", "Invalid deletion journal source")); }
        let mut dir = open_dir_path(root)?;
        for (i, part) in parts.iter().enumerate() {
            let Component::Normal(name) = part else { return Err(fail("io", "Invalid deletion journal source")); };
            let name = name.to_str().ok_or_else(|| fail("io", "Invalid deletion journal source encoding"))?;
            if i + 1 == parts.len() {
                if !name.ends_with(".jsonl") { return Err(fail("io", "Invalid deletion journal source name")); }
                return Ok((dir, name.to_string()));
            }
            dir = open_directory(&dir, name)?;
        }
        unreachable!()
    }
    fn stat(parent: &File, name: &str) -> Result<Option<libc::stat>, Failure> {
        let name = c(name)?;
        let mut value = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstatat(parent.as_raw_fd(), name.as_ptr(), value.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 {
            let e = std::io::Error::last_os_error();
            return if e.kind() == std::io::ErrorKind::NotFound { Ok(None) } else { Err(io(e)) };
        }
        Ok(Some(unsafe { value.assume_init() }))
    }
    fn rename_no_replace(from: &File, name: &str, to: &File, dest: &str) -> Result<(), Failure> {
        let name = c(name)?; let dest = c(dest)?;
        if unsafe { libc::renameat2(from.as_raw_fd(), name.as_ptr(), to.as_raw_fd(), dest.as_ptr(), libc::RENAME_NOREPLACE) } != 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    fn unlink(parent: &File, name: &str, flags: i32) -> Result<(), Failure> {
        if unsafe { libc::unlinkat(parent.as_raw_fd(), c(name)?.as_ptr(), flags) } != 0 { return Err(io(std::io::Error::last_os_error())); }
        Ok(())
    }
    fn create_file(parent: &File, name: &str, data: &[u8]) -> Result<(), Failure> {
        let fd = unsafe { libc::openat(parent.as_raw_fd(), c(name)?.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) };
        if fd < 0 { return Err(io(std::io::Error::last_os_error())); }
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(data).and_then(|_| file.sync_all()).map_err(io)
    }
    fn read_file(parent: &File, name: &str) -> Result<Vec<u8>, Failure> {
        let fd = unsafe { libc::openat(parent.as_raw_fd(), c(name)?.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(io(std::io::Error::last_os_error())); }
        let file = unsafe { File::from_raw_fd(fd) };
        if !file.metadata().map_err(io)?.is_file() { return Err(fail("io", "Invalid deletion journal file")); }
        let mut bytes = Vec::new(); file.take(65537).read_to_end(&mut bytes).map_err(io)?;
        if bytes.len() > 65536 { return Err(fail("io", "Deletion journal too large")); }
        Ok(bytes)
    }
    fn valid_token(token: &str) -> bool { token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) }
    fn stage_name(token: &str) -> String { format!(".pi-deletion-{token}") }
    fn verify_journal(j: &Journal, token: &str) -> Result<(), Failure> {
        if j.version != 1 || j.session.is_empty() || !valid_token(token) { return Err(fail("io", "Invalid deletion journal")); }
        Ok(())
    }
    fn matches_expected(value: &libc::stat, journal: &Journal) -> bool {
        value.st_mode & libc::S_IFMT == libc::S_IFREG && value.st_dev as u64 == journal.device
            && value.st_ino as u64 == journal.inode && value.st_size as u64 == journal.size
            && value.st_mtime == journal.mtime && value.st_mtime_nsec == journal.mtime_nsec
    }
    fn original_is_expected(parent: &File, name: &str, journal: &Journal) -> Result<bool, Failure> {
        Ok(stat(parent, name)?.is_some_and(|value| matches_expected(&value, journal)))
    }
    fn finish(agent: &Path, root: &Path, token: &str, journal: &Journal) -> Result<(), Failure> {
        verify_journal(journal, token)?;
        let journal_root = journal_dir(agent)?;
        let transaction = open_directory(&journal_root, token)?;
        let committed = stat(&transaction, "commit")?.is_some();
        if committed && read_file(&transaction, "commit")? != b"commit\n" { return Err(fail("io", "Invalid deletion commit marker")); }
        let (parent, original) = parent_and_name(root, &journal.source)?;
        let stage_name = stage_name(token);
        let stage = match open_directory(&parent, &stage_name) {
            Ok(dir) => Some(dir),
            Err(_) if stat(&parent, &stage_name)?.is_none() => None,
            Err(e) => return Err(e),
        };
        if let Some(stage) = stage {
            if let Some(staged) = stat(&stage, "session")? {
                if committed {
                    if !matches_expected(&staged, journal) {
                        return Err(fail("busy", "Staged session changed; deletion recovery stopped"));
                    }
                    unlink(&stage, "session", 0)?;
                    stage.sync_all().map_err(io)?;
                } else {
                    // Never overwrite a newly created source, even if the isolated
                    // file is not the one the original scan authorized.
                    rename_no_replace(&stage, "session", &parent, &original)
                        .map_err(|_| fail("busy", "Deletion recovery cannot restore without replacing a file"))?;
                    stage.sync_all().map_err(io)?;
                    parent.sync_all().map_err(io)?;
                }
            } else if committed {
                // Already removed after the commit marker.
            } else if !original_is_expected(&parent, &original, journal)? {
                return Err(fail("busy", "Deletion recovery cannot verify the original session"));
            }
            unlink(&parent, &stage_name, libc::AT_REMOVEDIR)?;
            parent.sync_all().map_err(io)?;
        } else if !committed && !original_is_expected(&parent, &original, journal)? {
            return Err(fail("busy", "Deletion recovery cannot verify the original session"));
        }
        // A renamed completed tombstone makes cleanup itself restartable:
        // recovery never has to infer the outcome from partially removed files.
        let done = format!("{token}.done");
        rename_no_replace(&journal_root, token, &journal_root, &done)?;
        journal_root.sync_all().map_err(io)?;
        cleanup_done(&journal_root, &done)
    }
    fn cleanup_done(journal_root: &File, name: &str) -> Result<(), Failure> {
        let transaction = open_directory(journal_root, name)?;
        for entry in std::fs::read_dir(format!("/proc/self/fd/{}", transaction.as_raw_fd())).map_err(io)? {
            let entry = entry.map_err(io)?;
            let name = entry.file_name().into_string().map_err(|_| fail("io", "Invalid deletion tombstone entry"))?;
            if !matches!(name.as_str(), "journal" | "commit") || !entry.file_type().map_err(io)?.is_file() {
                return Err(fail("io", "Invalid deletion tombstone entry"));
            }
            unlink(&transaction, &name, 0)?;
        }
        transaction.sync_all().map_err(io)?;
        unlink(journal_root, name, libc::AT_REMOVEDIR)?;
        journal_root.sync_all().map_err(io)?;
        Ok(())
    }

    pub(crate) fn recover(state: &crate::pi_ipc::IpcHostState, root: &Path) -> Result<(), Failure> {
        let agent = state.agent_dir();
        let path = agent.join("session-deletion-journal");
        let journal_root = match open_dir_path(&path) {
            Ok(root) => root,
            Err(_) if matches!(std::fs::symlink_metadata(&path), Err(ref e) if e.kind() == std::io::ErrorKind::NotFound) => return Ok(()),
            Err(error) => return Err(error),
        };
        let mut entries = std::fs::read_dir(format!("/proc/self/fd/{}", journal_root.as_raw_fd())).map_err(io)?;
        let Some(first) = entries.next() else { return Ok(()); };
        if !state.deletion_recovery_permitted() {
            return Err(fail("busy", "Session deletion recovery is pending exclusive maintenance"));
        }
        enum Pending { Preparation(String, bool), Done(String), Active(String, Journal) }
        let mut pending = Vec::new();
        let mut ids = Vec::new();
        for entry in std::iter::once(first).chain(entries) {
            let entry = entry.map_err(io)?;
            let token = entry.file_name().into_string().map_err(|_| fail("io", "Invalid deletion journal name"))?;
            if !entry.file_type().map_err(io)?.is_dir() { return Err(fail("io", "Invalid deletion journal entry")); }
            let (id, kind) = if let Some(id) = token.strip_prefix(".prepare-") { (id, 0) }
                else if let Some(id) = token.strip_suffix(".done") { (id, 1) }
                else { (token.as_str(), 2) };
            if !valid_token(id) { return Err(fail("io", "Invalid deletion journal name")); }
            let transaction = open_directory(&journal_root, &token)?;
            let mut has_journal = false;
            let mut has_commit = false;
            for child in std::fs::read_dir(format!("/proc/self/fd/{}", transaction.as_raw_fd())).map_err(io)? {
                let child = child.map_err(io)?;
                let name = child.file_name().into_string().map_err(|_| fail("io", "Invalid deletion journal entry"))?;
                if !child.file_type().map_err(io)?.is_file() { return Err(fail("io", "Invalid deletion journal entry")); }
                match name.as_str() {
                    "journal" => has_journal = true,
                    "commit" if kind != 0 => has_commit = true,
                    _ => return Err(fail("io", "Invalid deletion journal entry")),
                }
            }
            if has_commit && read_file(&transaction, "commit")? != b"commit\n" { return Err(fail("io", "Invalid deletion commit marker")); }
            let journal = if has_journal {
                let journal: Journal = serde_json::from_slice(&read_file(&transaction, "journal")?).map_err(io)?;
                verify_journal(&journal, id)?;
                parent_and_name(root, &journal.source)?;
                ids.push(journal.session.clone());
                Some(journal)
            } else { None };
            match kind {
                0 => pending.push(Pending::Preparation(token, has_journal)),
                1 => pending.push(Pending::Done(token)),
                _ => pending.push(Pending::Active(token, journal.ok_or_else(|| fail("io", "Missing deletion journal"))?)),
            }
        }
        state.registry.with_idle_session_writers(&ids, |_| {
            if ids.iter().any(|id| state.registry.get(id).is_some()) {
                return Err(fail("busy", "Session is active during deletion recovery"));
            }
            for item in pending {
                match item {
                    Pending::Preparation(token, has_journal) => {
                        let preparation = open_directory(&journal_root, &token)?;
                        if has_journal { unlink(&preparation, "journal", 0)?; preparation.sync_all().map_err(io)?; }
                        unlink(&journal_root, &token, libc::AT_REMOVEDIR)?;
                        journal_root.sync_all().map_err(io)?;
                    }
                    Pending::Done(token) => cleanup_done(&journal_root, &token)?,
                    Pending::Active(token, journal) => finish(&agent, root, &token, &journal)?,
                }
            }
            Ok(())
        }).map_err(|error| match error {
            session_host::SessionWriterError::Busy(message) => fail("busy", message),
            session_host::SessionWriterError::Operation(error) => error,
        })
    }

    pub(crate) fn remove(root: &Path, agent: &Path, session: &str, target: &Path, expected: &std::fs::Metadata) -> Result<(), Failure> {
        remove_with_hook(root, agent, session, target, expected, |_| Ok(()))
    }
    fn remove_with_hook(root: &Path, agent: &Path, session: &str, target: &Path, expected: &std::fs::Metadata, hook: impl Fn(&str) -> Result<(), Failure>) -> Result<(), Failure> {
        let relative = target.strip_prefix(root).map_err(io)?.to_str().ok_or_else(|| fail("io", "Invalid session path encoding"))?.to_string();
        let (parent, original) = parent_and_name(root, &relative)?;
        let mut random = [0u8; 16]; getrandom::fill(&mut random).map_err(io)?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let journal_root = journal_dir(agent)?;
        let preparation = format!(".prepare-{token}");
        if unsafe { libc::mkdirat(journal_root.as_raw_fd(), c(&preparation)?.as_ptr(), 0o700) } != 0 { return Err(io(std::io::Error::last_os_error())); }
        journal_root.sync_all().map_err(io)?;
        let transaction = open_directory(&journal_root, &preparation)?;
        let journal = Journal { version: 1, session: session.to_string(), source: relative, device: expected.dev(), inode: expected.ino(), size: expected.size(), mtime: expected.mtime(), mtime_nsec: expected.mtime_nsec() };
        create_file(&transaction, "journal", &serde_json::to_vec(&journal).map_err(io)?)?;
        transaction.sync_all().map_err(io)?;
        rename_no_replace(&journal_root, &preparation, &journal_root, &token)?;
        journal_root.sync_all().map_err(io)?;
        hook("prepared")?;
        let stage_name = stage_name(&token);
        if unsafe { libc::mkdirat(parent.as_raw_fd(), c(&stage_name)?.as_ptr(), 0o700) } != 0 { return Err(io(std::io::Error::last_os_error())); }
        parent.sync_all().map_err(io)?;
        let stage = open_directory(&parent, &stage_name)?;
        rename_no_replace(&parent, &original, &stage, "session")?;
        parent.sync_all().map_err(io)?;
        stage.sync_all().map_err(io)?;
        hook("isolated")?;
        let staged = stat(&stage, "session")?.ok_or_else(|| fail("busy", "Isolated session disappeared"))?;
        if !matches_expected(&staged, &journal) {
            finish(agent, root, &token, &journal)?;
            return Err(fail("busy", "Session file changed during deletion"));
        }
        create_file(&transaction, "commit", b"commit\n")?;
        transaction.sync_all().map_err(io)?;
        hook("committed")?;
        finish(agent, root, &token, &journal)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;
        fn fixture() -> (tempfile::TempDir, crate::pi_ipc::IpcHostState, std::path::PathBuf, std::path::PathBuf) {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("sessions");
            std::fs::create_dir_all(root.join("p")).unwrap();
            let source = root.join("p/a.jsonl");
            std::fs::write(&source, format!("{}\n", json!({"type":"session","id":"a"}))).unwrap();
            let state = crate::pi_ipc::IpcHostState::new();
            *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
            state.deletion_recovery_exclusive.store(true, std::sync::atomic::Ordering::SeqCst);
            (dir, state, root, source)
        }
        #[test]
        fn process_crash_requires_explicit_fixture_lock_recovery() {
            if let Ok(agent) = std::env::var("PI_TEST_DELETION_CRASH_AGENT") {
                let agent = std::path::PathBuf::from(agent);
                let root = agent.join("sessions");
                let source = root.join("p/a.jsonl");
                let metadata = std::fs::metadata(&source).unwrap();
                let _guard = task_scheduler::transaction_lock::TransactionLock::acquire(&agent).unwrap();
                let phase = std::env::var("PI_TEST_DELETION_CRASH_PHASE").unwrap();
                let _ = remove_with_hook(&root, &agent, "a", &source, &metadata, |at| {
                    if at == phase { std::process::exit(73); }
                    Ok(())
                });
                panic!("fixture phase not reached");
            }
            for phase in ["isolated", "committed"] {
                let (dir, state, root, source) = fixture();
                let status = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "session_deletion_journal::linux::tests::process_crash_requires_explicit_fixture_lock_recovery"])
                    .env("PI_TEST_DELETION_CRASH_AGENT", dir.path())
                    .env("PI_TEST_DELETION_CRASH_PHASE", phase)
                    .status().unwrap();
                assert_eq!(status.code(), Some(73));
                let gate = dir.path().join("scheduled-tasks/transaction.lock");
                assert!(gate.is_dir());
                // The child has been reaped and this temporary agent is ours;
                // production must never infer safe unlock from time or PID.
                std::fs::remove_file(gate.join("owner")).unwrap();
                std::fs::remove_dir(&gate).unwrap();
                let _exclusive = task_scheduler::transaction_lock::TransactionLock::acquire(dir.path()).unwrap();
                recover(&state, &root).unwrap();
                assert_eq!(source.exists(), phase != "committed");
            }
        }
        #[test]
        fn restart_recovers_each_durable_phase() {
            for phase in ["prepared", "isolated", "committed"] {
                let (dir, state, root, source) = fixture();
                let metadata = std::fs::metadata(&source).unwrap();
                assert!(remove_with_hook(&root, dir.path(), "a", &source, &metadata, |at| if at == phase { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
                recover(&state, &root).unwrap();
                assert_eq!(source.exists(), phase != "committed", "{phase}");
                recover(&state, &root).unwrap();
            }
        }
        #[test]
        fn pending_journal_requires_explicit_isolated_maintenance() {
            let (dir, state, root, source) = fixture();
            let metadata = std::fs::metadata(&source).unwrap();
            assert!(remove_with_hook(&root, dir.path(), "a", &source, &metadata, |at| if at == "isolated" { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
            state.deletion_recovery_exclusive.store(false, std::sync::atomic::Ordering::SeqCst);
            for op in ["sessions.index", "sessions.list", "sessions.search", "sessions.delete"] {
                let args = match op { "sessions.search" => json!({"query":"x"}), "sessions.delete" => json!({"session":"a"}), _ => json!({}) };
                let response = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"test","op":op,"args":args}));
                assert_eq!(response["error"]["code"], "busy", "{op}: {response}");
                assert!(response["error"]["message"].as_str().unwrap().contains("exclusive maintenance"));
                assert!(!source.exists());
            }
            state.deletion_recovery_exclusive.store(true, std::sync::atomic::Ordering::SeqCst);
            let _policy = state.policy_gate.try_read().unwrap();
            let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(dir.path()).unwrap();
            recover(&state, &root).unwrap();
            assert!(source.exists());
        }
        #[test]
        fn isolated_maintenance_still_respects_persistent_session_fence() {
            let (dir, state, root, source) = fixture();
            let metadata = std::fs::metadata(&source).unwrap();
            assert!(remove_with_hook(&root, dir.path(), "a", &source, &metadata, |at| if at == "isolated" { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
            crate::session_writer_fence::begin(dir.path(), "a", "op", "chat", &source, None).unwrap();
            let _policy = state.policy_gate.try_read().unwrap();
            let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(dir.path()).unwrap();
            assert_eq!(recover(&state, &root).unwrap_err().0, "busy");
            assert!(!source.exists());
            assert!(crate::session_writer_fence::fence_path(dir.path(), "a").exists());
            crate::session_writer_fence::finish(dir.path(), "a", "op").unwrap();
            recover(&state, &root).unwrap();
            assert!(source.exists());
        }
        #[test]
        fn catalogue_recovers_before_scanning_an_isolated_session() {
            let (dir, state, root, source) = fixture();
            let metadata = std::fs::metadata(&source).unwrap();
            assert!(remove_with_hook(&root, dir.path(), "a", &source, &metadata, |at| if at == "isolated" { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
            assert!(!source.exists());
            let response = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"list","op":"sessions.list","args":{}}));
            assert_eq!(response["ok"], true, "{response}");
            assert!(source.exists());
        }
        #[test]
        fn search_recovers_before_taking_its_snapshot() {
            let (dir, state, root, source) = fixture();
            let metadata = std::fs::metadata(&source).unwrap();
            assert!(remove_with_hook(&root, dir.path(), "a", &source, &metadata, |at| if at == "isolated" { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
            assert!(!source.exists());
            // No management host is configured: the later IPC error is
            // expected, but recovery must occur before that call.
            let response = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"search","op":"sessions.search","args":{"query":"needle"}}));
            assert_eq!(response["ok"], false, "{response}");
            assert!(source.exists());
        }
        #[test]
        fn recovery_never_replaces_new_source() {
            let (dir, state, root, source) = fixture();
            let metadata = std::fs::metadata(&source).unwrap();
            assert!(remove_with_hook(&root, dir.path(), "a", &source, &metadata, |at| if at == "isolated" { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
            std::fs::write(&source, "new user file").unwrap();
            assert_eq!(recover(&state, &root).unwrap_err().0, "busy");
            assert_eq!(std::fs::read_to_string(&source).unwrap(), "new user file");
        }
        #[test]
        fn committed_recovery_preserves_new_source() {
            let (dir, state, root, source) = fixture();
            let metadata = std::fs::metadata(&source).unwrap();
            assert!(remove_with_hook(&root, dir.path(), "a", &source, &metadata, |at| if at == "committed" { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
            std::fs::write(&source, "new user file").unwrap();
            recover(&state, &root).unwrap();
            assert_eq!(std::fs::read_to_string(&source).unwrap(), "new user file");
        }
        #[test]
        fn empty_preparation_is_recovered_but_corrupt_preparation_fails_closed() {
            let (dir, state, root, source) = fixture();
            let preparation = dir.path().join("session-deletion-journal/.prepare-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            std::fs::create_dir_all(&preparation).unwrap();
            recover(&state, &root).unwrap();
            assert!(!preparation.exists());
            std::fs::create_dir(&preparation).unwrap();
            std::fs::write(preparation.join("journal"), "{broken").unwrap();
            assert_eq!(recover(&state, &root).unwrap_err().0, "io");
            assert!(source.exists());
        }
        #[test]
        fn corrupt_second_journal_prevents_any_recovery_mutation() {
            let (dir, state, root, source) = fixture();
            let metadata = std::fs::metadata(&source).unwrap();
            assert!(remove_with_hook(&root, dir.path(), "a", &source, &metadata, |at| if at == "isolated" { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
            let bad = dir.path().join("session-deletion-journal/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            std::fs::create_dir(&bad).unwrap();
            std::fs::write(bad.join("journal"), "{broken").unwrap();
            assert_eq!(recover(&state, &root).unwrap_err().0, "io");
            assert!(!source.exists());
            std::fs::remove_file(bad.join("journal")).unwrap();
            std::fs::remove_dir(bad).unwrap();
            recover(&state, &root).unwrap();
            assert!(source.exists());
        }
        #[test]
        fn malformed_journal_fails_closed() {
            let (dir, state, root, source) = fixture();
            let journal = dir.path().join("session-deletion-journal").join("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            std::fs::create_dir_all(&journal).unwrap();
            std::fs::write(journal.join("journal"), "{broken").unwrap();
            assert_eq!(recover(&state, &root).unwrap_err().0, "io");
            assert!(source.exists());
        }
        #[test]
        fn replacement_between_preflight_and_isolation_is_not_deleted() {
            let (dir, _state, root, source) = fixture();
            let handle = File::open(&source).unwrap();
            let metadata = handle.metadata().unwrap();
            let result = remove_with_hook(&root, dir.path(), "a", &source, &metadata, |phase| {
                if phase == "prepared" {
                    std::fs::rename(&source, source.with_extension("saved")).unwrap();
                    std::fs::write(&source, "replacement").unwrap();
                }
                Ok(())
            });
            assert_eq!(result.unwrap_err().0, "busy");
            assert_eq!(std::fs::read_to_string(&source).unwrap(), "replacement");
            assert!(source.with_extension("saved").exists());
        }
        #[test]
        fn replacement_after_isolation_is_not_deleted() {
            let (dir, _state, root, source) = fixture();
            let handle = File::open(&source).unwrap();
            let metadata = handle.metadata().unwrap();
            remove_with_hook(&root, dir.path(), "a", &source, &metadata, |phase| {
                if phase == "isolated" { std::fs::write(&source, "replacement").unwrap(); }
                Ok(())
            }).unwrap();
            assert_eq!(std::fs::read_to_string(&source).unwrap(), "replacement");
        }
        #[test]
        fn changed_source_is_restored_not_deleted() {
            let (dir, _state, root, source) = fixture();
            let metadata = std::fs::metadata(&source).unwrap();
            std::fs::rename(&source, source.with_extension("saved")).unwrap();
            std::fs::write(&source, "replacement").unwrap();
            assert_eq!(remove(&root, dir.path(), "a", &source, &metadata).unwrap_err().0, "busy");
            assert_eq!(std::fs::read_to_string(&source).unwrap(), "replacement");
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) use linux::{recover, remove};

#[cfg(not(target_os = "linux"))]
pub(crate) fn recover(state: &crate::pi_ipc::IpcHostState, _root: &std::path::Path) -> Result<(), (String, String)> {
    let path = state.agent_dir().join("session-deletion-journal");
    match std::fs::read_dir(path) {
        Ok(mut entries) => match entries.next() {
            None => Ok(()),
            Some(_) => Err(("not_supported".into(), "Pending session deletion recovery is unavailable on this platform.".into())),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(("io".into(), error.to_string())),
    }
}
#[cfg(not(target_os = "linux"))]
pub(crate) fn remove(_root: &std::path::Path, _agent: &std::path::Path, _session: &str, _target: &std::path::Path, _expected: &std::fs::Metadata) -> Result<(), (String, String)> {
    Err(("not_supported".into(), "Safe session deletion is unavailable on this platform.".into()))
}
