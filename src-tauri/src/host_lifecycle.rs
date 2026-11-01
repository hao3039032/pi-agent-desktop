//! Static bootstrap lifecycle. Cooperative ownership is not writer proof and
//! never authorizes deletion, journal replay, seed, or scheduler startup.
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::Serialize;
use crate::host_ownership::{HostOwnership, OwnershipMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingState { Clear, Pending, Uninspectable }

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    pub trust_policy: PendingState,
    pub session_writers: PendingState,
    pub deletion_journal: PendingState,
    pub management_operations: PendingState,
}

impl RecoveryStatus {
    pub fn is_clear(&self) -> bool {
        self.trust_policy == PendingState::Clear && self.session_writers == PendingState::Clear
            && self.deletion_journal == PendingState::Clear && self.management_operations == PendingState::Clear
    }
}

fn directory_pending(path: &Path) -> PendingState {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => PendingState::Clear,
        Err(_) => PendingState::Uninspectable,
        Ok(meta) if !meta.file_type().is_dir() => PendingState::Uninspectable,
        Ok(_) => match std::fs::read_dir(path).and_then(|mut entries| entries.next().transpose()) {
            Ok(None) => PendingState::Clear,
            Ok(Some(_)) => PendingState::Pending,
            Err(_) => PendingState::Uninspectable,
        },
    }
}

