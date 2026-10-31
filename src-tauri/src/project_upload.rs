//! Bounded browser File uploads to a host-authorized directory.
use crate::pi_ipc::{protocol_error, IpcHostState};
use serde_json::Value;

#[cfg(unix)]
fn directory(state: &IpcHostState, args: &Value) -> Result<std::fs::File, &'static str> {
    use std::path::Path;
    let path = Path::new(args.get("directory").and_then(Value::as_str).unwrap_or(""));
    let scoped = { let roots = state.file_roots.lock().unwrap(); crate::file_access::resolved_read_target_with_root(&roots, path) };
    let (target, root) = scoped.ok_or("Destination is outside authorized roots")?;
    crate::file_access::open_directory_beneath_root(&root, &target).map_err(|_| "Cannot open destination safely")
}

#[cfg(unix)]
fn valid_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

#[cfg(unix)]
pub fn check(state: &IpcHostState, id: &str, args: &Value) -> Value {
    use std::os::fd::AsRawFd;
    use serde_json::json;
    use crate::pi_ipc::protocol_ok;
    let names = match args.get("fileNames").and_then(Value::as_array) {
        Some(names) if !names.is_empty() && names.len() <= 100 => names,
        _ => return protocol_error(id, "invalid_args", "Invalid file names"),
    };
    let directory = match directory(state, args) { Ok(dir) => dir, Err(error) => return protocol_error(id, "unauthorized_scope", error) };
    let mut conflicts = Vec::new(); let mut non_replaceable = Vec::new(); let mut seen = std::collections::HashSet::new();
    for value in names {
        let Some(name) = value.as_str().filter(|name| valid_name(name)) else { return protocol_error(id, "invalid_args", "Invalid file name") };
        if !seen.insert(name) { return protocol_error(id, "invalid_args", "Duplicate file name") }
        let cname = std::ffi::CString::new(name).unwrap();
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatat(directory.as_raw_fd(), cname.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } == 0 {
            conflicts.push(name);
            if stat.st_mode & libc::S_IFMT != libc::S_IFREG { non_replaceable.push(name); }
        } else if std::io::Error::last_os_error().kind() != std::io::ErrorKind::NotFound {
            return protocol_error(id, "io", "Cannot inspect upload target");
        }
    }
    protocol_ok(id, json!({ "conflicts": conflicts, "nonReplaceable": non_replaceable }))
}

