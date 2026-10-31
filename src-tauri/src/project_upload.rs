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
    let cname = std::ffi::CString::new(name).unwrap();
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK
        | if strategy == "overwrite" { 0 } else { libc::O_EXCL };
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
    if let Err(error) = file.set_len(0).and_then(|_| file.write_all(&bytes)) {
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