/// Diagnostic only: no marker or journal is opened for mutation or removed.
pub fn recovery_status(agent: &Path) -> RecoveryStatus {
    let base = agent.join("pi-web");
    let base_safe = match std::fs::symlink_metadata(&base) {
        Ok(meta) => meta.file_type().is_dir(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    };
    let trust = if !base_safe { PendingState::Uninspectable } else {
        match std::fs::symlink_metadata(base.join("trust-policy-pending.json")) {
            Ok(_) => PendingState::Pending,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => PendingState::Clear,
            Err(_) => PendingState::Uninspectable,
        }
    };
    let writers = if base_safe { directory_pending(&base.join("session-writer-fences")) } else { PendingState::Uninspectable };
    let journal = match crate::session_deletion_journal::has_pending(agent) {
        Ok(true) => PendingState::Pending,
        Ok(false) => PendingState::Clear,
        Err(_) => PendingState::Uninspectable,
    };
    let management = match management_host::target_key::ManagementTargetKey::inspect(agent) {
        Err(_) => PendingState::Uninspectable,
        Ok(key_exists) => {
            let ledger_path = base.join("management-operations");
            match std::fs::symlink_metadata(&ledger_path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => PendingState::Clear,
                Err(_) => PendingState::Uninspectable,
                Ok(_) if !key_exists => PendingState::Uninspectable,
                Ok(_) => match management_host::ledger::OperationLedger::inspect_unresolved(agent) {
                    Ok(false) => PendingState::Clear,
                    Ok(true) => PendingState::Pending,
                    Err(_) => PendingState::Uninspectable,
                },
            }
        }
    };
    RecoveryStatus { trust_policy: trust, session_writers: writers, deletion_journal: journal, management_operations: management }
}

/// Ordered shutdown phases. Register each actual service/controlled child
/// before it can run; arbitrary descendants and old writers are not covered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ShutdownStage { Admission, Scheduler, SessionChild, Management }

type Shutdown = Box<dyn FnOnce() -> Result<(), String> + Send>;
struct Service { stage: ShutdownStage, name: String, shutdown: Shutdown }
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShutdownFailure { pub stage: ShutdownStage, pub name: String, pub error: String }
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleState { Running, ShuttingDown, Stopped, Failed(Vec<ShutdownFailure>) }
struct Inner { state: LifecycleState, services: Vec<Service> }

pub struct HostLifecycle {
    // Kept even after shutdown failure. Dropping the host cannot prove that
    // any uncontrolled writer stopped; callers must preserve unknown state.
    _ownership: HostOwnership,
    agent: PathBuf,
    inner: Mutex<Inner>,
}

impl HostLifecycle {
    pub fn init(agent: &Path) -> Result<Self, String> {
        let agent = agent.canonicalize().map_err(|e| format!("Cannot resolve agent directory: {e}"))?;
        let ownership = HostOwnership::acquire(&agent, OwnershipMode::Runtime)
            .map_err(|e| format!("Cannot acquire cooperative host ownership: {e}"))?;
        Ok(Self { _ownership: ownership, agent, inner: Mutex::new(Inner { state: LifecycleState::Running, services: Vec::new() }) })
    }

    pub fn recovery_status(&self) -> RecoveryStatus { recovery_status(&self.agent) }

    /// A conservative bootstrap gate, not a substitute for each operation's
    /// own fences. Re-read rather than trusting the startup snapshot.
    pub fn require_clean_start(&self) -> Result<(), RecoveryStatus> {
        let status = self.recovery_status();
        if status.is_clear() { Ok(()) } else { Err(status) }
    }

    pub fn register<F>(&self, stage: ShutdownStage, name: impl Into<String>, shutdown: F) -> Result<(), String>
    where F: FnOnce() -> Result<(), String> + Send + 'static {
        let mut inner = self.inner.lock().map_err(|_| "Lifecycle lock poisoned")?;
        if inner.state != LifecycleState::Running { return Err("Host is shutting down".into()); }
        let name = name.into();
        if name.is_empty() || inner.services.iter().any(|service| service.name == name) {
            return Err("Invalid or duplicate lifecycle service name".into());
        }
        inner.services.push(Service { stage, name, shutdown: Box::new(shutdown) });
        Ok(())
    }

    pub fn state(&self) -> LifecycleState {
        self.inner.lock().map(|inner| inner.state.clone()).unwrap_or_else(|_| LifecycleState::Failed(vec![ShutdownFailure {
            stage: ShutdownStage::Admission, name: "lifecycle".into(), error: "Lifecycle lock poisoned".into(),
        }]))
    }

    /// Execute every registered cleanup, even after a failure; failure remains
    /// explicit and never becomes proof of exit. Registration is closed first.
    pub fn shutdown(&self) -> Result<(), Vec<ShutdownFailure>> {
        let mut services = {
            let mut inner = self.inner.lock().map_err(|_| vec![ShutdownFailure { stage: ShutdownStage::Admission, name: "lifecycle".into(), error: "Lifecycle lock poisoned".into() }])?;
            match &inner.state {
                LifecycleState::Stopped => return Ok(()),
                LifecycleState::Failed(failures) => return Err(failures.clone()),
                LifecycleState::ShuttingDown => return Err(vec![ShutdownFailure { stage: ShutdownStage::Admission, name: "lifecycle".into(), error: "Shutdown already in progress".into() }]),
                LifecycleState::Running => {},
            }
            inner.state = LifecycleState::ShuttingDown;
            std::mem::take(&mut inner.services)
        };
        services.sort_by_key(|service| service.stage);
        let mut failures = Vec::new();
        for service in services {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(service.shutdown));
            let error = match result { Ok(Ok(())) => continue, Ok(Err(error)) => error, Err(_) => "Shutdown callback panicked; outcome unknown".into() };
            failures.push(ShutdownFailure { stage: service.stage, name: service.name, error });
        }
        let mut inner = self.inner.lock().map_err(|_| vec![ShutdownFailure { stage: ShutdownStage::Admission, name: "lifecycle".into(), error: "Lifecycle lock poisoned".into() }])?;
        inner.state = if failures.is_empty() { LifecycleState::Stopped } else { LifecycleState::Failed(failures.clone()) };
        if failures.is_empty() { Ok(()) } else { Err(failures) }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn bootstrap_retains_ownership_and_closes_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let host = HostLifecycle::init(dir.path()).unwrap();
        assert!(host.require_clean_start().is_ok());
        assert!(HostLifecycle::init(dir.path()).is_err());
        let order = Arc::new(Mutex::new(Vec::new()));
        for stage in [ShutdownStage::Management, ShutdownStage::SessionChild, ShutdownStage::Admission, ShutdownStage::Scheduler] {
            let order = order.clone();
            host.register(stage, format!("{stage:?}"), move || { order.lock().unwrap().push(stage); Ok(()) }).unwrap();
        }
        host.shutdown().unwrap();
        assert_eq!(*order.lock().unwrap(), vec![ShutdownStage::Admission, ShutdownStage::Scheduler, ShutdownStage::SessionChild, ShutdownStage::Management]);
        assert_eq!(host.state(), LifecycleState::Stopped);
        assert!(host.register(ShutdownStage::Admission, "late", || Ok(())).is_err());
        assert!(HostLifecycle::init(dir.path()).is_err());
        drop(host);
        assert!(HostLifecycle::init(dir.path()).is_ok());
    }

    #[test]
    fn pending_is_visible_and_refuses_clean_start_without_modification() {
        let dir = tempfile::tempdir().unwrap();
        let host = HostLifecycle::init(dir.path()).unwrap();
        let marker = dir.path().join("pi-web/trust-policy-pending.json");
        std::fs::write(&marker, "unresolved").unwrap();
        std::fs::create_dir(dir.path().join("pi-web/session-writer-fences")).unwrap();
        std::fs::write(dir.path().join("pi-web/session-writer-fences/unknown"), "broken").unwrap();
        std::fs::create_dir(dir.path().join("session-deletion-journal")).unwrap();
        std::fs::write(dir.path().join("session-deletion-journal/pending"), "journal").unwrap();
        let status = host.require_clean_start().unwrap_err();
        assert_eq!(status, RecoveryStatus { trust_policy: PendingState::Pending, session_writers: PendingState::Pending, deletion_journal: PendingState::Pending, management_operations: PendingState::Clear });
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "unresolved");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn management_recovery_is_read_only_and_rejects_bad_evidence() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(recovery_status(dir.path()).management_operations, PendingState::Clear);
        assert!(!dir.path().join("pi-web").exists(), "diagnostics create nothing");
        let _key = management_host::target_key::ManagementTargetKey::load_or_create(dir.path()).unwrap();
        let _ledger = management_host::ledger::OperationLedger::open(dir.path()).unwrap();
        let id = "00000000-0000-4000-8000-000000000001";
        let file = dir.path().join("pi-web/management-operations").join(format!("{id}.json"));
        let record = serde_json::json!({"version":1,"operationId":id,"operation":"auth.logout","scope":"global","target":"credentials","phase":"pending","createdAtMs":1}).to_string();
        std::fs::write(&file, &record).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let status = recovery_status(dir.path());
        assert_eq!(status.management_operations, PendingState::Pending);
        assert!(!status.is_clear());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), record);
        let mut bad: serde_json::Value = serde_json::from_str(&record).unwrap();
        bad["version"] = serde_json::json!(2);
        std::fs::write(&file, bad.to_string()).unwrap();
        assert_eq!(recovery_status(dir.path()).management_operations, PendingState::Uninspectable);
        std::fs::write(&file, &record).unwrap();
        std::fs::remove_file(dir.path().join("pi-web/management-target-key.v1")).unwrap();
        assert_eq!(recovery_status(dir.path()).management_operations, PendingState::Uninspectable);
        assert_eq!(std::fs::read_to_string(file).unwrap(), record);
        let key_path = dir.path().join("pi-web/management-target-key.v1");
        assert!(!key_path.exists());
        std::fs::write(&key_path, b"broken").unwrap();
        assert_eq!(recovery_status(dir.path()).management_operations, PendingState::Uninspectable);
        assert_eq!(std::fs::read(key_path).unwrap(), b"broken");
    }

    #[test]
    fn failed_shutdown_stays_failed_and_still_closes_other_services() {
        let dir = tempfile::tempdir().unwrap();
        let host = HostLifecycle::init(dir.path()).unwrap();
        let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        host.register(ShutdownStage::Admission, "admission", || Err("not drained".into())).unwrap();
        let called2 = called.clone();
        host.register(ShutdownStage::Management, "management", move || { called2.store(true, std::sync::atomic::Ordering::SeqCst); Ok(()) }).unwrap();
        let failures = host.shutdown().unwrap_err();
        assert_eq!(failures[0].name, "admission");
        assert!(called.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(host.shutdown().unwrap_err(), failures);
        assert!(HostLifecycle::init(dir.path()).is_err());
    }
}
