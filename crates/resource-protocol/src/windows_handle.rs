//! Windows handle-relative traversal and independent file opens.
use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{NtCreateFile, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT};
use windows_sys::Win32::Foundation::{RtlNtStatusToDosError, UNICODE_STRING, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{ReOpenFile, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Win32::System::Kernel::OBJ_CASE_INSENSITIVE;

/// Open a single child under a host-authorized parent handle, never a path.
/// Open reparse points themselves and refuse them before using the handle.
pub fn open_child(parent: &std::fs::File, name: &OsStr, directory: bool) -> io::Result<std::fs::File> {
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

/// ReOpenFile opens the same underlying file, not its path, as a new synchronous
/// file open with its own file pointer. Unlike DuplicateHandle/try_clone,
/// seeking this handle cannot move the pointer shared by the original handles.
/// https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-reopenfile
/// https://learn.microsoft.com/windows/win32/fileio/file-pointers
pub fn reopen_file(file: &std::fs::File) -> io::Result<std::fs::File> {
    let meta = file.metadata()?;
    if !meta.is_file() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "not a regular file"));
    }
    let raw = unsafe { ReOpenFile(file.as_raw_handle() as isize, FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, FILE_FLAG_OPEN_REPARSE_POINT) };
    if raw == INVALID_HANDLE_VALUE { return Err(io::Error::last_os_error()); }
    Ok(unsafe { std::fs::File::from_raw_handle(raw as _) })
}
