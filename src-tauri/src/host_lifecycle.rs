//! Static bootstrap lifecycle. Cooperative ownership is not writer proof and
//! never authorizes deletion, journal replay, seed, or scheduler startup.
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
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
    pub session_writer_cleanup: PendingState,
    pub deletion_journal: PendingState,
    pub management_operations: PendingState,
}

impl RecoveryStatus {
    pub fn is_clear(&self) -> bool {
        self.trust_policy == PendingState::Clear && self.session_writers == PendingState::Clear
            && self.session_writer_cleanup == PendingState::Clear && self.deletion_journal == PendingState::Clear
            && self.management_operations == PendingState::Clear
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
    let (writers, writer_cleanup) = if base_safe { crate::session_writer_fence::diagnostic(agent) } else { (PendingState::Uninspectable, PendingState::Uninspectable) };
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
    RecoveryStatus { trust_policy: trust, session_writers: writers, session_writer_cleanup: writer_cleanup, deletion_journal: journal, management_operations: management }
}

/// Ordered shutdown phases. Register each actual service/controlled child
/// before it can run; arbitrary descendants and old writers are not covered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ShutdownStage { Admission, Scheduler, SessionChild, Management }

type Shutdown = Box<dyn FnOnce(std::time::Instant) -> Result<(), String> + Send>;
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
    closing: AtomicBool,
    completed: OnceLock<LifecycleState>,
}

impl HostLifecycle {
    pub fn init(agent: &Path) -> Result<Self, String> {
        let agent = agent.canonicalize().map_err(|e| format!("Cannot resolve agent directory: {e}"))?;
        let ownership = HostOwnership::acquire(&agent, OwnershipMode::Runtime)
            .map_err(|e| format!("Cannot acquire cooperative host ownership: {e}"))?;
        Ok(Self { _ownership: ownership, agent, inner: Mutex::new(Inner { state: LifecycleState::Running, services: Vec::new() }), closing: AtomicBool::new(false), completed: OnceLock::new() })
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
        self.register_until(stage, name, move |_| shutdown())
    }

