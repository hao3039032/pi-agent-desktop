//! Save a previously authorized resource through a host-owned native dialog.
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

#[cfg(unix)]
fn write_pinned_file(mut source: std::fs::File, destination: &Path) -> Result<(), String> {
    use std::io::{Seek, SeekFrom};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::MetadataExt;
    let parent = destination.parent().ok_or("Invalid save path")?.canonicalize().map_err(|e| e.to_string())?;
    let directory = crate::file_access::open_directory_beneath_root(Path::new("/"), &parent).map_err(|e| e.to_string())?;
    let name = destination.file_name().ok_or("Invalid save name")?;
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| "Invalid save name")?;
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK, 0o666) };
    if fd < 0 { return Err(std::io::Error::last_os_error().to_string()); }
    let mut output = unsafe { std::fs::File::from_raw_fd(fd) };
    let source_meta = source.metadata().map_err(|e| e.to_string())?;
    let dest_meta = output.metadata().map_err(|e| e.to_string())?;
    if !dest_meta.is_file() { return Err("Save destination is not a regular file".into()); }
    if source_meta.dev() == dest_meta.dev() && source_meta.ino() == dest_meta.ino() { return Err("Source and destination are the same file".into()); }
    source.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    output.set_len(0).map_err(|e| e.to_string())?;
    std::io::copy(&mut source, &mut output).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn save_refuses_symlink_and_same_inode_without_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let outside = dir.path().join("outside");
        std::fs::write(&source, b"original").unwrap();
        std::fs::write(&outside, b"secret").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(write_pinned_file(std::fs::File::open(&source).unwrap(), &link).is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"secret");
        assert!(write_pinned_file(std::fs::File::open(&source).unwrap(), &source).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        let destination = dir.path().join("saved");
        write_pinned_file(std::fs::File::open(&source).unwrap(), &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
    }
}

#[tauri::command]
pub async fn save_resource_as(app: AppHandle, handle: String, default_file_name: String) -> Result<bool, String> {
    let source = app.state::<Arc<crate::pi_ipc::IpcHostState>>().resources.clone_open_file(&handle).map_err(|e| format!("{e:?}"))?;
    let name = Path::new(&default_file_name).file_name().and_then(|s| s.to_str()).ok_or("Invalid file name")?.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = app.dialog().file().set_file_name(&name).blocking_save_file() else { return Ok(false) };
        let destination = selected.into_path().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        { write_pinned_file(source, &destination)?; Ok(true) }
        #[cfg(not(unix))]
        { let _ = (source, destination); Err("Secure resource saving is not supported on this platform".into()) }
    }).await.map_err(|e| e.to_string())?
}