#[cfg(unix)]
fn atomic_replace(directory: &std::fs::File, name: &str, input: &mut impl std::io::Read) -> std::io::Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::MetadataExt;
    let target = std::ffi::CString::new(name).map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let check_target = || -> std::io::Result<()> {
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatat(directory.as_raw_fd(), target.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } == 0 {
            if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
                return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Destination is not a regular file"));
            }
        } else {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::NotFound { return Err(error); }
        }
        Ok(())
    };
    check_target()?;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|error| std::io::Error::other(error.to_string()))?;
    let temp_name = format!(".pi-upload-{}", random.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let temp_name = std::ffi::CString::new(temp_name).unwrap();
    let fd = unsafe { libc::openat(directory.as_raw_fd(), temp_name.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o666) };
    if fd < 0 { return Err(std::io::Error::last_os_error()); }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let original = file.metadata().map_err(|error| std::io::Error::other(format!("overwrite not performed; temporary entry {} may remain: {error}", temp_name.to_string_lossy())))?;
    let result = (|| {
        std::io::copy(input, &mut file)?;
        file.sync_all()?;
        check_target()?;
        let mut staged: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatat(directory.as_raw_fd(), temp_name.as_ptr(), &mut staged, libc::AT_SYMLINK_NOFOLLOW) } != 0
            || staged.st_dev as u64 != original.dev() || staged.st_ino as u64 != original.ino() {
            return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Temporary upload was replaced"));
        }
        if unsafe { libc::renameat(directory.as_raw_fd(), temp_name.as_ptr(), directory.as_raw_fd(), target.as_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    })();
    result.map_err(|error| std::io::Error::new(error.kind(), format!(
        "overwrite not performed; temporary entry {} may remain (its ownership may have changed): {error}",
        temp_name.to_string_lossy(),
    )))
}

#[cfg(unix)]
pub fn upload_one(state: &IpcHostState, id: &str, args: &Value) -> Value {
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd};
    use base64::Engine;
    use serde_json::json;
    use crate::pi_ipc::protocol_ok;
    const MAX: usize = 25 * 1024 * 1024;
    let Some(name) = args.get("name").and_then(Value::as_str).filter(|name| valid_name(name)) else { return protocol_error(id, "invalid_args", "Invalid file name") };
    let strategy = args.get("conflict").and_then(Value::as_str).unwrap_or("");
    if !matches!(strategy, "error" | "skip" | "overwrite") { return protocol_error(id, "invalid_args", "Invalid conflict strategy") }
    let Some(encoded) = args.get("data").and_then(Value::as_str).filter(|s| s.len() <= ((MAX + 2) / 3) * 4) else { return protocol_error(id, "payload_too_large", "File is larger than 25MB") };
    let bytes = match base64::engine::general_purpose::STANDARD.decode(encoded) {
        Ok(bytes) if bytes.len() <= MAX => bytes,
        _ => return protocol_error(id, "invalid_args", "Invalid upload data"),
    };
    let directory = match directory(state, args) { Ok(dir) => dir, Err(error) => return protocol_error(id, "unauthorized_scope", error) };
    if strategy == "overwrite" {
        return match atomic_replace(&directory, name, &mut bytes.as_slice()) {
            Ok(()) => protocol_ok(id, json!({ "outcome": "uploaded" })),
            Err(error) => protocol_error(id, "io", &error.to_string()),
        };
    }
    let cname = std::ffi::CString::new(name).unwrap();
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK | libc::O_EXCL;
    let fd = unsafe { libc::openat(directory.as_raw_fd(), cname.as_ptr(), flags, 0o666) };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            return protocol_ok(id, json!({ "outcome": if strategy == "skip" { "skipped" } else { "conflict" } }));
        }
        return protocol_error(id, "io", &error.to_string());
    }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    if !file.metadata().map(|m| m.is_file()).unwrap_or(false) { return protocol_error(id, "unauthorized_scope", "Destination is not a regular file") }
    if let Err(error) = file.write_all(&bytes) {
        return protocol_error(id, "io", &format!("{error}; partial destination may remain"));
    }
    protocol_ok(id, json!({ "outcome": "uploaded" }))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::json;
    #[test]
    fn overwrite_replaces_hardlink_without_modifying_outside_inode() {
        use std::os::unix::fs::MetadataExt;
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project"); std::fs::create_dir(&project).unwrap();
        let outside = tmp.path().join("outside"); std::fs::write(&outside, b"outside sentinel").unwrap();
        let target = project.join("report.txt"); std::fs::hard_link(&outside, &target).unwrap();
        let old_inode = std::fs::metadata(&outside).unwrap().ino();
        let state = IpcHostState::new(); state.file_roots.lock().unwrap().add(&project);
        let result = upload_one(&state, "overwrite", &json!({ "directory": project, "name": "report.txt", "data": base64::engine::general_purpose::STANDARD.encode(b"new content"), "conflict": "overwrite" }));
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside sentinel");
        assert_eq!(std::fs::metadata(&outside).unwrap().ino(), old_inode);
        assert_eq!(std::fs::read(&target).unwrap(), b"new content");
        assert_ne!(std::fs::metadata(&target).unwrap().ino(), old_inode);
    }

    #[test]
    fn failed_overwrite_preserves_old_and_unrelated_new_file() {
        use std::io::{self, Read};
        struct FailingReader { unrelated: std::path::PathBuf }
        impl Read for FailingReader {
            fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
                std::fs::write(&self.unrelated, b"do not remove").unwrap();
                Err(io::Error::other("fixture write failure"))
            }
        }
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("report.txt"); std::fs::write(&target, b"old data").unwrap();
        let directory = std::fs::File::open(tmp.path()).unwrap();
        let mut input = FailingReader { unrelated: tmp.path().join("new-file") };
        let error = atomic_replace(&directory, "report.txt", &mut input).unwrap_err().to_string();
        assert!(error.contains("overwrite not performed"));
        assert!(error.contains(".pi-upload-"));
        assert!(error.contains("may remain"));
        assert_eq!(std::fs::read(target).unwrap(), b"old data");
        assert_eq!(std::fs::read(tmp.path().join("new-file")).unwrap(), b"do not remove");
        let temporary: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().map(|entry| entry.unwrap().path())
            .filter(|path| path.file_name().unwrap().to_string_lossy().starts_with(".pi-upload-")).collect();
        assert_eq!(temporary.len(), 1, "failed staging is retained rather than raced by cleanup");
    }

    #[test]
    fn overwrite_refuses_target_replaced_by_symlink_during_write() {
        use std::io::{self, Read};
        struct Swap { target: std::path::PathBuf, outside: std::path::PathBuf, done: bool }
        impl Read for Swap {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                if self.done { return Ok(0); }
                self.done = true;
                std::fs::remove_file(&self.target).unwrap();
                std::os::unix::fs::symlink(&self.outside, &self.target).unwrap();
                buffer[0] = b'x'; Ok(1)
            }
        }
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project"); std::fs::create_dir(&project).unwrap();
        let target = project.join("target"); std::fs::write(&target, b"old").unwrap();
        let outside = tmp.path().join("outside"); std::fs::write(&outside, b"outside").unwrap();
        let directory = std::fs::File::open(&project).unwrap();
        assert!(atomic_replace(&directory, "target", &mut Swap { target: target.clone(), outside: outside.clone(), done: false }).is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
        assert!(std::fs::symlink_metadata(target).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_dir(project).unwrap().count(), 2, "the symlink and retained staging entry remain");
    }

    #[test]
    fn overwrite_stays_on_pinned_directory_after_ancestor_swap() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project"); let outside = tmp.path().join("outside");
        std::fs::create_dir(&project).unwrap(); std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("target"), b"outside").unwrap();
        let directory = std::fs::File::open(&project).unwrap();
        let moved = tmp.path().join("moved"); std::fs::rename(&project, &moved).unwrap();
        std::os::unix::fs::symlink(&outside, &project).unwrap();
        atomic_replace(&directory, "target", &mut b"inside".as_slice()).unwrap();
        assert_eq!(std::fs::read(outside.join("target")).unwrap(), b"outside");
        assert_eq!(std::fs::read(moved.join("target")).unwrap(), b"inside");
    }

    #[test]
    fn failed_overwrite_does_not_remove_replaced_temporary_entry() {
        use std::io::{self, Read};
        struct ReplacingReader { dir: std::path::PathBuf }
        impl Read for ReplacingReader {
            fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
                let temp = std::fs::read_dir(&self.dir).unwrap().map(|e| e.unwrap().path())
                    .find(|p| p.file_name().unwrap().to_string_lossy().starts_with(".pi-upload-")).unwrap();
                std::fs::remove_file(&temp).unwrap();
                std::fs::write(temp, b"replacement").unwrap();
                Err(io::Error::other("fixture failure"))
            }
        }
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("target"), b"old").unwrap();
        let directory = std::fs::File::open(tmp.path()).unwrap();
        assert!(atomic_replace(&directory, "target", &mut ReplacingReader { dir: tmp.path().to_path_buf() }).is_err());
        assert_eq!(std::fs::read(tmp.path().join("target")).unwrap(), b"old");
        let remaining: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().path()).filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(".pi-upload-")).collect();
        assert_eq!(remaining.len(), 1);
        assert_eq!(std::fs::read(&remaining[0]).unwrap(), b"replacement");
    }

    #[test]
    fn upload_refuses_unapproved_roots_and_symlink_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project"); std::fs::create_dir(&project).unwrap();
        let secret = tmp.path().join("secret"); std::fs::write(&secret, b"secret").unwrap();
        let state = IpcHostState::new();
        let args = json!({ "directory": project, "name": "a.txt", "data": base64::engine::general_purpose::STANDARD.encode(b"upload"), "conflict": "skip" });
        assert_eq!(upload_one(&state, "a", &args)["error"]["code"], "unauthorized_scope");
        state.file_roots.lock().unwrap().add(&project);
        assert_eq!(upload_one(&state, "b", &args)["data"]["outcome"], "uploaded");
        assert_eq!(upload_one(&state, "c", &args)["data"]["outcome"], "skipped");
        assert_eq!(std::fs::read(project.join("a.txt")).unwrap(), b"upload");
        std::os::unix::fs::symlink(&secret, project.join("link")).unwrap();
        let inspection = check(&state, "d", &json!({ "directory": project, "fileNames": ["link"] }));
        assert_eq!(inspection["data"]["nonReplaceable"][0], "link");
        let denied = upload_one(&state, "e", &json!({ "directory": project, "name": "link", "data": "eA==", "conflict": "overwrite" }));
        assert_eq!(denied["ok"], false);
        assert_eq!(std::fs::read(secret).unwrap(), b"secret");
        assert_eq!(upload_one(&state, "f", &json!({ "directory": project, "name": "../bad", "data": "eA==", "conflict": "skip" }))["error"]["code"], "invalid_args");
    }
}

#[cfg(not(unix))]
pub fn check(_state: &IpcHostState, id: &str, _args: &Value) -> Value { protocol_error(id, "not_supported", "Secure uploads are unavailable on this platform") }
#[cfg(not(unix))]
pub fn upload_one(_state: &IpcHostState, id: &str, _args: &Value) -> Value { protocol_error(id, "not_supported", "Secure uploads are unavailable on this platform") }
