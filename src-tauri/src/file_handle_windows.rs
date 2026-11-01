//! NT relative opens for a directory handle already authorized by the host.
//! Opening or authorizing the initial root is deliberately not done here.
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
pub(crate) use resource_protocol::windows_handle::open_child;
use windows_sys::Win32::Storage::FileSystem::{FILE_ID_INFO, FileIdInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE};

#[derive(Debug, Clone)]
pub(super) struct PinnedRoot {
    selected: PathBuf,
    canonical: PathBuf,
    handle: Arc<std::fs::File>,
    identity: (u64, [u8; 16]),
}

fn identity(file: &std::fs::File) -> io::Result<(u64, [u8; 16])> {
    let mut info: FILE_ID_INFO = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandleEx(file.as_raw_handle() as isize, FileIdInfo, (&mut info as *mut FILE_ID_INFO).cast(), std::mem::size_of::<FILE_ID_INFO>() as u32) } == 0 { return Err(io::Error::last_os_error()); }
    if info.VolumeSerialNumber == 0 || info.FileId.Identifier == [0; 16] {
        return Err(io::Error::new(io::ErrorKind::Unsupported, "filesystem does not provide stable file identity"));
    }
    Ok((info.VolumeSerialNumber, info.FileId.Identifier))
}

fn open_absolute(path: &Path) -> io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    let mut components = path.components();
    let prefix = match components.next() { Some(Component::Prefix(p)) => p.as_os_str(), _ => return Err(io::ErrorKind::InvalidInput.into()) };
    if !matches!(components.next(), Some(Component::RootDir)) { return Err(io::ErrorKind::InvalidInput.into()); }
    let mut anchor = PathBuf::from(prefix);
    anchor.push("\\");
    let mut current = std::fs::OpenOptions::new().read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(anchor)?;
    if !current.metadata()?.is_dir() || current.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "invalid volume root"));
    }
    for component in components {
        match component { Component::Normal(name) => current = open_child(&current, name, true)?, _ => return Err(io::ErrorKind::InvalidInput.into()) }
    }
    Ok(current)
}

impl PinnedRoot {
    pub(super) fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) { return Err(io::ErrorKind::InvalidInput.into()); }
        let canonical = std::fs::canonicalize(path)?;
        let handle = open_absolute(&canonical)?;
        let identity = identity(&handle)?;
        Ok(Self { selected: path.to_owned(), canonical, handle: Arc::new(handle), identity })
    }
    pub(super) fn path(&self) -> &Path { &self.canonical }
    pub(super) fn admit(&self) -> io::Result<std::fs::File> {
        let current_path = std::fs::canonicalize(&self.selected)?;
        if !same_path(&current_path, &self.canonical) { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "root path changed")); }
        let current = open_absolute(&current_path)?;
        if identity(&current)? != self.identity { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "authorized root replaced")); }
        self.handle.try_clone()
    }
}

pub(super) fn same_text(a: &str, b: &str) -> bool {
    use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
    if a == b { return true; }
    if a.is_empty() || b.is_empty() { return false; }
    let a: Vec<u16> = a.encode_utf16().collect();
    let b: Vec<u16> = b.encode_utf16().collect();
    if a.len() > i32::MAX as usize || b.len() > i32::MAX as usize { return false; }
    unsafe { CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1) == CSTR_EQUAL }
}
fn same_path(a: &Path, b: &Path) -> bool {
    match (super::normalize_absolute(a), super::normalize_absolute(b)) {
        (Some(a), Some(b)) => same_text(&a, &b), _ => false,
    }
}

