//! Host-private, persistent key for MCP credential-target fingerprints.
//! Neither canonical keys nor this secret are exposed over IPC or persisted in
//! the operation ledger. Loss of the key after ledger creation fails closed.
use std::path::Path;
use std::sync::Mutex;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

static KEY_LOCK: Mutex<()> = Mutex::new(());
pub struct ManagementTargetKey([u8; 32]);

impl ManagementTargetKey {
    #[cfg(target_os = "linux")]
    pub fn load_or_create(agent_dir: &Path) -> Result<Self, String> {
        use std::io::{Read, Write};
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
        let _guard = KEY_LOCK.lock().map_err(|_| "management key lock poisoned")?;
        let root = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(agent_dir).map_err(|e| format!("cannot open agent directory: {e}"))?;
        let base_path = format!("/proc/self/fd/{}/pi-web", root.as_raw_fd());
        match std::fs::DirBuilder::new().mode(0o700).create(&base_path) {
            Ok(()) => root.sync_all().map_err(|e| e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
            Err(e) => return Err(e.to_string()),
        }
        let base = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&base_path).map_err(|e| e.to_string())?;
        let meta = base.metadata().map_err(|e| e.to_string())?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 { return Err("unsafe management key directory".into()); }
        let path = format!("/proc/self/fd/{}/management-target-key.v1", base.as_raw_fd());
        let mut file = match std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let ledger = format!("/proc/self/fd/{}/management-operations", base.as_raw_fd());
                match std::fs::symlink_metadata(ledger) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
                    Err(e) => return Err(format!("cannot inspect management ledger: {e}")),
                    Ok(_) => return Err("management target key missing with existing ledger".into()),
                }
                let mut bytes = [0u8; 32];
                getrandom::fill(&mut bytes).map_err(|e| format!("cannot generate management key: {e}"))?;
                let mut new_file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&path).map_err(|e| format!("cannot create management key: {e}"))?;
                new_file.write_all(&bytes).and_then(|_| new_file.sync_all()).and_then(|_| base.sync_all()).map_err(|e| format!("cannot persist management key: {e}"))?;
                return Ok(Self(bytes));
            }
            Err(e) => return Err(format!("cannot open management key: {e}")),
        };
        let m = file.metadata().map_err(|e| e.to_string())?;
        if !m.is_file() || m.len() != 32 || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 || m.nlink() != 1 { return Err("unsafe or corrupt management target key".into()); }
        let mut bytes = [0u8; 32];
        file.read_exact(&mut bytes).map_err(|e| format!("cannot read management key: {e}"))?;
        Ok(Self(bytes))
    }
    #[cfg(windows)]
    pub fn load_or_create(agent_dir: &Path) -> Result<Self, String> {
        use std::io::{Read, Write};
        let _guard = KEY_LOCK.lock().map_err(|_| "management key lock poisoned")?;
        let base = crate::windows_storage::PinnedDirectory::open(agent_dir, false, true).map_err(|e| e.to_string())?.ok_or("management key directory missing")?;
        let _transaction = base.transaction().map_err(|e| format!("management transaction unavailable: {e}"))?;
        for entry in std::fs::read_dir(&base.path).map_err(|e| e.to_string())? {
            if entry.map_err(|e| e.to_string())?.file_name().to_string_lossy().starts_with(".management-target-key-") {
                return Err("unfinished management key publication".into());
            }
        }
        let mut file = match base.file("management-target-key.v1", false) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match std::fs::symlink_metadata(base.path.join("management-operations")) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                    Ok(_) => return Err("management target key missing with existing ledger".into()),
                    Err(error) => return Err(error.to_string()),
                }
                let mut bytes = [0u8; 32];
                getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
                let temporary = format!(".management-target-key-{}.tmp", uuid::Uuid::new_v4());
                let mut file = base.file(&temporary, true).map_err(|e| e.to_string())?;
                file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| format!("cannot persist management key: {e}"))?;
                drop(file);
                base.publish(&temporary, "management-target-key.v1", false).map_err(|e| format!("cannot publish management key: {e}"))?;
                return Ok(Self(bytes));
            }
            Err(error) => return Err(error.to_string()),
        };
        if file.metadata().map_err(|e| e.to_string())?.len() != 32 { return Err("unsafe or corrupt management target key".into()); }
        let mut bytes = [0; 32]; file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        Ok(Self(bytes))
    }
    #[cfg(target_os = "macos")]
    pub fn load_or_create(agent_dir: &Path) -> Result<Self, String> {
        let _guard = KEY_LOCK.lock().map_err(|_| "management key lock poisoned")?;
        let root = crate::darwin_storage::PinnedDirectory::root(agent_dir)?;
        let base = root.child("pi-web", false, true)?.ok_or("management key directory missing")?;
        let name = "management-target-key.v1";
        match base.read_record(name, 32)? {
            Some(bytes) => {
                if bytes.len() != 32 { return Err("unsafe or corrupt management target key".into()); }
                Ok(Self(bytes.try_into().map_err(|_| "unsafe or corrupt management target key")?))
            }
            None => {
                // Missing key beside existing evidence can never be regenerated:
                // the ledger's digests would stop matching.
                if base.exists("management-operations")? { return Err("management target key missing with existing ledger".into()); }
                let mut bytes = [0u8; 32];
                getrandom::fill(&mut bytes).map_err(|e| format!("cannot generate management key: {e}"))?;
                base.create_file(name, &bytes)?;
                base.sync()?;
                Ok(Self(bytes))
            }
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    pub fn load_or_create(_agent_dir: &Path) -> Result<Self, String> { Err("safe management target key is unavailable on this platform".into()) }

    /// Inspect an existing key without creating or changing anything.
    #[cfg(target_os = "linux")]
    pub fn inspect(agent_dir: &Path) -> Result<bool, String> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let root = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(agent_dir).map_err(|e| e.to_string())?;
        let base_path = format!("/proc/self/fd/{}/pi-web", root.as_raw_fd());
        let base = match std::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(base_path) {
            Ok(base) => base,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e.to_string()),
        };
        let m = base.metadata().map_err(|e| e.to_string())?;
        if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o022 != 0 { return Err("unsafe management key directory".into()); }
        let path = format!("/proc/self/fd/{}/management-target-key.v1", base.as_raw_fd());
        let file = match std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK).open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e.to_string()),
        };
        let m = file.metadata().map_err(|e| e.to_string())?;
        if !m.is_file() || m.len() != 32 || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 || m.nlink() != 1 { return Err("unsafe or corrupt management target key".into()); }
        Ok(true)
    }
    #[cfg(windows)]
    pub fn inspect(agent_dir: &Path) -> Result<bool, String> {
        let Some(base) = crate::windows_storage::PinnedDirectory::open(agent_dir, false, false).map_err(|e| e.to_string())? else { return Ok(false) };
        let file = match base.file("management-target-key.v1", false) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.to_string()),
        };
        if file.metadata().map_err(|e| e.to_string())?.len() != 32 { return Err("unsafe or corrupt management target key".into()); }
        Ok(true)
    }
    #[cfg(target_os = "macos")]
    pub fn inspect(agent_dir: &Path) -> Result<bool, String> {
        let root = crate::darwin_storage::PinnedDirectory::root(agent_dir)?;
        let Some(pi_web) = root.child("pi-web", false, false)? else { return Ok(false) };
        match pi_web.read_record("management-target-key.v1", 32)? {
            Some(bytes) if bytes.len() == 32 => Ok(true),
            Some(_) => Err("unsafe or corrupt management target key".into()),
            None => Ok(false),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    pub fn inspect(_agent_dir: &Path) -> Result<bool, String> { Err("safe management target key is unavailable on this platform".into()) }

    pub fn fingerprint(&self, canonical_key: &str) -> Result<String, String> {
        self.fingerprint_with_domain(b"pi-web:mcp-credential-target:v1\0", canonical_key)
    }

    pub fn fingerprint_legacy(&self, legacy_key: &str) -> Result<String, String> {
        self.fingerprint_with_domain(b"pi-web:mcp-credential-legacy:v1\0", legacy_key)
    }

    fn fingerprint_with_domain(&self, domain: &[u8], key: &str) -> Result<String, String> {
        if key.is_empty() || key.len() > 8192 { return Err("invalid MCP credential key".into()); }
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&self.0).map_err(|_| "invalid management key")?;
        mac.update(domain);
        mac.update(key.as_bytes());
        Ok(mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect())
    }
}
