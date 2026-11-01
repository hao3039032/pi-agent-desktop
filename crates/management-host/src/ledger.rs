//! Durable evidence of management mutations whose outcome may be unknown.
//! This is a process-local admission fence, not a cross-process lock or a
//! recovery authority. Pending records are never expired automatically.
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::io::{Read, Write};
use serde_json::{json, Value};

const MAX_PENDING: usize = 128;
const MAX_RECORD_BYTES: u64 = 8192;
static LEDGER_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OperationScope { Global, Project { path: String } }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationTarget { Settings, Credentials, Packages, Mcp, Trust }

/// Digests of the trusted SDK-derived credential key and its legacy URL key.
/// URLs and names may contain credentials and are never persisted here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpCredentialTarget { primary_digest: String, legacy_digest: String }
impl McpCredentialTarget {
    pub fn new(primary_digest: String, legacy_digest: String) -> Result<Self, String> {
        let valid = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !valid(&primary_digest) || !valid(&legacy_digest) { return Err("invalid MCP credential target digest".into()); }
        Ok(Self { primary_digest, legacy_digest })
    }
    pub fn primary_digest(&self) -> &str { &self.primary_digest }
    pub fn legacy_digest(&self) -> &str { &self.legacy_digest }
    /// Legacy URL-only credential migration aliases names sharing that URL.
    pub fn conflicts(&self, other: &Self) -> bool {
        self.primary_digest == other.primary_digest || self.legacy_digest == other.legacy_digest
    }
}
/// Host-constructed, validated descriptor. It cannot carry raw arguments,
/// OAuth input, package URLs or credentials.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MutationDescriptor {
    operation: &'static str,
    scope: OperationScope,
    target: OperationTarget,
}
impl MutationDescriptor {
    pub fn new(operation: &str, scope: OperationScope) -> Result<Self, String> {
        let (operation, target) = operation_descriptor(operation).ok_or("unclassified management mutation")?;
        Ok(Self { operation, scope, target })
    }
    pub fn operation(&self) -> &'static str { self.operation }
    pub fn scope(&self) -> &OperationScope { &self.scope }
    pub fn target(&self) -> OperationTarget { self.target }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingOperation {
    pub operation_id: String,
    pub operation: String,
    pub scope: OperationScope,
    pub target: OperationTarget,
    pub created_at_ms: u64,
}

/// A directory pinned to the host's chosen agent directory. Opening and
/// enumerating do not authorize replay, repair or removal.
pub struct OperationLedger { directory: std::fs::File, path: PathBuf }

#[cfg(target_os = "linux")]
fn child_directory(parent: &std::fs::File, name: &str, private: bool, create: bool) -> Result<std::fs::File, String> {
    use std::os::unix::fs::{OpenOptionsExt, DirBuilderExt, MetadataExt};
    use std::os::fd::AsRawFd;
    let path = PathBuf::from(format!("/proc/self/fd/{}/{}", parent.as_raw_fd(), name));
    if create {
        match std::fs::DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => parent.sync_all().map_err(|e| e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {},
            Err(e) => return Err(format!("cannot create ledger directory: {e}")),
        }
    }
    let file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path).map_err(|e| format!("unsafe ledger directory: {e}"))?;
    let m = file.metadata().map_err(|e| e.to_string())?;
    if m.uid() != unsafe { libc::geteuid() } || m.mode() & if private { 0o077 } else { 0o022 } != 0 {
        return Err("unsafe ledger directory ownership or permissions".into());
    }
    Ok(file)
}

impl OperationLedger {
    #[cfg(target_os = "linux")]
    pub fn open(agent_dir: &Path) -> Result<Self, String> {
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::fd::AsRawFd;
        let root = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(agent_dir).map_err(|e| format!("cannot open agent directory: {e}"))?;
        let pi_web = child_directory(&root, "pi-web", false, true)?;
        let directory = child_directory(&pi_web, "management-operations", true, true)?;
        let path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
        Ok(Self { directory, path })
    }
    #[cfg(not(target_os = "linux"))]
    pub fn open(_agent_dir: &Path) -> Result<Self, String> { Err("safe management ledger is unavailable on this platform".into()) }

