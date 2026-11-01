//! Isolated static-host bootstrap used by the acceptance entry, not production.
//! It never starts the scheduler or grants destructive/recovery permissions.
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use crate::host_lifecycle::{HostLifecycle, RecoveryStatus, ShutdownFailure, ShutdownStage};
use crate::pi_ipc::IpcHostState;

#[derive(Default)]
pub struct TrackedShutdown {
    pub sessions: Option<session_host::SessionShutdownReport>,
    pub session_writers: Option<crate::session_writer_lifecycle::SessionWriterShutdownReport>,
    pub management: Option<management_host::ManagementShutdownReport>,
}

pub struct IsolatedStaticHost {
    pub state: Arc<IpcHostState>,
    lifecycle: HostLifecycle,
    tracked: Arc<Mutex<TrackedShutdown>>,
}

impl IsolatedStaticHost {
    /// Only an existing directory below the OS temporary directory may be
    /// used by the harness. This is not a production ownership policy.
    pub fn init(agent: &Path) -> Result<Self, String> {
        let agent = agent.canonicalize().map_err(|e| e.to_string())?;
        let temp = std::env::temp_dir().canonicalize().map_err(|e| e.to_string())?;
        if agent == temp || !agent.starts_with(&temp) || !agent.is_dir() {
            return Err("isolated static host requires a temporary agent directory".into());
        }
        let lifecycle = HostLifecycle::init(&agent)?;
        let state = Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().map_err(|_| "agent directory lock poisoned")? = Some(agent);
        let tracked = Arc::new(Mutex::new(TrackedShutdown::default()));
        let host = Arc::clone(&state);
        lifecycle.register_until(ShutdownStage::Admission, "ipc", move |deadline| {
            host.begin_static_shutdown();
            host.drain_static_ipc_until(deadline)
        })?;
        let host = Arc::clone(&state);
        let report = Arc::clone(&tracked);
        lifecycle.register_until(ShutdownStage::SessionChild, "session-writers", move |deadline| {
            let result = host.session_writers.shutdown_until(deadline);
            let unknown = result.unknown.clone();
            report.lock().map_err(|_| "writer report lock poisoned")?.session_writers = Some(result);
            if unknown.is_empty() { Ok(()) } else { Err(format!("session writer unknown: {}", unknown.join(", "))) }
        })?;
        let host = Arc::clone(&state);
        let report = Arc::clone(&tracked);
        lifecycle.register_until(ShutdownStage::SessionChild, "session-leaders", move |deadline| {
            let result = host.registry.shutdown_until(deadline);
            let unknown = result.unknown.clone();
            report.lock().map_err(|_| "session report lock poisoned")?.sessions = Some(result);
            if unknown.is_empty() { Ok(()) } else { Err(format!("session unknown: {}", unknown.join(", "))) }
        })?;
        let host = Arc::clone(&state);
        let report = Arc::clone(&tracked);
        lifecycle.register_until(ShutdownStage::Management, "management-leaders", move |deadline| {
            let result = host.management.shutdown_until(deadline);
            let unknown = result.unknown.clone();
            report.lock().map_err(|_| "management report lock poisoned")?.management = Some(result);
            if unknown.is_empty() { Ok(()) } else { Err(format!("management unknown: {}", unknown.join(", "))) }
        })?;
        Ok(Self { state, lifecycle, tracked })
    }

    pub fn recovery_status(&self) -> RecoveryStatus { self.lifecycle.recovery_status() }

    /// Reports cover only registered operations and leaders. PTYs, detached
    /// descendants, unregistered writers and scheduler runs are not covered.
    pub fn shutdown_until(&self, deadline: Instant) -> Result<(), Vec<ShutdownFailure>> {
        self.lifecycle.shutdown_until(deadline)
    }

