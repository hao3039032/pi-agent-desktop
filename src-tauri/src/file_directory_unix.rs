//! Directory listing operations relative to an already-open directory.
use std::ffi::{CStr, CString, OsStr, OsString};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::PathBuf;

pub(crate) fn directory_entries(directory: &std::fs::File) -> std::io::Result<Vec<OsString>> {
    directory_entries_bounded(directory, usize::MAX).map(|(entries, _)| entries)
}

/// Limit materialized names, reporting whether another entry was present.
pub(crate) fn directory_entries_bounded(directory: &std::fs::File, limit: usize) -> std::io::Result<(Vec<OsString>, bool)> {
    directory_entries_path_bounded(directory, limit, usize::MAX, 0)
}

pub(crate) fn directory_entries_path_bounded(directory: &std::fs::File, limit: usize, byte_limit: usize, prefix_bytes: usize) -> std::io::Result<(Vec<OsString>, bool)> {
    // Open a new file description: dup() would share the directory cursor.
    let fd = unsafe { libc::openat(directory.as_raw_fd(), c".".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if fd < 0 { return Err(std::io::Error::last_os_error()); }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        let error = std::io::Error::last_os_error();
        unsafe { libc::close(fd); }
        return Err(error);
    }
    struct Dir(*mut libc::DIR);
    impl Drop for Dir { fn drop(&mut self) { unsafe { libc::closedir(self.0); } } }
    let stream = Dir(stream);
    let mut names = Vec::new();
    let mut bytes = 0usize;
    loop {
        unsafe { *errno() = 0; }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            let error = unsafe { *errno() };
            if error != 0 { return Err(std::io::Error::from_raw_os_error(error)); }
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name != b"." && name != b".." {
            let cost = prefix_bytes.saturating_add(String::from_utf8_lossy(name).len());
            if names.len() == limit || bytes.saturating_add(cost) > byte_limit { return Ok((names, true)); }
            bytes += cost;
            names.push(OsString::from_vec(name.to_vec()));
        }
    }
    Ok((names, false))
}

#[cfg(target_os = "linux")]
unsafe fn errno() -> *mut libc::c_int { libc::__errno_location() }
#[cfg(target_os = "macos")]
unsafe fn errno() -> *mut libc::c_int { libc::__error() }

pub(super) fn directory_entry_info(directory: &std::fs::File, name: &OsStr) -> Option<(bool, Option<PathBuf>)> {
    let name = CString::new(name.as_bytes()).ok()?;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(directory.as_raw_fd(), name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } != 0 { return None; }
    let kind = stat.st_mode & libc::S_IFMT;
    if kind != libc::S_IFLNK { return Some((kind == libc::S_IFDIR, None)); }
    // Open the target relative to the pinned parent. Its path is only a UI
    // hint; the later approval operation independently checks the link again.
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if fd < 0 { return Some((false, None)); }
    let target = unsafe { std::fs::File::from_raw_fd(fd) };
    Some((true, path_of_directory(&target)))
}

#[cfg(target_os = "linux")]
fn path_of_directory(directory: &std::fs::File) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/self/fd/{}", directory.as_raw_fd())).ok()
}
#[cfg(target_os = "macos")]
fn path_of_directory(directory: &std::fs::File) -> Option<PathBuf> {
    let mut path = [0 as libc::c_char; libc::PATH_MAX as usize];
    if unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_GETPATH, path.as_mut_ptr()) } < 0 { return None; }
    let bytes = unsafe { CStr::from_ptr(path.as_ptr()) }.to_bytes();
    Some(PathBuf::from(OsString::from_vec(bytes.to_vec())))
}

pub(crate) fn git_directory(command: &mut std::process::Command, directory: &std::fs::File) {
    use std::os::unix::process::CommandExt;
    let fd = directory.as_raw_fd();
    // The borrowed descriptor remains live until spawn returns. Only the
    // async-signal-safe fchdir call runs in the child before exec.
    unsafe { command.pre_exec(move || {
        if libc::fchdir(fd) == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
    }); }
}
