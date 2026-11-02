//! Windows storage primitives for the management ledger. All paths below the
//! host-selected agent are pinned by non-delete-shared directory handles.
use std::{fs::{self, File, OpenOptions}, io, os::windows::{fs::{MetadataExt, OpenOptionsExt}, io::AsRawHandle}, path::{Component, Path, PathBuf}};
use windows_sys::Win32::{Foundation::{CloseHandle, LocalFree, GENERIC_ALL, GENERIC_WRITE}, Security::{ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, CreateWellKnownSid, DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation, GetTokenInformation, OWNER_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid}, Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT}, Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle}, System::Threading::{GetCurrentProcess, OpenProcessToken}};

fn err(message: &str) -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, message) }
struct Handle(windows_sys::Win32::Foundation::HANDLE);
impl Drop for Handle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
struct SecurityDescriptor(*mut core::ffi::c_void);
impl Drop for SecurityDescriptor { fn drop(&mut self) { unsafe { LocalFree(self.0); } } }

/// Fail closed on null DACL, unexpected ACE types, or write access by a SID
/// other than the current user, local SYSTEM or local administrators.
fn check_acl(file: &File, private: bool) -> io::Result<()> {
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 { return Err(io::Error::last_os_error()); }
        let token = Handle(token);
        let mut needed = 0;
        GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut needed);
        if needed == 0 || needed > 65536 { return Err(err("invalid process token")); }
        let mut data = vec![0usize; (needed as usize + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>()];
        if GetTokenInformation(token.0, TokenUser, data.as_mut_ptr().cast(), needed, &mut needed) == 0 { return Err(io::Error::last_os_error()); }
        let user = (*(data.as_ptr() as *const TOKEN_USER)).User.Sid;
        let mut system = [0u64; 16]; let mut admins = [0u64; 16];
        let mut system_size = std::mem::size_of_val(&system) as u32; let mut admin_size = std::mem::size_of_val(&admins) as u32;
        if CreateWellKnownSid(WinLocalSystemSid, std::ptr::null_mut(), system.as_mut_ptr().cast(), &mut system_size) == 0
            || CreateWellKnownSid(WinBuiltinAdministratorsSid, std::ptr::null_mut(), admins.as_mut_ptr().cast(), &mut admin_size) == 0 { return Err(io::Error::last_os_error()); }
        let system_sid = system.as_ptr().cast_mut().cast();
        let admins_sid = admins.as_ptr().cast_mut().cast();
        let trusted = |sid| EqualSid(sid, user) != 0 || EqualSid(sid, system_sid) != 0 || EqualSid(sid, admins_sid) != 0;
        let mut owner = std::ptr::null_mut(); let mut acl: *mut ACL = std::ptr::null_mut(); let mut descriptor = std::ptr::null_mut();
        let status = GetSecurityInfo(file.as_raw_handle().cast(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner, std::ptr::null_mut(), &mut acl, std::ptr::null_mut(), &mut descriptor);
        if status != 0 { return Err(io::Error::from_raw_os_error(status as i32)); }
        let _descriptor = SecurityDescriptor(descriptor);
        if owner.is_null() || acl.is_null() || !trusted(owner) { return Err(err("unsafe storage owner or DACL")); }
        let mut info: ACL_SIZE_INFORMATION = std::mem::zeroed();
        if GetAclInformation(acl, (&mut info as *mut ACL_SIZE_INFORMATION).cast(), std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation) == 0 || info.AceCount > 4096 { return Err(err("invalid storage DACL")); }
        for index in 0..info.AceCount {
            let mut raw = std::ptr::null_mut();
            if GetAce(acl, index, &mut raw) == 0 || raw.is_null() { return Err(err("invalid storage ACE")); }
            let header = &*(raw as *const ACE_HEADER);
            if header.AceType == 1 { continue; }
            if header.AceType != 0 || (header.AceSize as usize) < std::mem::size_of::<ACCESS_ALLOWED_ACE>() { return Err(err("unsupported storage ACE")); }
            let ace = &*(raw as *const ACCESS_ALLOWED_ACE);
            let write_mask = GENERIC_ALL | GENERIC_WRITE | 0x000f_0156 | if private { 0x8000_0089 } else { 0 };
            if ace.Mask & write_mask != 0 && !trusted((&ace.SidStart as *const u32).cast_mut().cast()) { return Err(err("untrusted storage writer")); }
        }
        Ok(())
    }
}