    /// Inspect existing evidence without creating directories or changing records.
    #[cfg(target_os = "linux")]
    pub fn inspect(agent_dir: &Path) -> Result<Vec<PendingOperation>, String> {
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::fd::AsRawFd;
        let root = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC).open(agent_dir).map_err(|e| e.to_string())?;
        for path in [agent_dir.join("pi-web"), agent_dir.join("pi-web/management-operations")] {
            match std::fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(e) => return Err(e.to_string()),
                Ok(m) if m.file_type().is_dir() => {},
                Ok(_) => return Err("unsafe management ledger directory".into()),
            }
        }
        let pi_web = child_directory(&root, "pi-web", false, false)?;
        let directory = child_directory(&pi_web, "management-operations", true, false)?;
        let path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
        Self { directory, path }.list_pending()
    }
    #[cfg(not(target_os = "linux"))]
    pub fn inspect(_agent_dir: &Path) -> Result<Vec<PendingOperation>, String> { Err("safe management ledger is unavailable on this platform".into()) }

    pub fn list_pending(&self) -> Result<Vec<PendingOperation>, String> {
        let _guard = LEDGER_LOCK.lock().map_err(|_| "ledger lock poisoned")?;
        Ok(self.read_records()?.into_iter().filter_map(|(record, pending)| pending.then_some(record)).collect())
    }

    #[cfg(target_os = "linux")]
    fn read_records(&self) -> Result<Vec<(PendingOperation, bool)>, String> {
        use std::os::unix::fs::{OpenOptionsExt, MetadataExt};
        let directory = self.directory.metadata().map_err(|e| e.to_string())?;
        if directory.uid() != unsafe { libc::geteuid() } || directory.mode() & 0o077 != 0 {
            return Err("unsafe ledger directory ownership or permissions".into());
        }
        let mut records = Vec::new();
        for entry in std::fs::read_dir(&self.path).map_err(|e| format!("cannot read management ledger: {e}"))? {
            if records.len() >= MAX_PENDING { return Err("management ledger capacity reached".into()); }
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().into_string().map_err(|_| "invalid ledger filename")?;
            let uuid = name.strip_suffix(".json").and_then(|s| uuid::Uuid::parse_str(s).ok()).ok_or("invalid ledger filename")?;
            if format!("{uuid}.json") != name { return Err("invalid ledger filename".into()); }
            let mut file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK).open(entry.path()).map_err(|e| e.to_string())?;
            let m = file.metadata().map_err(|e| e.to_string())?;
            if !m.is_file() || m.len() > MAX_RECORD_BYTES || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 || m.nlink() != 1 { return Err("unsafe management ledger record".into()); }
            let mut bytes = Vec::new(); std::io::Read::by_ref(&mut file).take(MAX_RECORD_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            if bytes.len() as u64 > MAX_RECORD_BYTES { return Err("management ledger record too large".into()); }
            let v: Value = serde_json::from_slice(&bytes).map_err(|_| "corrupt management ledger record")?;
            let obj = v.as_object().ok_or("corrupt management ledger record")?;
            let pending = match v["phase"].as_str() {
                Some("pending") if obj.len() == 7 => true,
                Some("succeeded") if obj.len() == 8 && v["completedAtMs"].as_u64().is_some() => false,
                _ => return Err("invalid management ledger phase".into()),
            };
            if v["version"] != 1 || v["operationId"] != uuid.to_string() { return Err("invalid management ledger record".into()); }
            let operation = v["operation"].as_str().ok_or("invalid operation")?;
            let target = target_for(operation).ok_or("unknown ledger operation")?;
            if v["target"] != target_name(target) { return Err("invalid ledger target".into()); }
            let scope = match v["scope"].as_str() { Some("global") => OperationScope::Global, Some(p) if p.starts_with('/') && p.len() <= 4096 => OperationScope::Project { path: p.to_string() }, _ => return Err("invalid ledger scope".into()) };
            let created_at_ms = v["createdAtMs"].as_u64().ok_or("invalid ledger timestamp")?;
            records.push((PendingOperation { operation_id: uuid.to_string(), operation: operation.into(), scope, target, created_at_ms }, pending));
        }
        Ok(records)
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn begin(&self, descriptor: &MutationDescriptor) -> Result<String, String> {
        use std::os::unix::fs::OpenOptionsExt;
        let _guard = LEDGER_LOCK.lock().map_err(|_| "ledger lock poisoned")?;
        let operation = descriptor.operation;
        let target = descriptor.target;
        let records = self.read_records()?;
        // All current management configuration mutations share the global
        // physical coordination slot; conservatively fence any pending scope.
        if records.iter().any(|(_, pending)| *pending) { return Err("management outcome unresolved; mutation not admitted".into()); }
        // Terminal success records are bounded by deleting only verified
        // completed entries before another admission; pending is never evicted.
        for (record, _) in records {
            std::fs::remove_file(self.path.join(format!("{}.json", record.operation_id))).map_err(|e| e.to_string())?;
        }
        self.directory.sync_all().map_err(|e| e.to_string())?;
        let scope_text = match &descriptor.scope { OperationScope::Global => "global", OperationScope::Project { path } if path.starts_with('/') && path.len() <= 4096 => path, _ => return Err("invalid management scope".into()) };
        let id = uuid::Uuid::new_v4().to_string();
        let timestamp: u64 = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis().try_into().map_err(|_| "timestamp overflow")?;
        let v = json!({"version":1,"operationId":id,"operation":operation,"scope":scope_text,"target":target_name(target),"phase":"pending","createdAtMs":timestamp});
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(self.path.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
        file.write_all(v.to_string().as_bytes()).and_then(|_| file.sync_all()).and_then(|_| self.directory.sync_all()).map_err(|e| format!("cannot persist management ledger: {e}"))?;
        Ok(id)
    }

    #[cfg(not(target_os = "linux"))]
    fn read_records(&self) -> Result<Vec<(PendingOperation, bool)>, String> { Err("safe management ledger is unavailable on this platform".into()) }
    #[cfg(not(target_os = "linux"))]
    pub(crate) fn begin(&self, _: &MutationDescriptor) -> Result<String, String> { Err("safe management ledger is unavailable on this platform".into()) }
    #[cfg(not(target_os = "linux"))]
    pub(crate) fn finish(&self, _: &str) -> Result<(), String> { Err("safe management ledger is unavailable on this platform".into()) }

    /// Only the live owner may finish a proven successful operation. There is
    /// intentionally no public recovery/clear entry point.
    #[cfg(target_os = "linux")]
    pub(crate) fn finish(&self, id: &str) -> Result<(), String> {
        let _guard = LEDGER_LOCK.lock().map_err(|_| "ledger lock poisoned")?;
        use std::os::unix::fs::OpenOptionsExt;
        let records = self.read_records()?;
        let record = records.into_iter().find(|(r, pending)| r.operation_id == id && *pending).map(|(r, _)| r).ok_or("management ledger operation missing")?;
        let scope = match &record.scope { OperationScope::Global => "global", OperationScope::Project { path } => path };
        let completed_at_ms: u64 = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis().try_into().map_err(|_| "timestamp overflow")?;
        let value = json!({"version":1,"operationId":record.operation_id,"operation":record.operation,"scope":scope,"target":target_name(record.target),"phase":"succeeded","createdAtMs":record.created_at_ms,"completedAtMs":completed_at_ms});
        let temp = self.path.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(&temp).map_err(|e| e.to_string())?;
        file.write_all(value.to_string().as_bytes()).and_then(|_| file.sync_all()).and_then(|_| std::fs::rename(&temp, self.path.join(format!("{id}.json")))).and_then(|_| self.directory.sync_all()).map_err(|e| e.to_string())
    }
}

fn target_name(target: OperationTarget) -> &'static str { match target { OperationTarget::Settings => "settings", OperationTarget::Credentials => "credentials", OperationTarget::Packages => "packages", OperationTarget::Mcp => "mcp", OperationTarget::Trust => "trust" } }
fn operation_descriptor(op: &str) -> Option<(&'static str, OperationTarget)> {
    let name = match op {
        "models.setDefault" => "models.setDefault", "models.enabledSet" => "models.enabledSet", "modelsConfig.put" => "modelsConfig.put", "terminal.settingsSet" => "terminal.settingsSet", "distro.configure" => "distro.configure", "distro.seed" => "distro.seed",
        "auth.apiKeyStore" => "auth.apiKeyStore", "auth.apiKeyDelete" => "auth.apiKeyDelete", "auth.logout" => "auth.logout", "auth.loginStart" => "auth.loginStart",
        "plugins.install" => "plugins.install", "plugins.remove" => "plugins.remove", "plugins.update" => "plugins.update", "plugins.setEnabled" => "plugins.setEnabled", "skills.install" => "skills.install", "skills.update" => "skills.update", "skills.setDisabled" => "skills.setDisabled",
        "mcp.configAction" => "mcp.configAction", "mcp.signInStart" => "mcp.signInStart", "trust.setFenced" => "trust.setFenced", "mcp.trustFolderAdd" => "mcp.trustFolderAdd",
        _ => return None,
    };
    Some((name, target_for(name)?))
}
pub(crate) fn target_for(op: &str) -> Option<OperationTarget> {
    Some(match op {
        "models.setDefault" | "models.enabledSet" | "modelsConfig.put" | "terminal.settingsSet" | "distro.configure" | "distro.seed" => OperationTarget::Settings,
        "auth.apiKeyStore" | "auth.apiKeyDelete" | "auth.logout" | "auth.loginStart" => OperationTarget::Credentials,
        "plugins.install" | "plugins.remove" | "plugins.update" | "plugins.setEnabled" | "skills.install" | "skills.update" | "skills.setDisabled" => OperationTarget::Packages,
        "mcp.configAction" | "mcp.signInStart" => OperationTarget::Mcp,
        "trust.setFenced" | "mcp.trustFolderAdd" => OperationTarget::Trust,
        _ => return None,
    })
}
