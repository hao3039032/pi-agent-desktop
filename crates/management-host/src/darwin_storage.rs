//! macOS storage primitives for the management target key and operation ledger.
//!
//! The Linux half of `ledger`/`target_key` reaches a pinned directory through
//! `/proc/self/fd/<fd>`; Darwin has no procfs, so the same "always relative to
//! the pinned descriptor" rule is expressed with `openat`/`mkdirat`/
//! `renameat`/`unlinkat` (through `rustix`). A path is resolved exactly once,
//! when the directory is opened: a later rename or symlink swap of an ancestor
//! cannot redirect a read, a create or a publish out of the pinned directory.
//!
//! Durability: every record is `fsync`ed and its directory `fsync`ed after the
//! rename, exactly like the Linux path. macOS `fsync` does not flush the
//! drive's write cache (`F_FULLFSYNC` would), so a power cut can still lose the
//! newest record. That is the same class of caveat as the Windows
//! `WRITE_THROUGH` publish: recorded as a limit, never claimed as POSIX
//! directory-fsync durability.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use rustix::fs::{mkdirat, openat, renameat, unlinkat, AtFlags, Dir, Mode, OFlags};

pub(crate) struct PinnedDirectory {
    pub directory: File,
    pub path: PathBuf,
}

fn directory_flags() -> OFlags { OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC }
/// Records and the key are opened without following a final symlink and
/// without blocking (a fifo swapped in must fail, not hang the host).
fn record_flags() -> OFlags { OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK }
fn create_flags() -> OFlags { OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC }
fn private_mode() -> Mode { Mode::from_bits_truncate(0o600) }

fn checked(directory: File, path: PathBuf, private: bool) -> Result<PinnedDirectory, String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = directory.metadata().map_err(|e| e.to_string())?;
    let forbidden = if private { 0o077 } else { 0o022 };
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & forbidden != 0 {
        return Err("unsafe ledger directory ownership or permissions".into());
    }
    Ok(PinnedDirectory { directory, path })
}

impl PinnedDirectory {
    /// The agent directory: opened once, no ownership policy of its own (the
    /// host owns it), exactly as the Linux `open()` treats its root.
    pub(crate) fn root(path: &Path) -> Result<Self, String> {
        let fd = openat(rustix::fs::CWD, path, directory_flags(), Mode::empty())
            .map_err(|e| format!("cannot open agent directory: {e}"))?;
        let directory: std::os::fd::OwnedFd = fd;
        Ok(Self { directory: File::from(directory), path: path.to_path_buf() })
    }

    /// A child directory, created (0700) when `create` is set. `None` means
    /// the directory does not exist and `create` was false; every other
    /// failure is an error, so a symlink or a replaced ancestor never reads as
    /// "no evidence".
    pub(crate) fn child(&self, name: &str, private: bool, create: bool) -> Result<Option<Self>, String> {
        if create {
            match mkdirat(&self.directory, name, Mode::from_bits_truncate(0o700)) {
                Ok(()) => self.sync()?,
                Err(rustix::io::Errno::EXIST) => {},
                Err(error) => return Err(format!("cannot create ledger directory: {error}")),
            }
        }
        match openat(&self.directory, name, directory_flags(), Mode::empty()) {
            Ok(fd) => {
                let directory: std::os::fd::OwnedFd = fd;
                let path = self.path.join(name);
                Ok(Some(checked(File::from(directory), path, private)?))
            }
            Err(rustix::io::Errno::NOENT) if !create => Ok(None),
            Err(error) => Err(format!("unsafe ledger directory: {error}")),
        }
    }

    pub(crate) fn sync(&self) -> Result<(), String> {
        self.directory.sync_all().map_err(|e| e.to_string())
    }

    /// Entry names, in directory order. `.` and `..` are never returned.
    pub(crate) fn names(&self) -> Result<Vec<String>, String> {
        let mut directory = Dir::read_from(&self.directory).map_err(|e| format!("cannot read management ledger: {e}"))?;
        let mut names = Vec::new();
        while let Some(entry) = directory.read() {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "." || name == ".." { continue }
            names.push(name);
        }
        Ok(names)
    }

    /// Read one regular, host-owned, singly-linked file of at most `cap` bytes.
    /// Validating here (not in the caller) keeps every ledger read on the same
    /// rule. `None` means the entry does not exist.
    pub(crate) fn read_record(&self, name: &str, cap: u64) -> Result<Option<Vec<u8>>, String> {
        use std::os::unix::fs::MetadataExt;
        let fd = match openat(&self.directory, name, record_flags(), Mode::empty()) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let directory: std::os::fd::OwnedFd = fd;
        let mut file = File::from(directory);
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > cap || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
            return Err("unsafe management ledger record".into());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file).take(cap + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > cap { return Err("management ledger record too large".into()); }
        Ok(Some(bytes))
    }

    /// Create a new 0600 file with `O_EXCL` (never replace or follow), write
    /// it and flush it. The caller syncs the directory once the set of files
    /// is final.
    pub(crate) fn create_file(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let fd = openat(&self.directory, name, create_flags(), private_mode()).map_err(|e| e.to_string())?;
        let owned: std::os::fd::OwnedFd = fd;
        let mut file = File::from(owned);
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| format!("cannot persist management record: {e}"))
    }

    /// Publish a temporary entry as `name`, replacing an existing one, then
    /// flush the directory. The temporary file is written and flushed first,
    /// so a reader never observes a partial record.
    pub(crate) fn publish(&self, temporary: &str, name: &str) -> Result<(), String> {
        renameat(&self.directory, temporary, &self.directory, name).map_err(|e| e.to_string())?;
        self.sync()
    }

    pub(crate) fn remove(&self, name: &str) -> Result<(), String> {
        unlinkat(&self.directory, name, AtFlags::empty()).map_err(|e| e.to_string())
    }

    /// Whether an entry exists, without following a final symlink.
    pub(crate) fn exists(&self, name: &str) -> Result<bool, String> {
        match rustix::fs::statat(&self.directory, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(_) => Ok(true),
            Err(rustix::io::Errno::NOENT) => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }
}
