//! A directory grant pins the authorized object, not just its pathname.
//!
//! Admission checks that the pathname still names the granted object. After
//! admission, operations must use the returned descriptor exclusively. A
//! concurrent rename after admission cannot be atomically excluded on Unix;
//! the operation may then affect the moved original, never a replacement.
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::{fs::File, io};

#[derive(Debug, Clone)]
pub(crate) struct PinnedRoot {
    path: PathBuf,
    selected_path: PathBuf,
    directory: Arc<File>,
    identity: (u64, u64),
}

fn open_path(path: &Path) -> io::Result<File> {
    let mut current = super::openat_directory_no_follow_by_path(Path::new("/"))?;
    for component in path.components() {
        match component {
            Component::RootDir => {},
            Component::Normal(name) => {
                let name = name.to_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "non-UTF8 directory"))?;
                current = super::openat_directory_no_follow(&current, name)?;
            }
            _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid root path")),
        }
    }
    Ok(current)
}

impl PinnedRoot {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid root path"));
        }
        let selected_path = path.to_path_buf();
        let path = std::fs::canonicalize(path)?;
        let directory = open_path(&path)?;
        let metadata = directory.metadata()?;
        Ok(Self { path, selected_path, directory: Arc::new(directory), identity: (metadata.dev(), metadata.ino()) })
    }

    /// Return the pinned object only if its current path binding still matches.
    pub(crate) fn admit(&self) -> io::Result<File> {
        if std::fs::canonicalize(&self.selected_path)? != self.path {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "authorized root path changed"));
        }
        let current = open_path(&self.path)?;
        let meta = current.metadata()?;
        if (meta.dev(), meta.ino()) != self.identity {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "authorized root was replaced"));
        }
        self.directory.try_clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd};

    #[test]
    fn admission_refuses_replaced_root_but_admitted_handle_stays_pinned() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let old = temp.path().join("old");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("value"), b"old").unwrap();
        let grant = PinnedRoot::open(&root).unwrap();
        let admitted = grant.admit().unwrap();
        std::fs::rename(&root, &old).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("value"), b"replacement").unwrap();
        assert!(grant.admit().is_err());
        let fd = unsafe { libc::openat(admitted.as_raw_fd(), c"value".as_ptr(), libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        assert!(fd >= 0);
        let mut file = unsafe { File::from_raw_fd(fd) };
        let mut value = String::new();
        file.read_to_string(&mut value).unwrap();
        assert_eq!(value, "old");
        file.write_all(b"!").unwrap();
        assert_eq!(std::fs::read(old.join("value")).unwrap(), b"old!");
        assert_eq!(std::fs::read(root.join("value")).unwrap(), b"replacement");
        let renewed = PinnedRoot::open(&root).unwrap();
        assert!(renewed.admit().is_ok());
        assert!(grant.admit().is_err());
    }

    #[test]
    fn admission_refuses_root_replaced_with_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let grant = PinnedRoot::open(&root).unwrap();
        std::fs::rename(&root, temp.path().join("old")).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();
        assert!(grant.admit().is_err());
    }
}
