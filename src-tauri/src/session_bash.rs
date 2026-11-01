//! Session-authorized bash spill files, opened beneath a pinned temp directory.
#[cfg(unix)]
use std::path::Path;

#[cfg(unix)]
pub struct PreparedBashOutput {
    directory: std::fs::File,
    name: std::ffi::CString,
}

#[cfg(unix)]
impl PreparedBashOutput {
    pub fn prepare(path: &str) -> Result<Self, &'static str> {
        Self::prepare_in_root(Path::new(path), &std::env::temp_dir())
    }

    fn prepare_in_root(path: &Path, root: &Path) -> Result<Self, &'static str> {
        if path.parent() != Some(root) { return Err("invalid bash output path"); }
        let name = path.file_name().and_then(|s| s.to_str()).ok_or("invalid bash output path")?;
        let body = name.strip_prefix("pi-bash-").and_then(|s| s.strip_suffix(".log")).filter(|s| !s.is_empty())
            .ok_or("invalid bash output path")?;
        if !body.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') { return Err("invalid bash output path"); }
        let canonical = root.canonicalize().map_err(|_| "temp directory unavailable")?;
        let directory = crate::file_access::open_directory_beneath_root(Path::new("/"), &canonical).map_err(|_| "temp directory unavailable")?;
        Ok(Self { directory, name: std::ffi::CString::new(name).map_err(|_| "invalid bash output path")? })
    }

    pub fn open(self) -> std::io::Result<std::fs::File> {
        use std::os::fd::{AsRawFd, FromRawFd};
        let fd = unsafe { libc::openat(self.directory.as_raw_fd(), self.name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK) };
        if fd < 0 { return Err(std::io::Error::last_os_error()); }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        if !file.metadata()?.is_file() { return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "not a regular file")); }
        Ok(file)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Read;
    #[test]
    fn pinned_temp_directory_resists_ancestor_swap() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("temp");
        let outside = base.path().join("outside");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(root.join("pi-bash-x.log"), b"authorized").unwrap();
        std::fs::write(outside.join("pi-bash-x.log"), b"outside").unwrap();
        let prepared = PreparedBashOutput::prepare_in_root(&root.join("pi-bash-x.log"), &root).unwrap();
        std::fs::rename(&root, base.path().join("old")).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();
        let mut text = String::new();
        prepared.open().unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, "authorized");
    }
}
