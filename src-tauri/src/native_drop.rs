//! Native drag events, not frontend path strings, authorize import sources.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use crate::pi_ipc::IpcHostState;

struct Item { handle: Option<String>, size: u64, directory: bool, expires: Instant }
#[derive(Default)]
pub struct NativeDrops { items: Mutex<HashMap<String, Item>> }

impl NativeDrops {
    #[cfg(unix)]
    pub fn register(&self, state: &IpcHostState, paths: &[PathBuf]) {
        let mut items = self.items.lock().unwrap();
        for (_, item) in items.drain() { if let Some(handle) = item.handle { state.resources.revoke(&handle); } }
        for path in paths.iter().take(crate::file_resources::MAX_PATHS) {
            if !path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) { continue; }
            let Ok(meta) = std::fs::symlink_metadata(path) else { continue };
            if meta.file_type().is_symlink() { continue; }
            let directory = meta.is_dir();
            let mut size = meta.len();
            let handle = if meta.is_file() {
                let Ok(file) = crate::file_access::open_file_beneath_root(Path::new("/"), path) else { continue };
                let Ok(pinned) = file.metadata() else { continue };
                size = pinned.len();
                let Ok(handle) = state.resources.grant_open_file(file, path, Duration::from_secs(600)) else { continue };
                Some(handle)
            } else if directory {
                if crate::file_access::open_directory_beneath_root(Path::new("/"), path).is_err() { continue; }
                None
            } else { continue };
            items.insert(path.to_string_lossy().into_owned(), Item { handle, size, directory, expires: Instant::now() + Duration::from_secs(600) });
        }
    }
    #[cfg(not(unix))]
    pub fn register(&self, _state: &IpcHostState, _paths: &[PathBuf]) {}

    pub fn info(&self, path: &str) -> Option<(bool, u64, Option<String>)> {
        let mut items = self.items.lock().unwrap();
        items.retain(|_, item| item.expires > Instant::now());
        let item = items.get(path)?;
        Some((item.directory, item.size, item.handle.clone()))
    }
}