/// Enumerate a new handle to the same directory object, never a pathname.
pub(crate) fn entries(directory: &std::fs::File) -> io::Result<Vec<(OsString, bool, bool)>> {
    use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{ReOpenFile, GetFileInformationByHandleEx, FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, FILE_ID_BOTH_DIR_INFO, FILE_ATTRIBUTE_DIRECTORY};
    let handle = unsafe { ReOpenFile(directory.as_raw_handle() as isize, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT) };
    if handle == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
    let file = unsafe { std::fs::File::from_raw_handle(handle as _) };
    let mut buffer = vec![0u64; 8192];
    let bytes = buffer.len() * std::mem::size_of::<u64>();
    let name_offset = std::mem::offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
    let mut first = true;
    let mut output = Vec::new();
    loop {
        let kind = if first { FileIdBothDirectoryRestartInfo } else { FileIdBothDirectoryInfo };
        first = false;
        if unsafe { GetFileInformationByHandleEx(file.as_raw_handle() as isize, kind, buffer.as_mut_ptr().cast(), bytes as u32) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) { break; }
            return Err(error);
        }
        let mut offset = 0usize;
        loop {
            if offset + std::mem::size_of::<FILE_ID_BOTH_DIR_INFO>() > bytes { return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid directory record")); }
            let base = unsafe { (buffer.as_ptr() as *const u8).add(offset) };
            let record = unsafe { std::ptr::read_unaligned(base.cast::<FILE_ID_BOTH_DIR_INFO>()) };
            let length = record.FileNameLength as usize;
            let end = offset.checked_add(name_offset).and_then(|v| v.checked_add(length)).ok_or(io::ErrorKind::InvalidData)?;
            if length % 2 != 0 || end > bytes || (record.NextEntryOffset != 0 && offset.checked_add(record.NextEntryOffset as usize).map_or(true, |next| end > next)) {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid directory name"));
            }
            let units: Vec<u16> = (0..length / 2).map(|i| unsafe { std::ptr::read_unaligned(base.add(name_offset + i * 2).cast::<u16>()) }).collect();
            let name = OsString::from_wide(&units);
            if name != "." && name != ".." {
                if output.len() >= 50_000 { return Err(io::Error::new(io::ErrorKind::OutOfMemory, "directory entry limit exceeded")); }
                output.push((name, record.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0, record.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0));
            }
            if record.NextEntryOffset == 0 { break; }
            let next = record.NextEntryOffset as usize;
            let next_offset = offset.checked_add(next).ok_or(io::ErrorKind::InvalidData)?;
            if next < name_offset || next_offset >= bytes { return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid directory offset")); }
            offset = next_offset;
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};

    #[test]
    fn allowed_roots_read_index_and_reauthorization_use_pinned_objects() {
        use std::io::Read;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let old = temp.path().join("old");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("文件.txt"), b"old").unwrap();
        let state = crate::pi_ipc::IpcHostState::new();
        state.file_roots.lock().unwrap().add(&root).unwrap();
        let mut pinned = state.file_roots.lock().unwrap().open_file(&root.join("文件.txt")).unwrap();
        let request = |op: &str, args: serde_json::Value| crate::pi_ipc::dispatch_envelope(&state, serde_json::json!({"v":1,"id":"fixture","op":op,"args":args}));
        let read = request("files.read", serde_json::json!({"path": root.join("文件.txt")}));
        assert_eq!(read["ok"], true, "{read}");
        let index = crate::file_resources::handle_files_index(&state, "fixture", &serde_json::json!({"cwd":root}));
        assert_eq!(index["ok"], true, "{index}");
        assert!(index["data"]["files"].as_array().unwrap().iter().any(|name| name == "文件.txt"));
        let mixed_case = root.to_string_lossy().to_uppercase();
        assert!(state.file_roots.lock().unwrap().open_file(&Path::new(&mixed_case).join("文件.txt")).is_ok());
        std::fs::rename(&root, &old).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("文件.txt"), b"replacement").unwrap();
        assert!(state.file_roots.lock().unwrap().add(&root).is_err());
        assert!(state.file_roots.lock().unwrap().open_file(&root.join("文件.txt")).is_err());
        assert_eq!(request("files.read", serde_json::json!({"path": root.join("文件.txt")}))["ok"], false);
        let mut content = String::new();
        pinned.read_to_string(&mut content).unwrap();
        assert_eq!(content, "old");
        state.file_roots.lock().unwrap().reauthorize(&root).unwrap();
        assert!(state.file_roots.lock().unwrap().open_file(&root.join("文件.txt")).is_ok());
    }

    #[test]
    fn resource_grants_read_files_and_preview_assets_from_authorized_handles() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join("page.html"), b"0123456789").unwrap();
        std::fs::write(project.join("style.css"), b"body{}").unwrap();
        let state = crate::pi_ipc::IpcHostState::new();
        state.file_roots.lock().unwrap().add(&project).unwrap();
        let call = |op: &str, args: serde_json::Value| crate::pi_ipc::dispatch_envelope(&state, serde_json::json!({"v":1,"id":"fixture","op":op,"args":args}));
        let file = call("resources.grantFile", serde_json::json!({"path":project.join("page.html")}));
        assert_eq!(file["ok"], true, "{file}");
        let handle = file["data"]["handle"].as_str().unwrap();
        let read = call("resources.read", serde_json::json!({"handle":handle,"start":2,"end":4}));
        assert_eq!(read["data"]["data"], "MjM0", "{read}");
        let preview = call("resources.grantPreview", serde_json::json!({"path":project.join("page.html")}));
        assert_eq!(preview["ok"], true, "{preview}");
        let handle = preview["data"]["handle"].as_str().unwrap();
        let css = call("resources.read", serde_json::json!({"handle":handle,"subpath":"style.css"}));
        assert_eq!(css["data"]["data"], "Ym9keXt9", "{css}");
        assert_eq!(call("resources.read", serde_json::json!({"handle":handle,"subpath":"../outside"}))["ok"], false);
        assert_eq!(call("resources.revoke", serde_json::json!({"handle":handle}))["data"]["revoked"], true);
        assert_eq!(call("resources.read", serde_json::json!({"handle":handle,"subpath":"style.css"}))["ok"], false);
    }

    #[test]
    fn unc_root_and_case_use_handle_walk_when_fixture_share_is_available() {
        let Some(share) = std::env::var_os("PI_WINDOWS_UNC_FIXTURE_ROOT") else {
            eprintln!("SKIP UNC fixture: PI_WINDOWS_UNC_FIXTURE_ROOT not configured");
            return;
        };
        let share = PathBuf::from(share);
        assert!(share.to_string_lossy().starts_with("\\\\"), "fixture root must be a UNC share");
        let temp = tempfile::Builder::new().prefix("pi-m5-fixture-").tempdir_in(&share).unwrap();
        std::fs::write(temp.path().join("文件.txt"), b"fixture").unwrap();
        let mut roots = super::super::AllowedRoots::new();
        roots.add(temp.path()).unwrap();
        let mut file = roots.open_file(&temp.path().join("文件.txt")).unwrap();
        let mut data = String::new();
        std::io::Read::read_to_string(&mut file, &mut data).unwrap();
        assert_eq!(data, "fixture");
    }

    #[test]
    fn relative_open_refuses_file_reparse_point() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        std::fs::create_dir(&root).unwrap();
        let outside = temp.path().join("outside");
        std::fs::write(&outside, b"secret").unwrap();
        if let Err(error) = std::os::windows::fs::symlink_file(&outside, root.join("link")) {
            eprintln!("SKIP symlink fixture: {error}");
            return;
        }
        let parent = std::fs::OpenOptions::new().read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(&root).unwrap();
        assert!(open_child(&parent, OsStr::new("link"), false).is_err());
    }

    #[test]
    fn relative_open_pins_directory_and_refuses_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("value"), b"inside").unwrap();
        let parent = std::fs::OpenOptions::new().read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(&root).unwrap();
        std::fs::rename(&root, temp.path().join("old")).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("value"), b"outside").unwrap();
        let mut file = open_child(&parent, OsStr::new("value"), false).unwrap();
        let mut data = String::new();
        std::io::Read::read_to_string(&mut file, &mut data).unwrap();
        assert_eq!(data, "inside");
        for name in ["..", "../value", "value:stream", "\\value"] {
            assert!(open_child(&parent, OsStr::new(name), false).is_err());
        }
    }
}
