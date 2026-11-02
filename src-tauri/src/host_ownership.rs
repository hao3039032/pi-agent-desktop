//! Cooperative host exclusion only. This lock does not cover legacy hosts,
//! external CLI processes, or children which do not explicitly hold it.
//! It is not authorization for deletion, recovery, or scheduler takeover.
use std::io;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OwnershipMode {
    Runtime,
    Maintenance,
}

/// Retain this value for the entire host or maintenance operation. The lock
/// file is never unlinked: replacing a locked inode would split ownership.
pub(crate) struct HostOwnership {
    _file: std::fs::File,
    #[cfg(windows)]
    _directories: Vec<std::fs::File>,
    mode: OwnershipMode,
}

impl HostOwnership {
    #[cfg(unix)]
    pub(crate) fn acquire(agent: &Path, mode: OwnershipMode) -> io::Result<Self> {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

        // The caller supplies the selected agent directory, never an IPC path.
        // Directory-relative opens avoid following a replaced pi-web symlink.
        let root = std::fs::OpenOptions::new().read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(agent)?;
        let name = c"pi-web";
        if unsafe { libc::mkdirat(root.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::AlreadyExists { return Err(error); }
        }
        let fd = unsafe { libc::openat(root.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(io::Error::last_os_error()); }
        let directory = unsafe { std::fs::File::from_raw_fd(fd) };
        if directory.metadata()?.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::other("unsafe host ownership directory"));
        }
        let fd = unsafe { libc::openat(directory.as_raw_fd(), c"host-ownership.lock".as_ptr(), libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) };
        if fd < 0 { return Err(io::Error::last_os_error()); }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::other("unsafe host ownership lock"));
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { _file: file, mode })
    }

    #[cfg(windows)]
    pub(crate) fn acquire(agent: &Path, mode: OwnershipMode) -> io::Result<Self> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use std::os::windows::io::AsRawHandle;
        use std::path::{Component, PathBuf};
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        if !agent.is_absolute() { return Err(io::ErrorKind::InvalidInput.into()); }
        let mut components = agent.components();
        let prefix = match components.next() { Some(Component::Prefix(prefix)) => prefix.as_os_str(), _ => return Err(io::ErrorKind::InvalidInput.into()) };
        if !matches!(components.next(), Some(Component::RootDir)) { return Err(io::ErrorKind::InvalidInput.into()); }
        let mut path = PathBuf::from(prefix);
        path.push("\\");
        let open_directory = |path: &Path| -> io::Result<std::fs::File> {
            let file = std::fs::OpenOptions::new().read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(path)?;
            let meta = file.metadata()?;
            if !meta.is_dir() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(io::Error::new(io::ErrorKind::PermissionDenied, "unsafe ownership directory"));
            }
            Ok(file)
        };
        let mut directories = vec![open_directory(&path)?];
        for component in components {
            match component { Component::Normal(name) => path.push(name), _ => return Err(io::ErrorKind::InvalidInput.into()) }
            directories.push(open_directory(&path)?);
        }
        path.push("pi-web");
        match std::fs::create_dir(&path) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
        directories.push(open_directory(&path)?);
        path.push("host-ownership.lock");
        let file = std::fs::OpenOptions::new().read(true).write(true).create(true)
            .share_mode(0).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(&path)?;
        let metadata = file.metadata()?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || unsafe { GetFileInformationByHandle(file.as_raw_handle() as isize, &mut info) } == 0
            || info.nNumberOfLinks != 1 || info.dwVolumeSerialNumber == 0 || (info.nFileIndexHigh == 0 && info.nFileIndexLow == 0) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "unsafe ownership lock"));
        }
        Ok(Self { _file: file, _directories: directories, mode })
    }

    #[cfg(not(any(unix, windows)))]
    pub(crate) fn acquire(_agent: &Path, _mode: OwnershipMode) -> io::Result<Self> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "host ownership is unavailable on this platform"))
    }

    pub(crate) fn mode(&self) -> OwnershipMode { self.mode }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn ownership_is_exclusive_and_keeps_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = HostOwnership::acquire(dir.path(), OwnershipMode::Runtime).unwrap();
        assert!(HostOwnership::acquire(dir.path(), OwnershipMode::Runtime).is_err());
        assert!(HostOwnership::acquire(dir.path(), OwnershipMode::Maintenance).is_err());
        assert!(dir.path().join("pi-web/host-ownership.lock").exists());
        drop(first);
        assert!(HostOwnership::acquire(dir.path(), OwnershipMode::Runtime).is_ok());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::io::{BufRead, BufReader};

    #[test]
    fn ownership_child() {
        let Some(path) = std::env::var_os("PI_TEST_OWNERSHIP_DIR") else { return };
        let _held = HostOwnership::acquire(Path::new(&path), OwnershipMode::Runtime).unwrap();
        println!("ownership-held");
        use std::io::Write;
        std::io::stdout().flush().unwrap();
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
    }

    #[test]
    fn cooperative_hosts_exclude_until_real_holder_exit() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "host_ownership::tests::ownership_child", "--nocapture"])
            .env("PI_TEST_OWNERSHIP_DIR", dir.path())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        while !line.contains("ownership-held") {
            line.clear();
            assert_ne!(output.read_line(&mut line).unwrap(), 0, "child exited before acquiring lock");
        }
        assert!(HostOwnership::acquire(dir.path(), OwnershipMode::Runtime).is_err());
        assert!(HostOwnership::acquire(dir.path(), OwnershipMode::Maintenance).is_err());
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        let maintenance = HostOwnership::acquire(dir.path(), OwnershipMode::Maintenance).unwrap();
        assert_eq!(maintenance.mode(), OwnershipMode::Maintenance);
        assert!(HostOwnership::acquire(dir.path(), OwnershipMode::Runtime).is_err());
        drop(maintenance);
        assert!(HostOwnership::acquire(dir.path(), OwnershipMode::Runtime).is_ok());
    }

    #[test]
    fn killed_holder_releases_kernel_lock_without_removing_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "host_ownership::tests::ownership_child", "--nocapture"])
            .env("PI_TEST_OWNERSHIP_DIR", dir.path())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        while !line.contains("ownership-held") {
            line.clear();
            assert_ne!(output.read_line(&mut line).unwrap(), 0);
        }
        assert!(HostOwnership::acquire(dir.path(), OwnershipMode::Maintenance).is_err());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(dir.path().join("pi-web/host-ownership.lock").exists());
        assert!(HostOwnership::acquire(dir.path(), OwnershipMode::Maintenance).is_ok());
    }

    #[test]
    fn unsafe_lock_entries_are_rejected() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("pi-web")).unwrap();
        let target = dir.path().join("target");
        std::fs::write(&target, b"untouched").unwrap();
        symlink(&target, dir.path().join("pi-web/host-ownership.lock")).unwrap();
        assert!(HostOwnership::acquire(dir.path(), OwnershipMode::Runtime).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"untouched");
    }
}