    /// The callback must honor the supplied shared absolute deadline. The
    /// lifecycle cannot bound an arbitrary callback that ignores it.
    pub fn register_until<F>(&self, stage: ShutdownStage, name: impl Into<String>, shutdown: F) -> Result<(), String>
    where F: FnOnce(std::time::Instant) -> Result<(), String> + Send + 'static {
        if self.closing.load(Ordering::SeqCst) { return Err("Host is shutting down".into()); }
        let mut inner = self.inner.lock().map_err(|_| "Lifecycle lock poisoned")?;
        if self.closing.load(Ordering::SeqCst) || inner.state != LifecycleState::Running { return Err("Host is shutting down".into()); }
        let name = name.into();
        if name.is_empty() || inner.services.iter().any(|service| service.name == name) {
            return Err("Invalid or duplicate lifecycle service name".into());
        }
        inner.services.push(Service { stage, name, shutdown: Box::new(shutdown) });
        Ok(())
    }

    pub fn state(&self) -> LifecycleState {
        if let Some(state) = self.completed.get() { return state.clone(); }
        self.inner.try_lock().map(|inner| {
            if self.closing.load(Ordering::SeqCst) && inner.state == LifecycleState::Running {
                LifecycleState::ShuttingDown
            } else { inner.state.clone() }
        }).unwrap_or_else(|_| LifecycleState::Failed(vec![ShutdownFailure {
            stage: ShutdownStage::Admission, name: "lifecycle".into(), error: "Lifecycle state unavailable or busy; outcome unknown".into(),
        }]))
    }

    /// Execute every registered cleanup, even after a failure; failure remains
    /// explicit and never becomes proof of exit. Registration is closed first.
    pub fn shutdown(&self) -> Result<(), Vec<ShutdownFailure>> {
        self.shutdown_until(std::time::Instant::now() + std::time::Duration::from_secs(35))
    }

    #[cfg(test)]
    pub(crate) fn hold_inner_for_test(&self, ready: std::sync::mpsc::Sender<()>, release: std::sync::mpsc::Receiver<()>) {
        let _guard = self.inner.lock().unwrap();
        let _ = ready.send(());
        let _ = release.recv();
    }

    /// All callbacks receive the same absolute deadline, including callbacks
    /// after an earlier phase consumed the remaining time.
    pub fn shutdown_until(&self, deadline: std::time::Instant) -> Result<(), Vec<ShutdownFailure>> {
        if self.closing.swap(true, Ordering::SeqCst) {
            return match self.completed.get() {
                Some(LifecycleState::Stopped) => Ok(()),
                Some(LifecycleState::Failed(failures)) => Err(failures.clone()),
                Some(_) => unreachable!(),
                None => Err(vec![ShutdownFailure { stage: ShutdownStage::Admission, name: "lifecycle".into(), error: "Shutdown already in progress; outcome unknown".into() }]),
            };
        }
        let mut services = {
            let mut inner = match self.inner.try_lock() {
                Ok(inner) => inner,
                Err(_) => {
                    let failures = vec![ShutdownFailure { stage: ShutdownStage::Admission, name: "lifecycle".into(), error: "Lifecycle state unavailable or busy; callbacks not claimed".into() }];
                    let _ = self.completed.set(LifecycleState::Failed(failures.clone()));
                    return Err(failures);
                }
            };
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
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (service.shutdown)(deadline)));
            let error = match result { Ok(Ok(())) => continue, Ok(Err(error)) => error, Err(_) => "Shutdown callback panicked; outcome unknown".into() };
            failures.push(ShutdownFailure { stage: service.stage, name: service.name, error });
        }
        match self.inner.try_lock() {
            Ok(mut inner) => {
                inner.state = if failures.is_empty() { LifecycleState::Stopped } else { LifecycleState::Failed(failures.clone()) };
            }
            Err(_) => failures.push(ShutdownFailure { stage: ShutdownStage::Admission, name: "lifecycle".into(), error: "Lifecycle result publication unavailable or busy; state unknown".into() }),
        }
        let final_state = if failures.is_empty() { LifecycleState::Stopped } else { LifecycleState::Failed(failures.clone()) };
        let _ = self.completed.set(final_state);
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
        assert_eq!(status, RecoveryStatus { trust_policy: PendingState::Pending, session_writers: PendingState::Pending, session_writer_cleanup: PendingState::Clear, deletion_journal: PendingState::Pending, management_operations: PendingState::Clear });
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
    fn shutdown_passes_one_deadline_to_each_registered_service() {
        let dir = tempfile::tempdir().unwrap();
        let host = HostLifecycle::init(dir.path()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        for stage in [ShutdownStage::SessionChild, ShutdownStage::Management] {
            host.register_until(stage, format!("{stage:?}"), move |actual| {
                assert_eq!(actual, deadline); Ok(())
            }).unwrap();
        }
        host.shutdown_until(deadline).unwrap();
    }

    #[test]
    fn busy_final_publication_preserves_failure_and_never_replays_callbacks() {
        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(HostLifecycle::init(dir.path()).unwrap());
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (continue_tx, continue_rx) = std::sync::mpsc::channel();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let callback_calls = Arc::clone(&calls);
        host.register(ShutdownStage::Management, "fixture", move || {
            callback_calls.fetch_add(1, Ordering::SeqCst);
            entered_tx.send(()).unwrap();
            continue_rx.recv().unwrap();
            Err("original failure".into())
        }).unwrap();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let worker_host = Arc::clone(&host);
        let worker = std::thread::spawn(move || { let _ = result_tx.send(worker_host.shutdown_until(std::time::Instant::now() + std::time::Duration::from_millis(100))); });
        entered_rx.recv().unwrap();
        let concurrent = host.shutdown_until(std::time::Instant::now()).unwrap_err();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder_host = Arc::clone(&host);
        let holder = std::thread::spawn(move || holder_host.hold_inner_for_test(ready_tx, release_rx));
        ready_rx.recv().unwrap();
        continue_tx.send(()).unwrap();
        let result = result_rx.recv_timeout(std::time::Duration::from_millis(500));
        let _ = release_tx.send(());
        holder.join().unwrap();
        worker.join().unwrap();
        let failures = result.expect("shutdown blocked publishing lifecycle state").unwrap_err();
        assert!(concurrent[0].error.contains("in progress"));
        assert!(failures.iter().any(|f| f.error == "original failure"));
        assert!(failures.iter().any(|f| f.error.contains("publication unavailable")));
        assert_eq!(host.shutdown_until(std::time::Instant::now()).unwrap_err(), failures);
        assert_eq!(host.state(), LifecycleState::Failed(failures));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
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