    pub fn tracked(&self) -> Result<std::sync::MutexGuard<'_, TrackedShutdown>, String> {
        self.tracked.lock().map_err(|_| "shutdown report lock poisoned".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    #[test]
    fn isolated_bootstrap_closes_admission_and_tracks_empty_registries() {
        let dir = tempfile::tempdir().unwrap();
        let host = IsolatedStaticHost::init(dir.path()).unwrap();
        assert!(host.recovery_status().is_clear());
        host.shutdown_until(Instant::now() + Duration::from_secs(1)).unwrap();
        let tracked = host.tracked().unwrap();
        assert!(tracked.sessions.as_ref().unwrap().unknown.is_empty());
        assert!(tracked.session_writers.as_ref().unwrap().unknown.is_empty());
        assert!(tracked.management.as_ref().unwrap().unknown.is_empty());
        drop(tracked);
        let response = tauri::async_runtime::block_on(crate::pi_ipc::dispatch_envelope_gated(
            Arc::clone(&host.state), serde_json::json!({"v":1,"id":"after","op":"desktop.identity"}),
        ));
        assert_ne!(response["ok"], true);
    }

    #[test]
    fn in_flight_session_writer_is_reported_unknown_and_fenced() {
        let dir = tempfile::tempdir().unwrap();
        let host = IsolatedStaticHost::init(dir.path()).unwrap();
        let mut writer = host.state.session_writers.admit("fixture-operation").unwrap();
        writer.before_spawn().unwrap();
        let failures = host.shutdown_until(Instant::now() + Duration::from_millis(10)).unwrap_err();
        assert!(failures.iter().any(|failure| failure.name == "session-writers"));
        let tracked = host.tracked().unwrap();
        assert!(tracked.session_writers.as_ref().unwrap().unknown.iter().any(|item| item.contains("fixture-operation")));
        assert!(tracked.sessions.as_ref().unwrap().exited.is_empty());
        drop(tracked);
        assert!(host.state.session_writers.admit("new-operation").is_err());
        drop(writer);
    }

    #[test]
    fn admitted_writer_completes_before_shared_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let host = IsolatedStaticHost::init(dir.path()).unwrap();
        let mut writer = host.state.session_writers.admit("finishing-operation").unwrap();
        writer.before_spawn().unwrap();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            writer.complete();
        });
        host.shutdown_until(Instant::now() + Duration::from_secs(1)).unwrap();
        worker.join().unwrap();
        let tracked = host.tracked().unwrap();
        assert_eq!(tracked.session_writers.as_ref().unwrap().exited, vec!["finishing-operation"]);
        assert!(tracked.session_writers.as_ref().unwrap().unknown.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn tracked_management_leader_is_closed_by_bootstrap() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-management");
        std::fs::write(&script, "#!/bin/sh\nwhile IFS= read -r line; do :; done\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let host = IsolatedStaticHost::init(dir.path()).unwrap();
        let config = management_host::ManagementSpawnConfig {
            executable: script.to_string_lossy().into_owned(), agent_dir: Some(dir.path().to_path_buf()),
            extensions: vec![], env: vec![],
        };
        let instance = host.state.management.instance("global", &config).unwrap();
        host.shutdown_until(Instant::now() + Duration::from_secs(2)).unwrap();
        assert!(instance.client_has_exited());
        let tracked = host.tracked().unwrap();
        assert_eq!(tracked.management.as_ref().unwrap().exited, vec!["global"]);
        assert!(tracked.management.as_ref().unwrap().unknown.is_empty());
    }

    #[test]
    fn pending_marker_remains_visible_during_bootstrap() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("pi-web")).unwrap();
        let marker = dir.path().join("pi-web/trust-policy-pending.json");
        std::fs::write(&marker, "unresolved").unwrap();
        let host = IsolatedStaticHost::init(dir.path()).unwrap();
        assert!(!host.recovery_status().is_clear());
        host.shutdown_until(Instant::now() + Duration::from_secs(1)).unwrap();
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "unresolved");
    }
}
