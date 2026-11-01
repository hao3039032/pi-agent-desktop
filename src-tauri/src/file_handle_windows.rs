//! NT relative opens for a directory handle already authorized by the host.
//! Opening or authorizing the initial root is deliberately not done here.
use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{NtCreateFile, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT};
use windows_sys::Win32::Foundation::{RtlNtStatusToDosError, UNICODE_STRING};
use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Win32::System::Kernel::OBJ_CASE_INSENSITIVE;

/// Open exactly one child of a pinned, authorized directory. Reparse points
/// are opened themselves, inspected by handle, and refused before use.
pub(super) fn open_child(parent: &std::fs::File, name: &OsStr, directory: bool) -> io::Result<std::fs::File> {
    let parent_meta = parent.metadata()?;
    if !parent_meta.is_dir() || parent_meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "invalid parent handle"));
    }
    let mut wide: Vec<u16> = name.encode_wide().collect();
    if wide.is_empty() || wide.len() > (u16::MAX as usize / 2)
        || wide == [b'.' as u16] || wide == [b'.' as u16, b'.' as u16]
        || wide.iter().any(|&c| c == 0 || c == b'/' as u16 || c == b'\\' as u16 || c == b':' as u16)
    {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid child name"));
    }
    let bytes = (wide.len() * 2) as u16;
    let unicode = UNICODE_STRING { Length: bytes, MaximumLength: bytes, Buffer: wide.as_mut_ptr() };
    let attributes = OBJECT_ATTRIBUTES {
        Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle() as isize,
        ObjectName: &unicode,
        Attributes: OBJ_CASE_INSENSITIVE as u32,
        SecurityDescriptor: std::ptr::null(),
        SecurityQualityOfService: std::ptr::null(),
    };
    let mut result = 0;
    let mut status_block: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
    let options = FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT
        | if directory { FILE_DIRECTORY_FILE } else { FILE_NON_DIRECTORY_FILE };
    let status = unsafe { NtCreateFile(&mut result, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        &attributes, &mut status_block, std::ptr::null(), 0,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_OPEN, options, std::ptr::null(), 0) };
    if status < 0 { return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)); }
    let file = unsafe { std::fs::File::from_raw_handle(result as _) };
    let meta = file.metadata()?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || if directory { !meta.is_dir() } else { !meta.is_file() }
    {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "reparse point or unexpected file kind"));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT};

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