fn check_file(file: &File, directory: bool) -> io::Result<()> {
    let meta = file.metadata()?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || if directory { !meta.is_dir() } else { !meta.is_file() } { return Err(err("unsafe storage entry")); }
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } == 0 { return Err(io::Error::last_os_error()); }
    if (!directory && info.nNumberOfLinks != 1) || info.dwVolumeSerialNumber == 0 || (info.nFileIndexHigh == 0 && info.nFileIndexLow == 0) { return Err(err("unsafe storage identity")); }
    check_acl(file, !directory)
}
fn open_dir(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).open(path)?;
    let meta = file.metadata()?;
    if !meta.is_dir() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err(err("unsafe storage directory")); }
    Ok(file)
}

pub(crate) struct PinnedDirectory { pub path: PathBuf, pub directory: File, _ancestors: Vec<File> }
impl PinnedDirectory {
    pub fn open(agent: &Path, ledger: bool, create: bool) -> io::Result<Option<Self>> {
        if !agent.is_absolute() { return Err(io::ErrorKind::InvalidInput.into()); }
        let mut components = agent.components();
        let prefix = match components.next() { Some(Component::Prefix(v)) => v.as_os_str(), _ => return Err(io::ErrorKind::InvalidInput.into()) };
        if !matches!(components.next(), Some(Component::RootDir)) { return Err(io::ErrorKind::InvalidInput.into()); }
        let mut path = PathBuf::from(prefix); path.push("\\");
        let mut ancestors = vec![open_dir(&path)?];
        for part in components {
            match part { Component::Normal(name) => path.push(name), _ => return Err(io::ErrorKind::InvalidInput.into()) }
            ancestors.push(open_dir(&path)?);
        }
        check_file(ancestors.last().ok_or_else(|| err("missing agent root"))?, true)?;
        let names: &[&str] = if ledger { &["pi-web", "management-operations"] } else { &["pi-web"] };
        for name in names {
            path.push(name);
            if create {
                match fs::create_dir(&path) { Ok(()) => (), Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (), Err(e) => return Err(e) }
            }
            let dir = match open_dir(&path) { Ok(v) => v, Err(e) if !create && e.kind() == io::ErrorKind::NotFound => return Ok(None), Err(e) => return Err(e) };
            check_file(&dir, true)?; ancestors.push(dir);
        }
        let directory = ancestors.pop().ok_or_else(|| err("missing storage directory"))?;
        Ok(Some(Self { path, directory, _ancestors: ancestors }))
    }
    pub fn file(&self, name: &str, create: bool) -> io::Result<File> {
        if name.is_empty() || name.contains(['/', '\\', ':']) || name == "." || name == ".." { return Err(io::ErrorKind::InvalidInput.into()); }
        let mut options = OpenOptions::new(); options.read(true).share_mode(FILE_SHARE_READ).custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        if create { options.write(true).create_new(true); }
        let file = options.open(self.path.join(name))?; check_file(&file, false)?; Ok(file)
    }
    /// Publish a flushed same-directory file without cross-volume copy fallback.
    /// Microsoft documents WRITE_THROUGH flushing for copy-and-delete moves;
    /// this same-volume rename has no claimed directory-fsync or power-loss guarantee.
    pub fn publish(&self, source: &str, target: &str, replace: bool) -> io::Result<()> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let from: Vec<u16> = self.path.join(source).as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = self.path.join(target).as_os_str().encode_wide().chain(Some(0)).collect();
        let flags = MOVEFILE_WRITE_THROUGH | if replace { MOVEFILE_REPLACE_EXISTING } else { 0 };
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } == 0 { return Err(io::Error::last_os_error()); }
        Ok(())
    }
    pub fn transaction(&self) -> io::Result<File> { self.open_transaction(true) }
    pub fn existing_transaction(&self) -> io::Result<File> { self.open_transaction(false) }
    fn open_transaction(&self, create: bool) -> io::Result<File> {
        let base = if self.path.file_name().is_some_and(|name| name == "management-operations") { self.path.parent().ok_or_else(|| err("missing transaction directory"))? } else { &self.path };
        let file = OpenOptions::new().read(true).write(true).create(create).share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(base.join("management-transaction.lock"))?;
        check_file(&file, false)?; Ok(file)
    }
}
