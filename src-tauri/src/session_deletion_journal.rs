//! Recoverable isolation of one session file. Caller holds the scheduler gate
//! and the session writer gate; paths come only from the host session scan.

pub(crate) fn has_pending(agent: &std::path::Path) -> Result<bool, (String, String)> {
    let path = agent.join("session-deletion-journal");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(("io".into(), error.to_string())),
        Ok(metadata) if !metadata.file_type().is_dir() => Err(("io".into(), "Unsafe session deletion journal directory".into())),
        Ok(_) => {
            #[cfg(target_os = "linux")]
            let mut entries = {
                use std::os::fd::AsRawFd;
                use std::os::unix::fs::OpenOptionsExt;
                let directory = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                    .open(&path).map_err(|error| ("io".into(), error.to_string()))?;
                std::fs::read_dir(format!("/proc/self/fd/{}", directory.as_raw_fd())).map_err(|error| ("io".into(), error.to_string()))?
            };
            #[cfg(not(target_os = "linux"))]
            let mut entries = std::fs::read_dir(path).map_err(|error| ("io".into(), error.to_string()))?;
            match entries.next() { None => Ok(false), Some(Ok(_)) => Ok(true), Some(Err(error)) => Err(("io".into(), error.to_string())) }
        }
    }
}
pub(crate) fn recover_pending(state: &crate::pi_ipc::IpcHostState, agent: &std::path::Path) -> Result<(), (String, String)> {
    if !has_pending(agent)? { return Ok(()); }
    if !state.deletion_recovery_permitted() {
        return Err(("busy".into(), "Session deletion recovery is pending exclusive maintenance".into()));
    }
    let root = agent.join("sessions").canonicalize().map_err(|error| ("io".into(), error.to_string()))?;
    recover(state, &root)
}

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

    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct GroupItem {
        session: String, source: String, device: u64, inode: u64, size: u64, mtime: i64, mtime_nsec: i64,
        replacement_header: Option<String>, marker_parent: Option<(String, String)>,
    }
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct GroupJournal { version: u8, items: Vec<GroupItem>, #[serde(default)] trash: Option<TrashJournal> }
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct TrashJournal { folder: String, original_path: String, device: u64, inode: u64, kind: String, root: String, destination: String, info: Option<String> }
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct FileVersion { device: u64, inode: u64, size: u64, mtime: i64, mtime_nsec: i64 }
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct GroupReady { replacements: Vec<Option<FileVersion>>, #[serde(default)] trash_info: Option<FileVersion> }

    pub(crate) struct GroupTrash {
        pub folder: std::path::PathBuf,
        pub handle: File,
        pub metadata: std::fs::Metadata,
        pub kind: String,
        pub root: std::path::PathBuf,
    }

    pub(crate) struct GroupMutation {
        pub session: String,
        pub path: std::path::PathBuf,
        pub handle: File,
        pub metadata: std::fs::Metadata,
        pub replacement_header: Option<String>,
        pub marker_parent: Option<(String, String)>,
    }

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
        let mut bytes = Vec::new(); file.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(io)?;
        if bytes.len() > 4 * 1024 * 1024 { return Err(fail("io", "Deletion journal too large")); }
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
    fn group_stage_name(token: &str, index: usize) -> String { format!(".pi-deletion-{token}-{index}") }
    fn version_from_stat(value: &libc::stat) -> FileVersion {
        FileVersion { device: value.st_dev as u64, inode: value.st_ino as u64, size: value.st_size as u64, mtime: value.st_mtime, mtime_nsec: value.st_mtime_nsec }
    }
    fn matches_version(value: &libc::stat, expected: &FileVersion) -> bool {
        value.st_mode & libc::S_IFMT == libc::S_IFREG && value.st_dev as u64 == expected.device && value.st_ino as u64 == expected.inode
            && value.st_size as u64 == expected.size && value.st_mtime == expected.mtime && value.st_mtime_nsec == expected.mtime_nsec
    }
    fn item_version(item: &GroupItem) -> FileVersion {
        FileVersion { device: item.device, inode: item.inode, size: item.size, mtime: item.mtime, mtime_nsec: item.mtime_nsec }
    }
    fn system_trash_path() -> Result<std::path::PathBuf, Failure> {
        let base = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()).map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("PI_AGENT_HOME").filter(|value| !value.is_empty()).or_else(|| std::env::var_os("HOME")).map(|home| std::path::PathBuf::from(home).join(".local/share")))
            .ok_or_else(|| fail("io", "Cannot resolve the system Trash directory"))?;
        if !base.is_absolute() { return Err(fail("io", "System Trash path must be absolute")); }
        Ok(base.join("Trash"))
    }
    fn expected_trash_root(agent: &Path, kind: &str) -> Result<std::path::PathBuf, Failure> {
        match kind {
            "system" => system_trash_path(),
            "app" => Ok(agent.join("chats-trash")),
            _ => Err(fail("io", "Invalid deletion Trash kind")),
        }
    }
    fn uri_encode(path: &str) -> String {
        let mut result = String::new();
        for byte in path.bytes() {
            if byte.is_ascii_alphanumeric() || b";/?:@&=+$,#-_.!~*'()".contains(&byte) { result.push(byte as char); }
            else { result.push_str(&format!("%{byte:02X}")); }
        }
        result
    }
    fn verify_trash(agent: &Path, token: &str, trash: &TrashJournal) -> Result<(), Failure> {
        if trash.folder.is_empty() || Path::new(&trash.folder).components().count() != 1
            || !matches!(Path::new(&trash.folder).components().next(), Some(Component::Normal(_)))
            || !(trash.destination == trash.folder || trash.destination == format!("{}-{token}", trash.folder)) {
            return Err(fail("io", "Invalid deletion Trash path"));
        }
        let expected = expected_trash_root(agent, &trash.kind)?.canonicalize().map_err(io)?;
        if expected != Path::new(&trash.root) { return Err(fail("io", "Deletion Trash root changed")); }
        let chats = agent.join("chats").canonicalize().map_err(io)?;
        let original = Path::new(&trash.original_path);
        if !original.is_absolute() || original.file_name().and_then(|name| name.to_str()) != Some(trash.folder.as_str())
            || original.parent().and_then(|parent| parent.canonicalize().ok()).as_deref() != Some(chats.as_path()) {
            return Err(fail("io", "Invalid original chat folder path"));
        }
        if trash.kind == "system" {
            let prefix = format!("[Trash Info]\nPath={}\nDeletionDate=", uri_encode(&trash.original_path));
            let info = trash.info.as_deref().ok_or_else(|| fail("io", "Missing Trash information"))?;
            let date = info.strip_prefix(&prefix).and_then(|s| s.strip_suffix('\n')).ok_or_else(|| fail("io", "Invalid Trash information"))?;
            if date.len() != 19 || !date.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'-' | b':' | b'T')) { return Err(fail("io", "Invalid Trash deletion date")); }
        } else if trash.info.is_some() { return Err(fail("io", "Unexpected application Trash information")); }
        Ok(())
    }
    pub(crate) fn prepare_trash(agent: &Path, folder: &Path, prefer_app: bool) -> Result<GroupTrash, Failure> {
        let chats_path = agent.join("chats").canonicalize().map_err(io)?;
        let name = folder.file_name().and_then(|name| name.to_str()).ok_or_else(|| fail("io", "Invalid chat folder name"))?;
        if folder.parent().and_then(|parent| parent.canonicalize().ok()).as_deref() != Some(chats_path.as_path()) {
            return Err(fail("access_denied", "Chat folder is outside the chat root"));
        }
        let chats = open_dir_path(&chats_path)?;
        let handle = open_directory(&chats, name)?;
        let metadata = handle.metadata().map_err(io)?;
        let candidates = if prefer_app { vec!["app"] } else { vec!["system", "app"] };
        let mut last = None;
        for kind in candidates {
            let candidate = (|| {
                let path = expected_trash_root(agent, kind)?;
                std::fs::create_dir_all(&path).map_err(io)?;
                let original_root = open_dir_path(&path)?;
                if kind == "system" {
                    for name in ["files", "info"] {
                        if unsafe { libc::mkdirat(original_root.as_raw_fd(), c(name)?.as_ptr(), 0o700) } != 0 {
                            let error = std::io::Error::last_os_error();
                            if error.kind() != std::io::ErrorKind::AlreadyExists { return Err(io(error)); }
                        }
                        open_directory(&original_root, name)?;
                    }
                }
                let root = path.canonicalize().map_err(io)?;
                let canonical_root = open_dir_path(&root)?;
                let original_meta = original_root.metadata().map_err(io)?;
                let canonical_meta = canonical_root.metadata().map_err(io)?;
                if original_meta.dev() != canonical_meta.dev() || original_meta.ino() != canonical_meta.ino() {
                    return Err(fail("busy", "Trash root changed during authorization"));
                }
                let files = if kind == "system" { open_dir_path(&root.join("files"))? } else { canonical_root };
                if files.metadata().map_err(io)?.dev() != metadata.dev() { return Err(fail("io", "Trash is on a different filesystem")); }
                if kind == "system" { open_dir_path(&root.join("info"))?; }
                Ok(GroupTrash { folder: folder.to_path_buf(), handle: handle.try_clone().map_err(io)?, metadata: metadata.clone(), kind: kind.to_string(), root })
            })();
            match candidate { Ok(trash) => return Ok(trash), Err(error) => last = Some(error) }
        }
        Err(last.unwrap_or_else(|| fail("io", "Cannot prepare Trash")))
    }
    fn trash_files(root: &Path, kind: &str) -> Result<File, Failure> {
        if kind == "system" { open_dir_path(&root.join("files")) } else { open_dir_path(root) }
    }
    fn trash_info(root: &Path) -> Result<File, Failure> { open_dir_path(&root.join("info")) }
    fn verify_group(agent: &Path, root: &Path, token: &str, group: &GroupJournal) -> Result<(), Failure> {
        use std::collections::HashSet;
        if !valid_token(token) || group.version != 2 || group.items.is_empty() { return Err(fail("io", "Invalid deletion group journal")); }
        let mut paths = HashSet::new(); let mut ids = HashSet::new();
        for item in &group.items {
            if item.session.is_empty() || !ids.insert(&item.session) || !paths.insert(&item.source)
                || (item.marker_parent.is_some() && item.replacement_header.is_none()) {
                return Err(fail("io", "Invalid deletion group member"));
            }
            if let Some(header) = &item.replacement_header {
                let value: serde_json::Value = serde_json::from_str(header).map_err(io)?;
                if value.get("type").and_then(serde_json::Value::as_str) != Some("session") || value.get("id").and_then(serde_json::Value::as_str) != Some(item.session.as_str()) {
                    return Err(fail("io", "Invalid deletion replacement header"));
                }
            }
            parent_and_name(root, &item.source)?;
        }
        if let Some(trash) = &group.trash { verify_trash(agent, token, trash)?; }
        Ok(())
    }
    fn copy_xattrs(input: &File, output: &File) -> Result<(), Failure> {
        let count = unsafe { libc::flistxattr(input.as_raw_fd(), std::ptr::null_mut(), 0) };
        if count < 0 { return Err(io(std::io::Error::last_os_error())); }
        if count as usize > 1024 * 1024 { return Err(fail("io", "Session extended attributes exceed the rewrite budget")); }
        let mut names = vec![0u8; count as usize];
        if count > 0 {
            let read = unsafe { libc::flistxattr(input.as_raw_fd(), names.as_mut_ptr().cast(), names.len()) };
            if read != count { return Err(fail("busy", "Session extended attributes changed during rewrite")); }
        }
        let mut total = names.len();
        for name in names.split(|byte| *byte == 0).filter(|name| !name.is_empty()) {
            let name = CString::new(name).map_err(io)?;
            let length = unsafe { libc::fgetxattr(input.as_raw_fd(), name.as_ptr(), std::ptr::null_mut(), 0) };
            if length < 0 { return Err(io(std::io::Error::last_os_error())); }
            total = total.saturating_add(length as usize);
            if total > 4 * 1024 * 1024 { return Err(fail("io", "Session extended attributes exceed the rewrite budget")); }
            let mut value = vec![0u8; length as usize];
            let read = unsafe { libc::fgetxattr(input.as_raw_fd(), name.as_ptr(), value.as_mut_ptr().cast(), value.len()) };
            if read != length { return Err(fail("busy", "Session extended attributes changed during rewrite")); }
            if unsafe { libc::fsetxattr(output.as_raw_fd(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0) } != 0 {
                return Err(io(std::io::Error::last_os_error()));
            }
        }
        Ok(())
    }
    fn make_replacement(stage: &File, item: &GroupItem) -> Result<FileVersion, Failure> {
        use std::io::BufRead;
        let fd = unsafe { libc::openat(stage.as_raw_fd(), c("original")?.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(io(std::io::Error::last_os_error())); }
        let input = unsafe { File::from_raw_fd(fd) };
        let original_metadata = input.metadata().map_err(io)?;
        let mode = original_metadata.mode() & 0o7777;
        let fd = unsafe { libc::openat(stage.as_raw_fd(), c("replacement")?.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, mode) };
        if fd < 0 { return Err(io(std::io::Error::last_os_error())); }
        let mut output = unsafe { File::from_raw_fd(fd) };
        if unsafe { libc::fchown(output.as_raw_fd(), original_metadata.uid(), original_metadata.gid()) } != 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        if unsafe { libc::fchmod(output.as_raw_fd(), mode) } != 0 { return Err(io(std::io::Error::last_os_error())); }
        copy_xattrs(&input, &output)?;
        if output.metadata().map_err(io)?.mode() & 0o7777 != mode { return Err(fail("io", "Cannot preserve session permissions")); }
        let mut reader = std::io::BufReader::new(input);
        let mut line = Vec::new(); reader.by_ref().take(65537).read_until(b'\n', &mut line).map_err(io)?;
        if line.is_empty() || line.len() > 65536 { return Err(fail("io", "Invalid session header while staging rewrite")); }
        output.write_all(item.replacement_header.as_ref().ok_or_else(|| fail("io", "Missing replacement header"))?.as_bytes()).map_err(io)?;
        if line.ends_with(b"\n") { output.write_all(b"\n").map_err(io)?; }
        if let Some((parent_id, parent_path)) = &item.marker_parent {
            loop {
                line.clear(); reader.by_ref().take(16 * 1024 * 1024 + 1).read_until(b'\n', &mut line).map_err(io)?;
                if line.is_empty() { break; }
                if line.len() > 16 * 1024 * 1024 { return Err(fail("io", "Oversized session entry while staging rewrite")); }
                let mut value: serde_json::Value = serde_json::from_slice(&line).map_err(io)?;
                if value.get("type").and_then(serde_json::Value::as_str) == Some("custom") && value.get("customType").and_then(serde_json::Value::as_str) == Some("pi-web:subagent") {
                    let data = value.get_mut("data").and_then(serde_json::Value::as_object_mut).ok_or_else(|| fail("io", "Invalid subagent metadata"))?;
                    data.insert("parentSessionId".into(), serde_json::json!(parent_id));
                    data.insert("parentSessionPath".into(), serde_json::json!(parent_path));
                    output.write_all(serde_json::to_string(&value).map_err(io)?.as_bytes()).map_err(io)?;
                    if line.ends_with(b"\n") { output.write_all(b"\n").map_err(io)?; }
                    break;
                }
                output.write_all(&line).map_err(io)?;
            }
        }
        std::io::copy(&mut reader, &mut output).map_err(io)?;
        let after = reader.get_ref().metadata().map_err(io)?;
        if after.dev() != original_metadata.dev() || after.ino() != original_metadata.ino() || after.len() != original_metadata.len()
            || after.mtime() != original_metadata.mtime() || after.mtime_nsec() != original_metadata.mtime_nsec()
            || after.ctime() != original_metadata.ctime() || after.ctime_nsec() != original_metadata.ctime_nsec() {
            return Err(fail("busy", "Session changed during staged rewrite"));
        }
        output.sync_all().map_err(io)?;
        let value = stat(stage, "replacement")?.ok_or_else(|| fail("io", "Staged replacement disappeared"))?;
        Ok(version_from_stat(&value))
    }
    fn matches_directory(value: &libc::stat, trash: &TrashJournal) -> bool {
        value.st_mode & libc::S_IFMT == libc::S_IFDIR && value.st_dev as u64 == trash.device && value.st_ino as u64 == trash.inode
    }
    fn finish_trash(agent: &Path, token: &str, trash: &TrashJournal, ready: Option<&GroupReady>, committed: bool) -> Result<(), Failure> {
        verify_trash(agent, token, trash)?;
        let chats_path = agent.join("chats").canonicalize().map_err(io)?;
        let chats = open_dir_path(&chats_path)?;
        let staged_name = format!(".pi-deletion-{token}-chat");
        let staged = stat(&chats, &staged_name)?;
        if !committed {
            if staged.is_some() {
                rename_no_replace(&chats, &staged_name, &chats, &trash.folder)
                    .map_err(|_| fail("busy", "Chat folder recovery cannot replace a new folder"))?;
                chats.sync_all().map_err(io)?;
            } else if !stat(&chats, &trash.folder)?.is_some_and(|value| matches_directory(&value, trash)) {
                return Err(fail("busy", "Chat folder recovery cannot verify the original folder"));
            }
        }
        let root = Path::new(&trash.root);
        if trash.kind == "system" {
            let info_root = trash_info(root)?;
            let info_stage_name = format!(".pi-deletion-{token}-info");
            let stage = match open_directory(&info_root, &info_stage_name) {
                Ok(stage) => Some(stage),
                Err(_) if stat(&info_root, &info_stage_name)?.is_none() => None,
                Err(error) => return Err(error),
            };
            let info_name = format!("{}.trashinfo", trash.destination);
            let info_text = trash.info.as_deref().ok_or_else(|| fail("io", "Missing Trash information"))?;
            if let Some(stage) = stage {
                if let Some(staged_info) = stat(&stage, "info")? {
                    if committed {
                        let expected = ready.and_then(|ready| ready.trash_info.as_ref()).ok_or_else(|| fail("io", "Missing Trash readiness"))?;
                        if !matches_version(&staged_info, expected) { return Err(fail("busy", "Staged Trash information changed")); }
                        rename_no_replace(&stage, "info", &info_root, &info_name)
                            .map_err(|_| fail("busy", "Trash information destination already exists"))?;
                        info_root.sync_all().map_err(io)?;
                    } else {
                        if read_file(&stage, "info")? != info_text.as_bytes() { return Err(fail("busy", "Staged Trash information changed")); }
                        unlink(&stage, "info", 0)?;
                    }
                    stage.sync_all().map_err(io)?;
                } else if committed {
                    let expected = ready.and_then(|ready| ready.trash_info.as_ref()).ok_or_else(|| fail("io", "Missing Trash readiness"))?;
                    if !stat(&info_root, &info_name)?.is_some_and(|value| matches_version(&value, expected)) {
                        return Err(fail("busy", "Published Trash information changed"));
                    }
                }
                unlink(&info_root, &info_stage_name, libc::AT_REMOVEDIR)?;
                info_root.sync_all().map_err(io)?;
            } else if committed {
                let expected = ready.and_then(|ready| ready.trash_info.as_ref()).ok_or_else(|| fail("io", "Missing Trash readiness"))?;
                if !stat(&info_root, &info_name)?.is_some_and(|value| matches_version(&value, expected)) {
                    return Err(fail("busy", "Published Trash information changed"));
                }
            }
        }
        if committed {
            let files = trash_files(root, &trash.kind)?;
            if let Some(staged) = staged {
                if !matches_directory(&staged, trash) { return Err(fail("busy", "Staged chat folder changed")); }
                rename_no_replace(&chats, &staged_name, &files, &trash.destination)
                    .map_err(|error| fail("busy", format!("Could not move chat folder to Trash: {}", error.1)))?;
                chats.sync_all().map_err(io)?; files.sync_all().map_err(io)?;
            } else if !stat(&files, &trash.destination)?.is_some_and(|value| matches_directory(&value, trash)) {
                return Err(fail("busy", "Cannot verify the chat folder in Trash"));
            }
        }
        Ok(())
    }

    fn finish_group(agent: &Path, root: &Path, token: &str, group: &GroupJournal) -> Result<(), Failure> {
        finish_group_with_hook(agent, root, token, group, |_| Ok(()))
    }
    fn finish_group_with_hook(agent: &Path, root: &Path, token: &str, group: &GroupJournal, hook: impl Fn(&str) -> Result<(), Failure>) -> Result<(), Failure> {
        verify_group(agent, root, token, group)?;
        let journal_root = journal_dir(agent)?;
        let transaction = open_directory(&journal_root, token)?;
        let committed = stat(&transaction, "commit")?.is_some();
        if committed && read_file(&transaction, "commit")? != b"commit\n" { return Err(fail("io", "Invalid deletion commit marker")); }
        let ready = match stat(&transaction, "ready")? {
            Some(_) => Some(serde_json::from_slice::<GroupReady>(&read_file(&transaction, "ready")?).map_err(io)?),
            None => None,
        };
        if ready.as_ref().is_some_and(|ready| ready.replacements.len() != group.items.len()) || (committed && ready.is_none()) {
            return Err(fail("io", "Invalid deletion group readiness"));
        }
        if ready.as_ref().is_some_and(|ready| group.items.iter().zip(&ready.replacements).any(|(item, replacement)| item.replacement_header.is_some() != replacement.is_some())
            || group.trash.as_ref().is_some_and(|trash| trash.kind == "system") != ready.trash_info.is_some()) {
            return Err(fail("io", "Invalid group replacement readiness"));
        }
        for (index, item) in group.items.iter().enumerate() {
            let (parent, original) = parent_and_name(root, &item.source)?;
            let stage_name = group_stage_name(token, index);
            let stage = match open_directory(&parent, &stage_name) {
                Ok(stage) => Some(stage),
                Err(_) if stat(&parent, &stage_name)?.is_none() => None,
                Err(error) => return Err(error),
            };
            let expected = item_version(item);
            if let Some(stage) = stage {
                for entry in std::fs::read_dir(format!("/proc/self/fd/{}", stage.as_raw_fd())).map_err(io)? {
                    let entry = entry.map_err(io)?;
                    let name = entry.file_name();
                    if !(name == "original" || name == "replacement") || !entry.file_type().map_err(io)?.is_file() {
                        return Err(fail("io", "Invalid deletion group staging entry"));
                    }
                }
                let staged_original = stat(&stage, "original")?;
                let staged_replacement = stat(&stage, "replacement")?;
                if !committed {
                    if let Some(original_stat) = staged_original {
                        // Even an unexpected replacement isolated from the source
                        // is returned without overwriting a newer source file.
                        let _ = original_stat;
                        rename_no_replace(&stage, "original", &parent, &original)
                            .map_err(|_| fail("busy", "Group recovery cannot restore without replacing a file"))?;
                        parent.sync_all().map_err(io)?;
                    } else if !stat(&parent, &original)?.is_some_and(|value| matches_version(&value, &expected)) {
                        return Err(fail("busy", "Group recovery cannot verify the original session"));
                    }
                    if staged_replacement.is_some() { unlink(&stage, "replacement", 0)?; }
                } else {
                    let replacement = ready.as_ref().and_then(|ready| ready.replacements[index].as_ref());
                    if item.replacement_header.is_some() != replacement.is_some() { return Err(fail("io", "Invalid group replacement readiness")); }
                    if let Some(replacement) = replacement {
                        if let Some(staged) = staged_replacement {
                            if !matches_version(&staged, replacement) { return Err(fail("busy", "Staged replacement changed")); }
                            rename_no_replace(&stage, "replacement", &parent, &original)
                                .map_err(|_| fail("busy", "Group recovery cannot publish without replacing a file"))?;
                            parent.sync_all().map_err(io)?;
                        } else if !stat(&parent, &original)?.is_some_and(|value| matches_version(&value, replacement)) {
                            return Err(fail("busy", "Group recovery cannot verify the published replacement"));
                        }
                    } else if staged_replacement.is_some() { return Err(fail("io", "Unexpected group replacement")); }
                    if let Some(original_stat) = staged_original {
                        if !matches_version(&original_stat, &expected) { return Err(fail("busy", "Staged original changed")); }
                        unlink(&stage, "original", 0)?;
                    }
                }
                stage.sync_all().map_err(io)?;
                unlink(&parent, &stage_name, libc::AT_REMOVEDIR)?;
                parent.sync_all().map_err(io)?;
            } else if !committed {
                if !stat(&parent, &original)?.is_some_and(|value| matches_version(&value, &expected)) {
                    return Err(fail("busy", "Group recovery cannot verify the original session"));
                }
            } else if let Some(replacement) = ready.as_ref().and_then(|ready| ready.replacements[index].as_ref()) {
                if !stat(&parent, &original)?.is_some_and(|value| matches_version(&value, replacement)) {
                    return Err(fail("busy", "Group recovery cannot verify the published replacement"));
                }
            }
            hook(&format!("applied:{index}"))?;
        }
        if let Some(trash) = &group.trash { finish_trash(agent, token, trash, ready.as_ref(), committed)?; }
        hook("trash-applied")?;
        let done = format!("{token}.done");
        rename_no_replace(&journal_root, token, &journal_root, &done)?;
        journal_root.sync_all().map_err(io)?;
        cleanup_done(&journal_root, &done)
    }

    fn finish(agent: &Path, root: &Path, token: &str, journal: &Journal) -> Result<(), Failure> {
        finish_with_hook(agent, root, token, journal, |_| Ok(()))
    }
    fn finish_with_hook(agent: &Path, root: &Path, token: &str, journal: &Journal, hook: impl Fn(&str) -> Result<(), Failure>) -> Result<(), Failure> {
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
        hook("applied")?;
        // A renamed completed tombstone makes cleanup itself restartable:
        // recovery never has to infer the outcome from partially removed files.
        let done = format!("{token}.done");
        rename_no_replace(&journal_root, token, &journal_root, &done)?;
        journal_root.sync_all().map_err(io)?;
        hook("tombstoned")?;
        cleanup_done(&journal_root, &done)
    }
    fn cleanup_done(journal_root: &File, name: &str) -> Result<(), Failure> {
        let transaction = open_directory(journal_root, name)?;
        for entry in std::fs::read_dir(format!("/proc/self/fd/{}", transaction.as_raw_fd())).map_err(io)? {
            let entry = entry.map_err(io)?;
            let name = entry.file_name().into_string().map_err(|_| fail("io", "Invalid deletion tombstone entry"))?;
            if !matches!(name.as_str(), "journal" | "commit" | "ready") || !entry.file_type().map_err(io)?.is_file() {
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
        enum Pending { Preparation(String, bool), Done(String), Active(String, Journal), Group(String, GroupJournal) }
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
            let mut has_ready = false;
            for child in std::fs::read_dir(format!("/proc/self/fd/{}", transaction.as_raw_fd())).map_err(io)? {
                let child = child.map_err(io)?;
                let name = child.file_name().into_string().map_err(|_| fail("io", "Invalid deletion journal entry"))?;
                if !child.file_type().map_err(io)?.is_file() { return Err(fail("io", "Invalid deletion journal entry")); }
                match name.as_str() {
                    "journal" => has_journal = true,
                    "commit" if kind != 0 => has_commit = true,
                    "ready" if kind != 0 => has_ready = true,
                    _ => return Err(fail("io", "Invalid deletion journal entry")),
                }
            }
            if has_commit && read_file(&transaction, "commit")? != b"commit\n" { return Err(fail("io", "Invalid deletion commit marker")); }
            let mut single = None;
            let mut group = None;
            if has_journal {
                let value: serde_json::Value = serde_json::from_slice(&read_file(&transaction, "journal")?).map_err(io)?;
                match value.get("version").and_then(serde_json::Value::as_u64) {
                    Some(1) => {
                        if has_ready { return Err(fail("io", "Unexpected deletion readiness file")); }
                        let journal: Journal = serde_json::from_value(value).map_err(io)?;
                        verify_journal(&journal, id)?;
                        parent_and_name(root, &journal.source)?;
                        ids.push(journal.session.clone()); single = Some(journal);
                    }
                    Some(2) => {
                        let journal: GroupJournal = serde_json::from_value(value).map_err(io)?;
                        verify_group(&agent, root, id, &journal)?;
                        ids.extend(journal.items.iter().map(|item| item.session.clone()));
                        if has_ready {
                            let ready: GroupReady = serde_json::from_slice(&read_file(&transaction, "ready")?).map_err(io)?;
                            if ready.replacements.len() != journal.items.len() || journal.items.iter().zip(&ready.replacements).any(|(item, replacement)| item.replacement_header.is_some() != replacement.is_some())
                                || journal.trash.as_ref().is_some_and(|trash| trash.kind == "system") != ready.trash_info.is_some() {
                                return Err(fail("io", "Invalid deletion group readiness"));
                            }
                        } else if has_commit { return Err(fail("io", "Missing deletion group readiness")); }
                        group = Some(journal);
                    }
                    _ => return Err(fail("io", "Invalid deletion journal version")),
                }
            } else if kind == 2 || (has_ready && kind != 1) {
                return Err(fail("io", "Missing deletion journal"));
            }
            match kind {
                0 => pending.push(Pending::Preparation(token, has_journal)),
                1 => pending.push(Pending::Done(token)),
                _ if group.is_some() => pending.push(Pending::Group(token, group.unwrap())),
                _ => pending.push(Pending::Active(token, single.ok_or_else(|| fail("io", "Missing deletion journal"))?)),
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
                    Pending::Group(token, journal) => finish_group(&agent, root, &token, &journal)?,
                }
            }
            Ok(())
        }).map_err(|error| match error {
            session_host::SessionWriterError::Busy(message) => fail("busy", message),
            session_host::SessionWriterError::Operation(error) => error,
        })
    }

    pub(crate) fn remove_group(root: &Path, agent: &Path, mutations: Vec<GroupMutation>, trash: Option<GroupTrash>) -> Result<(), Failure> {
        remove_group_with_hook(root, agent, mutations, trash, |_| Ok(()))
    }
    fn remove_group_with_hook(root: &Path, agent: &Path, mutations: Vec<GroupMutation>, trash: Option<GroupTrash>, hook: impl Fn(&str) -> Result<(), Failure>) -> Result<(), Failure> {
        let mut items = Vec::with_capacity(mutations.len());
        for mutation in &mutations {
            let current = mutation.handle.metadata().map_err(io)?;
            if current.dev() != mutation.metadata.dev() || current.ino() != mutation.metadata.ino() || current.len() != mutation.metadata.len()
                || current.mtime() != mutation.metadata.mtime() || current.mtime_nsec() != mutation.metadata.mtime_nsec()
                || current.ctime() != mutation.metadata.ctime() || current.ctime_nsec() != mutation.metadata.ctime_nsec() {
                return Err(fail("busy", "Session changed before group staging"));
            }
            let source = mutation.path.strip_prefix(root).map_err(io)?.to_str().ok_or_else(|| fail("io", "Invalid session path encoding"))?.to_string();
            items.push(GroupItem { session: mutation.session.clone(), source, device: mutation.metadata.dev(), inode: mutation.metadata.ino(),
                size: mutation.metadata.len(), mtime: mutation.metadata.mtime(), mtime_nsec: mutation.metadata.mtime_nsec(),
                replacement_header: mutation.replacement_header.clone(), marker_parent: mutation.marker_parent.clone() });
        }
        let mut random = [0u8; 16]; getrandom::fill(&mut random).map_err(io)?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let trash_journal = if let Some(trash) = &trash {
            let current = trash.handle.metadata().map_err(io)?;
            if !current.is_dir() || current.dev() != trash.metadata.dev() || current.ino() != trash.metadata.ino() {
                return Err(fail("busy", "Chat folder changed before Trash staging"));
            }
            let folder = trash.folder.file_name().and_then(|value| value.to_str()).ok_or_else(|| fail("io", "Invalid chat folder name"))?.to_string();
            let chats = agent.join("chats").canonicalize().map_err(io)?;
            if trash.folder.parent().and_then(|parent| parent.canonicalize().ok()).as_deref() != Some(chats.as_path()) { return Err(fail("access_denied", "Chat folder is outside the chat root")); }
            let files = trash_files(&trash.root, &trash.kind)?;
            let info = if trash.kind == "system" { Some(trash_info(&trash.root)?) } else { None };
            let mut destination = folder.clone();
            if stat(&files, &destination)?.is_some() || info.as_ref().is_some_and(|info| stat(info, &format!("{destination}.trashinfo")).map_or(true, |value| value.is_some())) {
                destination = format!("{folder}-{token}");
            }
            if stat(&files, &destination)?.is_some() || info.as_ref().is_some_and(|info| stat(info, &format!("{destination}.trashinfo")).map_or(true, |value| value.is_some())) {
                return Err(fail("busy", "Trash destination already exists"));
            }
            let info = if trash.kind == "system" {
                let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(io)?.as_millis().min(i64::MAX as u128) as i64;
                let date = crate::pi_ipc::ms_to_iso(ms);
                Some(format!("[Trash Info]\nPath={}\nDeletionDate={}\n", uri_encode(&trash.folder.to_string_lossy()), &date[..19]))
            } else { None };
            Some(TrashJournal { folder, original_path: trash.folder.to_str().ok_or_else(|| fail("io", "Invalid chat folder path encoding"))?.to_string(), device: current.dev(), inode: current.ino(), kind: trash.kind.clone(),
                root: trash.root.to_str().ok_or_else(|| fail("io", "Invalid Trash path encoding"))?.to_string(), destination, info })
        } else { None };
        let group = GroupJournal { version: 2, items, trash: trash_journal };
        verify_group(agent, root, &token, &group)?;
        let bytes = serde_json::to_vec(&group).map_err(io)?;
        if bytes.len() > 4 * 1024 * 1024 { return Err(fail("io", "Deletion group journal exceeds its size budget")); }
        let journal_root = journal_dir(agent)?;
        let preparation = format!(".prepare-{token}");
        if unsafe { libc::mkdirat(journal_root.as_raw_fd(), c(&preparation)?.as_ptr(), 0o700) } != 0 { return Err(io(std::io::Error::last_os_error())); }
        journal_root.sync_all().map_err(io)?;
        let transaction = open_directory(&journal_root, &preparation)?;
        create_file(&transaction, "journal", &bytes)?;
        transaction.sync_all().map_err(io)?;
        rename_no_replace(&journal_root, &preparation, &journal_root, &token)?;
        journal_root.sync_all().map_err(io)?;
        hook("prepared")?;
        let mut replacements = Vec::with_capacity(group.items.len());
        for (index, item) in group.items.iter().enumerate() {
            let staged = (|| {
                let (parent, original) = parent_and_name(root, &item.source)?;
                let stage_name = group_stage_name(&token, index);
                if unsafe { libc::mkdirat(parent.as_raw_fd(), c(&stage_name)?.as_ptr(), 0o700) } != 0 { return Err(io(std::io::Error::last_os_error())); }
                parent.sync_all().map_err(io)?;
                let stage = open_directory(&parent, &stage_name)?;
                rename_no_replace(&parent, &original, &stage, "original")?;
                parent.sync_all().map_err(io)?; stage.sync_all().map_err(io)?;
                let actual = stat(&stage, "original")?.ok_or_else(|| fail("busy", "Isolated group session disappeared"))?;
                if !matches_version(&actual, &item_version(item)) { return Err(fail("busy", "Session changed during group isolation")); }
                let replacement = if item.replacement_header.is_some() { Some(make_replacement(&stage, item)?) } else { None };
                stage.sync_all().map_err(io)?;
                Ok(replacement)
            })();
            match staged {
                Ok(replacement) => replacements.push(replacement),
                Err(error) => {
                    if let Err(rollback) = finish_group(agent, root, &token, &group) {
                        return Err(fail("busy", format!("{}; group rollback pending: {}", error.1, rollback.1)));
                    }
                    return Err(error);
                }
            }
            hook(&format!("isolated:{index}"))?;
        }
        let mut trash_info_version = None;
        if let (Some(trash), Some(proof)) = (&group.trash, &trash) {
            let staged = (|| {
                let current = proof.handle.metadata().map_err(io)?;
                if current.dev() != trash.device || current.ino() != trash.inode { return Err(fail("busy", "Chat folder changed before isolation")); }
                let chats = open_dir_path(&agent.join("chats").canonicalize().map_err(io)?)?;
                let stage_name = format!(".pi-deletion-{token}-chat");
                rename_no_replace(&chats, &trash.folder, &chats, &stage_name)?;
                chats.sync_all().map_err(io)?;
                let isolated = stat(&chats, &stage_name)?.ok_or_else(|| fail("busy", "Isolated chat folder disappeared"))?;
                if !matches_directory(&isolated, trash) { return Err(fail("busy", "Chat folder changed during isolation")); }
                if trash.kind == "system" {
                    let info = trash_info(Path::new(&trash.root))?;
                    let stage_name = format!(".pi-deletion-{token}-info");
                    if unsafe { libc::mkdirat(info.as_raw_fd(), c(&stage_name)?.as_ptr(), 0o700) } != 0 { return Err(io(std::io::Error::last_os_error())); }
                    info.sync_all().map_err(io)?;
                    let stage = open_directory(&info, &stage_name)?;
                    create_file(&stage, "info", trash.info.as_ref().ok_or_else(|| fail("io", "Missing Trash information"))?.as_bytes())?;
                    stage.sync_all().map_err(io)?;
                    let value = stat(&stage, "info")?.ok_or_else(|| fail("io", "Trash information disappeared"))?;
                    Ok(Some(version_from_stat(&value)))
                } else { Ok(None) }
            })();
            match staged {
                Ok(version) => trash_info_version = version,
                Err(error) => {
                    // A failed OS Trash attempt remains journaled; it must not
                    // be mistaken for a successful move or silently discarded.
                    return Err(fail("busy", format!("{}; chat Trash transaction remains pending", error.1)));
                }
            }
            hook("chat-isolated")?;
        }
        let ready = serde_json::to_vec(&GroupReady { replacements, trash_info: trash_info_version }).map_err(io)?;
        create_file(&transaction, "ready", &ready)?;
        transaction.sync_all().map_err(io)?;
        hook("ready")?;
        create_file(&transaction, "commit", b"commit\n")?;
        transaction.sync_all().map_err(io)?;
        hook("committed")?;
        finish_group_with_hook(agent, root, &token, &group, hook)
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
        finish_with_hook(agent, root, &token, &journal, hook)
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
        fn group_fixture() -> (tempfile::TempDir, crate::pi_ipc::IpcHostState, std::path::PathBuf, Vec<GroupMutation>) {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("sessions"); std::fs::create_dir_all(root.join("p")).unwrap();
            let state = crate::pi_ipc::IpcHostState::new();
            *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
            state.deletion_recovery_exclusive.store(true, std::sync::atomic::Ordering::SeqCst);
            let mut mutations = Vec::new();
            for id in ["root", "sub", "fork"] {
                let path = root.join(format!("p/{id}.jsonl"));
                let header = json!({"type":"session","id":id,"cwd":"/tmp","parentSession":"old-parent"});
                std::fs::write(&path, format!("{header}\n{}\n", json!({"type":"message","message":{"role":"user","content":"keep body"}}))).unwrap();
                let handle = File::open(&path).unwrap(); let metadata = handle.metadata().unwrap();
                let replacement_header = (id == "fork").then(|| json!({"type":"session","id":"fork","cwd":"/tmp","parentSession":"new-parent"}).to_string());
                mutations.push(GroupMutation { session: id.into(), path, handle, metadata, replacement_header, marker_parent: None });
            }
            (dir, state, root, mutations)
        }
        #[test]
        fn group_commit_and_rollback_are_recoverable_at_key_phases() {
            for phase in ["prepared", "isolated:0", "isolated:1", "isolated:2", "ready", "committed", "applied:0", "applied:1", "applied:2"] {
                let (dir, state, root, mutations) = group_fixture();
                assert!(remove_group_with_hook(&root, dir.path(), mutations, None, |at| if at == phase { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
                let _policy = state.policy_gate.try_read().unwrap();
                let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(dir.path()).unwrap();
                recover(&state, &root).unwrap();
                let target = root.join("p/root.jsonl"); let sub = root.join("p/sub.jsonl"); let fork = root.join("p/fork.jsonl");
                if phase == "committed" || phase.starts_with("applied:") {
                    assert!(!target.exists() && !sub.exists());
                    let data = std::fs::read_to_string(fork).unwrap();
                    assert!(data.contains("new-parent") && data.contains("keep body"));
                } else {
                    assert!(target.exists() && sub.exists());
                    assert!(std::fs::read_to_string(fork).unwrap().contains("old-parent"));
                }
                recover(&state, &root).unwrap();
            }
        }
        #[test]
        fn group_process_crash_requires_explicit_fixture_lock_recovery() {
            if let Ok(agent) = std::env::var("PI_TEST_GROUP_CRASH_AGENT") {
                let agent = std::path::PathBuf::from(agent); let root = agent.join("sessions");
                let mut mutations = Vec::new();
                for id in ["root", "sub", "fork"] {
                    let path = root.join(format!("p/{id}.jsonl"));
                    let handle = File::open(&path).unwrap(); let metadata = handle.metadata().unwrap();
                    let replacement_header = (id == "fork").then(|| json!({"type":"session","id":"fork","cwd":"/tmp","parentSession":"new-parent"}).to_string());
                    mutations.push(GroupMutation { session: id.into(), path, handle, metadata, replacement_header, marker_parent: None });
                }
                let _guard = task_scheduler::transaction_lock::TransactionLock::acquire(&agent).unwrap();
                let phase = std::env::var("PI_TEST_GROUP_CRASH_PHASE").unwrap();
                let _ = remove_group_with_hook(&root, &agent, mutations, None, |at| {
                    if at == phase { std::process::exit(73); }
                    Ok(())
                });
                panic!("group fixture phase not reached");
            }
            for phase in ["isolated:1", "committed", "applied:2"] {
                let (dir, state, root, mutations) = group_fixture(); drop(mutations);
                let status = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "session_deletion_journal::linux::tests::group_process_crash_requires_explicit_fixture_lock_recovery"])
                    .env("PI_TEST_GROUP_CRASH_AGENT", dir.path()).env("PI_TEST_GROUP_CRASH_PHASE", phase).status().unwrap();
                assert_eq!(status.code(), Some(73));
                let gate = dir.path().join("scheduled-tasks/transaction.lock"); assert!(gate.is_dir());
                // Only this reaped child's isolated fixture lock is removed.
                std::fs::remove_file(gate.join("owner")).unwrap(); std::fs::remove_dir(&gate).unwrap();
                let _policy = state.policy_gate.try_read().unwrap();
                let _exclusive = task_scheduler::transaction_lock::TransactionLock::acquire(dir.path()).unwrap();
                recover(&state, &root).unwrap();
                let committed = phase != "isolated:1";
                assert_eq!(root.join("p/root.jsonl").exists(), !committed);
                let fork = std::fs::read_to_string(root.join("p/fork.jsonl")).unwrap();
                assert!(fork.contains(if committed { "new-parent" } else { "old-parent" }));
            }
        }
        #[test]
        fn chat_folder_moves_with_group_and_restores_before_commit() {
            for phase in ["isolated:1", "chat-isolated", "ready", "committed", "applied:1", "trash-applied"] {
                let (dir, state, root, mutations) = group_fixture();
                let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
                std::fs::write(chat.join("kept.txt"), "user data").unwrap();
                let trash = prepare_trash(dir.path(), &chat, true).unwrap();
                assert!(remove_group_with_hook(&root, dir.path(), mutations, Some(trash), |at| if at == phase { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
                let _policy = state.policy_gate.try_read().unwrap();
                let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(dir.path()).unwrap();
                recover(&state, &root).unwrap();
                let committed = matches!(phase, "committed" | "applied:1" | "trash-applied");
                assert_eq!(chat.exists(), !committed, "{phase}");
                let contents = if committed { dir.path().join("chats-trash/chat-one/kept.txt") } else { chat.join("kept.txt") };
                assert_eq!(std::fs::read_to_string(contents).unwrap(), "user data");
                recover(&state, &root).unwrap();
            }
        }
        #[test]
        fn chat_group_process_crash_recovers_only_under_fixture_exclusivity() {
            if let Ok(agent) = std::env::var("PI_TEST_CHAT_CRASH_AGENT") {
                let agent = std::path::PathBuf::from(agent); let root = agent.join("sessions");
                let path = root.join("p/root.jsonl"); let handle = File::open(&path).unwrap(); let metadata = handle.metadata().unwrap();
                let mutation = GroupMutation { session:"root".into(), path, handle, metadata, replacement_header:None, marker_parent:None };
                let chat = agent.join("chats/chat-one"); let trash = prepare_trash(&agent, &chat, true).unwrap();
                let _guard = task_scheduler::transaction_lock::TransactionLock::acquire(&agent).unwrap();
                let phase = std::env::var("PI_TEST_CHAT_CRASH_PHASE").unwrap();
                let _ = remove_group_with_hook(&root, &agent, vec![mutation], Some(trash), |at| {
                    if at == phase { std::process::exit(73); } Ok(())
                });
                panic!("chat fixture phase not reached");
            }
            for phase in ["chat-isolated", "committed", "trash-applied"] {
                let (dir, state, root, mutations) = group_fixture(); drop(mutations);
                let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
                std::fs::write(chat.join("kept.txt"), "user data").unwrap();
                let status = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "session_deletion_journal::linux::tests::chat_group_process_crash_recovers_only_under_fixture_exclusivity"])
                    .env("PI_TEST_CHAT_CRASH_AGENT", dir.path()).env("PI_TEST_CHAT_CRASH_PHASE", phase).status().unwrap();
                assert_eq!(status.code(), Some(73));
                let gate = dir.path().join("scheduled-tasks/transaction.lock"); assert!(gate.is_dir());
                std::fs::remove_file(gate.join("owner")).unwrap(); std::fs::remove_dir(&gate).unwrap();
                let _policy = state.policy_gate.try_read().unwrap();
                let _exclusive = task_scheduler::transaction_lock::TransactionLock::acquire(dir.path()).unwrap();
                recover(&state, &root).unwrap();
                let committed = phase != "chat-isolated";
                assert_eq!(chat.exists(), !committed);
                let contents = if committed { dir.path().join("chats-trash/chat-one/kept.txt") } else { chat.join("kept.txt") };
                assert_eq!(std::fs::read_to_string(contents).unwrap(), "user data");
            }
        }
        #[test]
        fn isolated_system_trash_moves_folder_and_preserves_evidence_on_failure() {
            if let Ok(agent) = std::env::var("PI_TEST_GROUP_TRASH_AGENT") {
                let agent = std::path::PathBuf::from(agent); let root = agent.join("sessions");
                let path = root.join("p/root.jsonl");
                let handle = File::open(&path).unwrap(); let metadata = handle.metadata().unwrap();
                let mutation = GroupMutation { session:"root".into(), path, handle, metadata, replacement_header:None, marker_parent:None };
                let chat = agent.join("chats/chat-one");
                let trash = prepare_trash(&agent, &chat, false).unwrap();
                assert_eq!(trash.kind, "system");
                let data_home = std::path::PathBuf::from(std::env::var_os("XDG_DATA_HOME").unwrap());
                let mode = std::env::var("PI_TEST_GROUP_TRASH_COLLISION").unwrap();
                let result = remove_group_with_hook(&root, &agent, vec![mutation], Some(trash), |phase| {
                    if mode == "1" && phase == "committed" { std::fs::write(data_home.join("Trash/files/chat-one"), "new user file").unwrap(); }
                    if mode == "stagefail" && phase == "isolated:0" { std::fs::remove_dir(data_home.join("Trash/info")).unwrap(); }
                    Ok(())
                });
                if mode == "stagefail" {
                    assert_eq!(result.unwrap_err().0, "busy");
                    assert!(crate::session_deletion_journal::has_pending(&agent).unwrap());
                    std::fs::create_dir(data_home.join("Trash/info")).unwrap();
                    let state = crate::pi_ipc::IpcHostState::new(); *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
                    state.deletion_recovery_exclusive.store(true, std::sync::atomic::Ordering::SeqCst);
                    let _policy = state.policy_gate.try_read().unwrap();
                    let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(&agent).unwrap();
                    recover(&state, &root).unwrap();
                    assert_eq!(std::fs::read_to_string(chat.join("kept.txt")).unwrap(), "user data");
                } else if mode == "1" {
                    assert_eq!(result.unwrap_err().0, "busy");
                    assert_eq!(std::fs::read_to_string(data_home.join("Trash/files/chat-one")).unwrap(), "new user file");
                    assert!(crate::session_deletion_journal::has_pending(&agent).unwrap());
                    std::fs::remove_file(data_home.join("Trash/files/chat-one")).unwrap();
                    let state = crate::pi_ipc::IpcHostState::new(); *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
                    state.deletion_recovery_exclusive.store(true, std::sync::atomic::Ordering::SeqCst);
                    let _policy = state.policy_gate.try_read().unwrap();
                    let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(&agent).unwrap();
                    recover(&state, &root).unwrap();
                    assert_eq!(std::fs::read_to_string(data_home.join("Trash/files/chat-one/kept.txt")).unwrap(), "user data");
                } else {
                    result.unwrap();
                    assert_eq!(std::fs::read_to_string(data_home.join("Trash/files/chat-one/kept.txt")).unwrap(), "user data");
                    let info = std::fs::read_to_string(data_home.join("Trash/info/chat-one.trashinfo")).unwrap();
                    assert!(info.contains("[Trash Info]\nPath=") && info.contains("DeletionDate="));
                }
                return;
            }
            for mode in ["0", "1", "stagefail"] {
                let (dir, _state, _root, mutations) = group_fixture(); drop(mutations);
                let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
                std::fs::write(chat.join("kept.txt"), "user data").unwrap();
                let data_home = dir.path().join("xdg"); std::fs::create_dir(&data_home).unwrap();
                let output = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "session_deletion_journal::linux::tests::isolated_system_trash_moves_folder_and_preserves_evidence_on_failure"])
                    .env("PI_TEST_GROUP_TRASH_AGENT", dir.path()).env("XDG_DATA_HOME", &data_home)
                    .env("PI_TEST_GROUP_TRASH_COLLISION", mode).output().unwrap();
                assert!(output.status.success(), "{} {}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            }
        }
        #[test]
        fn committed_chat_move_preserves_a_new_source_folder() {
            let (dir, _state, root, mutations) = group_fixture();
            let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
            std::fs::write(chat.join("old"), "original").unwrap();
            let trash = prepare_trash(dir.path(), &chat, true).unwrap();
            remove_group_with_hook(&root, dir.path(), mutations, Some(trash), |phase| {
                if phase == "chat-isolated" { std::fs::create_dir(&chat).unwrap(); std::fs::write(chat.join("new"), "new data").unwrap(); }
                Ok(())
            }).unwrap();
            assert_eq!(std::fs::read_to_string(chat.join("new")).unwrap(), "new data");
            assert_eq!(std::fs::read_to_string(dir.path().join("chats-trash/chat-one/old")).unwrap(), "original");
        }
        #[test]
        fn application_trash_root_symlink_is_refused() {
            let (dir, _state, _root, _mutations) = group_fixture();
            let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
            let outside = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(outside.path(), dir.path().join("chats-trash")).unwrap();
            assert!(prepare_trash(dir.path(), &chat, true).is_err());
            assert!(chat.exists());
            assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
        }
        #[test]
        fn chat_recovery_never_replaces_a_new_folder() {
            let (dir, state, root, mutations) = group_fixture();
            let chat = dir.path().join("chats/chat-one"); std::fs::create_dir_all(&chat).unwrap();
            std::fs::write(chat.join("old"), "original").unwrap();
            let trash = prepare_trash(dir.path(), &chat, true).unwrap();
            assert!(remove_group_with_hook(&root, dir.path(), mutations, Some(trash), |at| if at == "chat-isolated" { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
            std::fs::create_dir(&chat).unwrap(); std::fs::write(chat.join("new"), "new data").unwrap();
            let _policy = state.policy_gate.try_read().unwrap();
            let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(dir.path()).unwrap();
            assert_eq!(recover(&state, &root).unwrap_err().0, "busy");
            assert_eq!(std::fs::read_to_string(chat.join("new")).unwrap(), "new data");
            assert!(crate::session_deletion_journal::has_pending(dir.path()).unwrap());
        }
        #[test]
        fn group_recovery_never_overwrites_a_new_source() {
            let (dir, state, root, mutations) = group_fixture();
            assert!(remove_group_with_hook(&root, dir.path(), mutations, None, |at| if at == "isolated:0" { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
            let target = root.join("p/root.jsonl"); std::fs::write(&target, "new user file").unwrap();
            let _policy = state.policy_gate.try_read().unwrap();
            let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(dir.path()).unwrap();
            assert_eq!(recover(&state, &root).unwrap_err().0, "busy");
            assert_eq!(std::fs::read_to_string(target).unwrap(), "new user file");
        }
        #[test]
        fn committed_group_refuses_to_overwrite_new_child_file() {
            let (dir, state, root, mutations) = group_fixture();
            assert!(remove_group_with_hook(&root, dir.path(), mutations, None, |at| if at == "committed" { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
            let fork = root.join("p/fork.jsonl"); std::fs::write(&fork, "new user file").unwrap();
            let _policy = state.policy_gate.try_read().unwrap();
            let _transaction = task_scheduler::transaction_lock::TransactionLock::acquire(dir.path()).unwrap();
            assert_eq!(recover(&state, &root).unwrap_err().0, "busy");
            assert_eq!(std::fs::read_to_string(fork).unwrap(), "new user file");
            assert!(crate::session_deletion_journal::has_pending(dir.path()).unwrap());
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
            for phase in ["isolated", "committed", "applied", "tombstoned"] {
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
                assert_eq!(source.exists(), phase == "isolated");
            }
        }
        #[test]
        fn restart_recovers_each_durable_phase() {
            for phase in ["prepared", "isolated", "committed", "applied", "tombstoned"] {
                let (dir, state, root, source) = fixture();
                let metadata = std::fs::metadata(&source).unwrap();
                assert!(remove_with_hook(&root, dir.path(), "a", &source, &metadata, |at| if at == phase { Err(fail("fixture", "crash")) } else { Ok(()) }).is_err());
                recover(&state, &root).unwrap();
                assert_eq!(source.exists(), matches!(phase, "prepared" | "isolated"), "{phase}");
                recover(&state, &root).unwrap();
            }
        }
        #[test]
        fn empty_journal_without_sessions_is_not_pending() {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir(dir.path().join("session-deletion-journal")).unwrap();
            let state = crate::pi_ipc::IpcHostState::new();
            *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
            for op in ["sessions.index", "sessions.list", "sessions.search"] {
                let args = if op == "sessions.search" { json!({"query":""}) } else { json!({}) };
                let response = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"test","op":op,"args":args}));
                assert_eq!(response["ok"], true, "{op}: {response}");
            }
            std::fs::create_dir(dir.path().join("session-deletion-journal/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).unwrap();
            let response = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"test","op":"sessions.list","args":{}}));
            assert_eq!(response["error"]["code"], "busy", "{response}");
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
            let empty = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"empty","op":"sessions.search","args":{"query":""}}));
            assert_eq!(empty["error"]["code"], "busy", "{empty}");
            assert!(!source.exists());
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
pub(crate) use linux::{prepare_trash, recover, remove, remove_group, GroupMutation};

#[cfg(not(target_os = "linux"))]
pub(crate) struct GroupTrash {
    pub folder: std::path::PathBuf,
    pub handle: std::fs::File,
    pub metadata: std::fs::Metadata,
    pub kind: String,
    pub root: std::path::PathBuf,
}
#[cfg(not(target_os = "linux"))]
pub(crate) struct GroupMutation {
    pub session: String,
    pub path: std::path::PathBuf,
    pub handle: std::fs::File,
    pub metadata: std::fs::Metadata,
    pub replacement_header: Option<String>,
    pub marker_parent: Option<(String, String)>,
}
#[cfg(not(target_os = "linux"))]
pub(crate) fn prepare_trash(_agent: &std::path::Path, _folder: &std::path::Path, _prefer_app: bool) -> Result<GroupTrash, (String, String)> {
    Err(("not_supported".into(), "Safe chat Trash is unavailable on this platform.".into()))
}
#[cfg(not(target_os = "linux"))]
pub(crate) fn remove_group(_root: &std::path::Path, _agent: &std::path::Path, _mutations: Vec<GroupMutation>, _trash: Option<GroupTrash>) -> Result<(), (String, String)> {
    Err(("not_supported".into(), "Safe session deletion is unavailable on this platform.".into()))
}

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
