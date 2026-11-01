//! Save a previously authorized resource through a host-owned native dialog.
use std::path::Path;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

const MAX_PENDING_SAVES: usize = 4;
static SAVE_GATE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

enum SaveSource {
    File(std::fs::File),
    Image(Arc<[u8]>),
}

fn source_for_handle(registry: &resource_protocol::ResourceRegistry, handle: &str) -> Result<SaveSource, String> {
    match registry.clone_open_file(handle) {
        Ok(file) => Ok(SaveSource::File(file)),
        Err(_) => registry.clone_image_bytes(handle).map(SaveSource::Image).map_err(|e| format!("{e:?}")),
    }
}

// try_clone() shares an open-file offset. Each save needs positional reads
// so simultaneous saves cannot consume each other's input or change its cursor.
#[cfg(unix)]
struct FileSnapshotReader {
    file: std::fs::File,
    offset: u64,
    remaining: u64,
}

#[cfg(unix)]
impl std::io::Read for FileSnapshotReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        use std::os::unix::fs::FileExt;
        let limit = self.remaining.min(buffer.len() as u64) as usize;
        if limit == 0 { return Ok(0); }
        let count = self.file.read_at(&mut buffer[..limit], self.offset)?;
        if count == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "Save source was truncated"));
        }
        self.offset += count as u64;
        self.remaining -= count as u64;
        Ok(count)
    }
}

#[cfg(unix)]
fn write_source(source: SaveSource, destination: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let parent = destination.parent().ok_or("Invalid save path")?.canonicalize().map_err(|e| e.to_string())?;
    let directory = crate::file_access::open_directory_beneath_root(Path::new("/"), &parent).map_err(|e| e.to_string())?;
    let name = destination.file_name().ok_or("Invalid save name")?;
    match source {
        SaveSource::File(file) => {
            let meta = file.metadata().map_err(|e| e.to_string())?;
            if !meta.is_file() { return Err("Source is not a regular file".into()); }
            let mut reader = FileSnapshotReader { file, offset: 0, remaining: meta.len() };
            crate::project_upload::atomic_replace_os(&directory, name, &mut reader, Some((meta.dev(), meta.ino()))).map_err(|e| e.to_string())
        }
        SaveSource::Image(bytes) => {
            crate::project_upload::atomic_replace_os(&directory, name, &mut bytes.as_ref(), None).map_err(|e| e.to_string())
        }
    }
}

fn save_selected(registry: &resource_protocol::ResourceRegistry, handle: &str, destination: Option<&Path>) -> Result<bool, String> {
    let Some(destination) = destination else { return Ok(false) };
    let source = source_for_handle(registry, handle)?;
    #[cfg(unix)]
    { write_source(source, destination)?; Ok(true) }
    #[cfg(not(unix))]
    { let _ = (source, destination); Err("Secure resource saving is not supported on this platform".into()) }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn save_refuses_symlink_and_same_inode_and_replaces_hardlinks_safely() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let outside = dir.path().join("outside");
        std::fs::write(&source, b"original").unwrap();
        std::fs::write(&outside, b"secret").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(write_source(SaveSource::File(std::fs::File::open(&source).unwrap()), &link).is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"secret");
        assert!(write_source(SaveSource::File(std::fs::File::open(&source).unwrap()), &source).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"original");
        let target = dir.path().join("hardlink");
        std::fs::hard_link(&outside, &target).unwrap();
        write_source(SaveSource::File(std::fs::File::open(&source).unwrap()), &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert_eq!(std::fs::read(&outside).unwrap(), b"secret");
    }

    #[test]
    fn saves_do_not_change_a_shared_source_cursor() {
        use std::io::{Seek, SeekFrom};
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        std::fs::write(&source, b"complete source content").unwrap();
        let mut original = std::fs::File::open(&source).unwrap();
        original.seek(SeekFrom::Start(7)).unwrap();
        std::thread::scope(|scope| {
            let mut workers = Vec::new();
            for i in 0..MAX_PENDING_SAVES {
                let clone = original.try_clone().unwrap();
                let target = dir.path().join(format!("saved-{i}"));
                workers.push(scope.spawn(move || {
                    write_source(SaveSource::File(clone), &target).unwrap();
                    assert_eq!(std::fs::read(target).unwrap(), b"complete source content");
                }));
            }
            for worker in workers { worker.join().unwrap(); }
        });
        assert_eq!(original.stream_position().unwrap(), 7);
    }

    #[test]
    fn image_grants_save_and_revoke_and_large_files_stream() {
        let registry = resource_protocol::ResourceRegistry::new();
        let image = registry.grant_image_bytes(vec![1,2,3], "image/png", Duration::from_secs(60)).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let dest = temp.path().join("image.png");
        assert!(!save_selected(&registry, &image, None).unwrap());
        assert!(!dest.exists());
        assert!(save_selected(&registry, &image, Some(&dest)).unwrap());
        assert_eq!(std::fs::read(&dest).unwrap(), [1,2,3]);
        assert!(registry.revoke(&image));
        assert!(source_for_handle(&registry, &image).is_err());
        let expired = registry.grant_image_bytes(vec![1], "image/png", Duration::ZERO).unwrap();
        assert!(source_for_handle(&registry, &expired).is_err());
        let big = temp.path().join("big.log");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(12 * 1024 * 1024).unwrap();
        let handle = registry.grant_open_file(std::fs::File::open(&big).unwrap(), &big, Duration::from_secs(60)).unwrap();
        let copy = temp.path().join("copy.log");
        write_source(source_for_handle(&registry, &handle).unwrap(), &copy).unwrap();
        assert_eq!(std::fs::metadata(copy).unwrap().len(), 12 * 1024 * 1024);
    }
}

#[tauri::command]
pub async fn save_resource_as(app: AppHandle, handle: String, default_file_name: String) -> Result<bool, String> {
    let permit = SAVE_GATE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(MAX_PENDING_SAVES)))
        .clone().try_acquire_owned().map_err(|_| "Too many pending save dialogs")?;
    let state = Arc::clone(&app.state::<Arc<crate::pi_ipc::IpcHostState>>());
    // Fail invalid or expired handles before opening the native dialog.
    drop(source_for_handle(&state.resources, &handle)?);
    let name = Path::new(&default_file_name).file_name().and_then(|s| s.to_str()).ok_or("Invalid file name")?.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let Some(selected) = app.dialog().file().set_file_name(&name).blocking_save_file() else { return Ok(false) };
        let destination = selected.into_path().map_err(|e| e.to_string())?;
        // A handle revoked or expired while the dialog was open cannot save.
        save_selected(&state.resources, &handle, Some(&destination))
    }).await.map_err(|e| e.to_string())?
}
