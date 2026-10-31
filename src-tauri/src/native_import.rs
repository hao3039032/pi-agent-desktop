//! Copy sources authorized by a native drop into an authorized project directory.
use crate::pi_ipc::{protocol_error, IpcHostState};
use serde_json::Value;

#[cfg(unix)]
pub fn import_dropped(state: &IpcHostState, id: &str, args: &Value) -> Value {
    use std::io::{Seek, SeekFrom};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use serde_json::json;
    use crate::pi_ipc::protocol_ok;
    let paths = match args.get("sourcePaths").and_then(Value::as_array) {
        Some(paths) if !paths.is_empty() && paths.len() <= crate::file_resources::MAX_PATHS => paths,
        _ => return protocol_error(id, "invalid_args", "Invalid source paths"),
    };
    if args.get("conflict").and_then(Value::as_str) != Some("skip") {
        return protocol_error(id, "invalid_args", "Only skip conflicts is supported for native drops");
    }
    let dest = Path::new(args.get("destDirectory").and_then(Value::as_str).unwrap_or(""));
    let scoped = {
        let roots = state.file_roots.lock().unwrap();
        crate::file_access::resolved_read_target_with_root(&roots, dest)
    };
    let Some((target, root)) = scoped else { return protocol_error(id, "unauthorized_scope", "Destination is outside authorized roots") };
    let directory = match crate::file_access::open_directory_beneath_root(&root, &target) {
        Ok(directory) => directory,
        Err(error) => return protocol_error(id, "unauthorized_scope", &error.to_string()),
    };
    let mut selected = Vec::new();
    let mut names = std::collections::HashSet::new();
    for path in paths {
        let Some(path) = path.as_str() else { return protocol_error(id, "invalid_args", "Invalid source path") };
        let Some((false, _, Some(handle))) = state.native_drops.info(path) else { return protocol_error(id, "unauthorized_scope", "Source was not supplied by native drop") };
        let Some(name) = Path::new(path).file_name().filter(|name| !name.as_bytes().contains(&b'\\')) else { return protocol_error(id, "invalid_args", "Invalid source name") };
        let name = name.to_os_string();
        if !names.insert(name.clone()) { return protocol_error(id, "invalid_args", "Duplicate source name") }
        let file = match state.resources.clone_open_file(&handle) {
            Ok(file) => file,
            Err(_) => return protocol_error(id, "unauthorized_scope", "Source grant expired"),
        };
        selected.push((name, file));
    }
    let mut uploaded = Vec::new(); let mut skipped = Vec::new(); let mut errors = Vec::new();
    for (name, mut source) in selected {
        let display = name.to_string_lossy().into_owned();
        let Ok(cname) = std::ffi::CString::new(name.as_bytes()) else { errors.push(json!({ "name": display, "error": "Invalid name" })); continue };
        let fd = unsafe { libc::openat(directory.as_raw_fd(), cname.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o666) };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::AlreadyExists { skipped.push(display); }
            else { errors.push(json!({ "name": display, "error": error.to_string() })); }
            continue;
        }
        let mut output = unsafe { std::fs::File::from_raw_fd(fd) };
        let result = source.seek(SeekFrom::Start(0)).and_then(|_| std::io::copy(&mut source, &mut output));
        match result {
            Ok(_) => uploaded.push(display),
            Err(error) => errors.push(json!({ "name": display, "error": format!("{error}; partial destination may remain") })), 
        }
    }
    protocol_ok(id, json!({ "status": if errors.is_empty() { 200 } else { 207 }, "data": { "uploaded": uploaded, "skipped": skipped, "errors": errors } }))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn dropped_sources_require_native_grant_and_never_replace_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src"); let dest = tmp.path().join("dest");
        std::fs::create_dir(&src).unwrap(); std::fs::create_dir(&dest).unwrap();
        let input = src.join("report.txt"); std::fs::write(&input, b"original").unwrap();
        let state = IpcHostState::new(); state.file_roots.lock().unwrap().add(&dest);
        let args = json!({ "destDirectory": dest, "sourcePaths": [input], "conflict": "skip" });
        assert_eq!(import_dropped(&state, "a", &args)["error"]["code"], "unauthorized_scope");
        state.native_drops.register(&state, &[input.clone()]);
        // A re-aimed source path cannot change the inode that was authorized.
        std::fs::remove_file(&input).unwrap(); std::fs::write(&input, b"replacement").unwrap();
        let result = import_dropped(&state, "b", &args);
        assert_eq!(result["data"]["data"]["uploaded"][0], "report.txt", "{result}");
        assert_eq!(std::fs::read(dest.join("report.txt")).unwrap(), b"original");
        let second = import_dropped(&state, "c", &args);
        assert_eq!(second["data"]["data"]["skipped"][0], "report.txt", "{second}");
        assert_eq!(std::fs::read(dest.join("report.txt")).unwrap(), b"original");
    }
}

#[cfg(not(unix))]
pub fn import_dropped(_state: &IpcHostState, id: &str, _args: &Value) -> Value {
    protocol_error(id, "not_supported", "Secure native imports are unavailable on this platform")
}
