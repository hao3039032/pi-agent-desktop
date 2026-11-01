//! Isolated static-host bootstrap used by the acceptance entry, not production.
//! It never starts the scheduler or grants destructive/recovery permissions.
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use crate::host_lifecycle::{HostLifecycle, RecoveryStatus, ShutdownFailure, ShutdownStage};
use crate::pi_ipc::IpcHostState;

#[derive(Default)]
pub struct TrackedShutdown {
    pub scheduler: Option<crate::pi_ipc::SchedulerShutdownReport>,
    pub sessions: Option<session_host::SessionShutdownReport>,
    pub session_writers: Option<crate::session_writer_lifecycle::SessionWriterShutdownReport>,
    pub management: Option<management_host::ManagementShutdownReport>,
    pub index_children: Option<crate::index_children::IndexChildShutdownReport>,
    pub relays: Option<crate::pi_ipc::RelayShutdownReport>,
}

/// Availability describes publication only; it does not certify a clean shutdown.
pub fn session_report_fields(report: Option<&session_host::SessionShutdownReport>) -> serde_json::Value {
    serde_json::json!({
        "sessionReportStatus": if report.is_some() { "available" } else { "unknown" },
        "sessionExited": report.map(|r| &r.exited),
        "sessionUnknown": report.map(|r| &r.unknown),
        "sessionDiagnostics": report.map(|r| &r.diagnostics),
    })
}

pub fn relay_report_fields(report: Option<&crate::pi_ipc::RelayShutdownReport>) -> serde_json::Value {
    serde_json::json!({
        "relayReportStatus": if report.is_some() { "available" } else { "unknown" },
        "relays": report,
    })
}

fn publish_report<T>(
    tracked: &Mutex<TrackedShutdown>, name: &str, result: T,
    outcome: Result<(), String>, store: impl FnOnce(&mut TrackedShutdown, T),
) -> Result<(), String> {
    match tracked.try_lock() {
        Ok(mut report) => { store(&mut report, result); outcome }
        Err(_) => Err(format!("{name} report publication unavailable or busy; {}", match outcome {
            Ok(()) => "callback completed but report was not published".to_string(),
            Err(error) => format!("callback reported: {error}"),
        })),
    }
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
        lifecycle.register_until(ShutdownStage::Admission, "stream-relays", move |deadline| {
            let result = host.drain_stream_relays_until(deadline);
            let outcome = if result.is_complete() { Ok(()) } else { Err(format!("stream relay reservations or registries unknown: {result:?}")) };
            publish_report(&report, "stream relay", result, outcome, |report, value| report.relays = Some(value))
        })?;
        let host = Arc::clone(&state);
        let report = Arc::clone(&tracked);
        lifecycle.register_until(ShutdownStage::SessionChild, "index-children", move |deadline| {
            let result = host.index_children.shutdown_until(deadline);
            let outcome = if result.unknown == 0 && !result.tracker_busy { Ok(()) } else { Err(format!("index children unknown: {}, tracker busy: {}", result.unknown, result.tracker_busy)) };
            publish_report(&report, "index children", result, outcome, |report, value| report.index_children = Some(value))
        })?;
        let host = Arc::clone(&state);
        let report = Arc::clone(&tracked);
        lifecycle.register_until(ShutdownStage::Scheduler, "scheduler-final-shutdown", move |deadline| {
            let result = host.shutdown_scheduler_until(deadline);
            let stopped = result.stopped;
            let unknown = result.active_unknown.clone();
            let outcome = if stopped { Ok(()) } else { Err(format!("scheduler unknown: {}", unknown.join(", "))) };
            publish_report(&report, "scheduler", result, outcome, |report, value| report.scheduler = Some(value))
        })?;
        let host = Arc::clone(&state);
        let report = Arc::clone(&tracked);
        lifecycle.register_until(ShutdownStage::SessionChild, "session-writers", move |deadline| {
            let result = host.session_writers.shutdown_until(deadline);
            let unknown = result.unknown.clone();
            let outcome = if unknown.is_empty() { Ok(()) } else { Err(format!("session writer unknown: {}", unknown.join(", "))) };
            publish_report(&report, "writer", result, outcome, |report, value| report.session_writers = Some(value))
        })?;
        let host = Arc::clone(&state);
        let report = Arc::clone(&tracked);
        lifecycle.register_until(ShutdownStage::SessionChild, "session-leaders", move |deadline| {
            let result = host.registry.shutdown_until(deadline);
            let unknown = result.unknown.clone();
            let outcome = if unknown.is_empty() { Ok(()) } else { Err(format!("session unknown: {}", unknown.join(", "))) };
            publish_report(&report, "session", result, outcome, |report, value| report.sessions = Some(value))
        })?;
        let host = Arc::clone(&state);
        let report = Arc::clone(&tracked);
        lifecycle.register_until(ShutdownStage::Management, "management-leaders", move |deadline| {
            let result = host.management.shutdown_until(deadline);
            let unknown = result.unknown.clone();
            let outcome = if unknown.is_empty() { Ok(()) } else { Err(format!("management unknown: {}", unknown.join(", "))) };
            publish_report(&report, "management", result, outcome, |report, value| report.management = Some(value))
        })?;
        Ok(Self { state, lifecycle, tracked })
    }

    pub fn recovery_status(&self) -> RecoveryStatus { self.lifecycle.recovery_status() }

    /// Reports cover registered operations and leaders. Scheduler unknowns may
    /// repeat session diagnostics; they are not additive process counts. PTYs,
    /// detached descendants and unregistered writers remain uncovered. Relay
    /// reports cover tracked application work, not WebView internal delivery.
    pub fn shutdown_until(&self, deadline: Instant) -> Result<(), Vec<ShutdownFailure>> {
        // Admission is fenced before the lifecycle state lock can be contended.
        self.state.begin_static_shutdown();
        self.lifecycle.shutdown_until(deadline)
    }

    pub fn tracked(&self) -> Result<std::sync::MutexGuard<'_, TrackedShutdown>, String> {
        self.tracked.try_lock().map_err(|_| "shutdown report unavailable or busy".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn assert_admission_closed(host: &IsolatedStaticHost, dir: &Path) {
        let response = tauri::async_runtime::block_on(crate::pi_ipc::dispatch_envelope_gated(
            Arc::clone(&host.state), serde_json::json!({"v":1,"id":"after","op":"desktop.identity"}),
        ));
        assert_ne!(response["ok"], true);
        assert!(host.state.session_writers.admit("late").is_err());
        assert!(host.state.scheduled_lifecycle.admit("late").is_err());
        assert!(host.state.registry.start_with_plan("late", dir, "late", dir, || panic!("spawn plan must not run")).is_err());
        let config = management_host::ManagementSpawnConfig { executable: "unused".into(), agent_dir: None, extensions: vec![], env: vec![] };
        assert!(host.state.management.instance("late", &config).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn index_child_shutdown_reports_unknown_with_shared_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let host = IsolatedStaticHost::init(dir.path()).unwrap();
        let lease = host.state.index_children.reserve().unwrap();
        let result = host.shutdown_until(Instant::now() + Duration::from_millis(50)).unwrap_err();
        assert!(result.iter().any(|failure| failure.name == "index-children" && failure.error.contains("unknown: 1")), "{result:?}");
        assert_eq!(host.tracked().unwrap().index_children.as_ref().unwrap().unknown, 1);
        drop(lease);
    }

    #[test]
    fn missing_session_report_is_explicitly_unknown_in_serialized_fields() {
        let fields = session_report_fields(None);
        assert_eq!(fields["sessionReportStatus"], "unknown");
        assert!(fields["sessionExited"].is_null());
        assert!(fields["sessionUnknown"].is_null());
        assert!(fields["sessionDiagnostics"].is_null());
        let fields = session_report_fields(Some(&session_host::SessionShutdownReport::default()));
        assert_eq!(fields["sessionReportStatus"], "available");
        assert_eq!(fields["sessionDiagnostics"], serde_json::json!([]));
        let report = session_host::SessionShutdownReport {
            exited: vec!["fixture".into()], unknown: vec!["fixture: prompt unknown".into()],
            diagnostics: vec![session_host::SessionShutdownDiagnostic::PromptReceipt {
                session_id: "fixture".into(), receipt_id: 1,
                phase: session_host::PromptReceiptPhase::AcknowledgedStarted,
                uncorrelated_start_seen: false, uncorrelated_terminal_seen: true,
            }],
        };
        let fields = session_report_fields(Some(&report));
        assert_eq!(fields["sessionExited"], serde_json::json!(["fixture"]));
        assert_eq!(fields["sessionDiagnostics"][0]["kind"], "prompt_receipt");
        assert_eq!(fields["sessionDiagnostics"][0]["phase"], "acknowledged_started");
        assert_eq!(fields["sessionDiagnostics"][0]["uncorrelated_terminal_seen"], true);
        assert_eq!(fields["sessionUnknown"], serde_json::json!(["fixture: prompt unknown"]));
    }

    #[test]
    fn held_report_guard_does_not_block_shutdown_or_erase_unknowns() {
        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(IsolatedStaticHost::init(dir.path()).unwrap());
        let mut run = host.state.scheduled_lifecycle.admit("unknown-run").unwrap();
        run.claimed();
        drop(run);
        let guard = host.tracked().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker_host = Arc::clone(&host);
        let worker = std::thread::spawn(move || {
            let _ = tx.send(worker_host.shutdown_until(Instant::now() + Duration::from_millis(100)));
        });
        let result = rx.recv_timeout(Duration::from_millis(500));
        drop(guard); // Always release before joining, including on timeout.
        worker.join().unwrap();
        let failures = result.expect("shutdown blocked on report guard").unwrap_err();
        assert!(failures.iter().any(|f| f.name == "scheduler-final-shutdown" && f.error.contains("scheduler unknown") && f.error.contains("report publication")));
        assert!(failures.iter().any(|f| f.name == "session-writers" && f.error.contains("report publication")));
        assert_eq!(host.shutdown_until(Instant::now()).unwrap_err(), failures);
        assert_admission_closed(&host, dir.path());
    }

    #[test]
    fn held_lifecycle_lock_closes_admission_before_returning_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(IsolatedStaticHost::init(dir.path()).unwrap());
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder_host = Arc::clone(&host);
        let holder = std::thread::spawn(move || holder_host.lifecycle.hold_inner_for_test(ready_tx, release_rx));
        ready_rx.recv().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker_host = Arc::clone(&host);
        let worker = std::thread::spawn(move || { let _ = tx.send(worker_host.shutdown_until(Instant::now() + Duration::from_millis(100))); });
        let result = rx.recv_timeout(Duration::from_millis(500));
        let _ = release_tx.send(());
        holder.join().unwrap();
        worker.join().unwrap();
        let failures = result.expect("shutdown blocked on lifecycle lock").unwrap_err();
        assert!(failures[0].error.contains("callbacks not claimed"));
        assert_eq!(host.shutdown_until(Instant::now()).unwrap_err(), failures);
        assert_admission_closed(&host, dir.path());
    }

    #[test]
    fn isolated_bootstrap_closes_admission_and_tracks_empty_registries() {
        let dir = tempfile::tempdir().unwrap();
        let host = IsolatedStaticHost::init(dir.path()).unwrap();
        assert!(host.recovery_status().is_clear());
        host.shutdown_until(Instant::now() + Duration::from_secs(1)).unwrap();
        let tracked = host.tracked().unwrap();
        assert!(tracked.scheduler.as_ref().unwrap().stopped);
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
    fn final_shutdown_stops_fixture_scheduler_without_releasing_lease() {
        let dir = tempfile::tempdir().unwrap();
        let host = IsolatedStaticHost::init(dir.path()).unwrap();
        // Explicit test-only start; the bootstrap itself never starts a loop.
        host.state.start_scheduler().unwrap();
        let lease = dir.path().join("scheduled-tasks/scheduler.lock");
        let deadline = Instant::now() + Duration::from_secs(3);
        while !lease.exists() {
            assert!(Instant::now() < deadline, "fixture scheduler did not acquire lease");
            std::thread::sleep(Duration::from_millis(5));
        }
        host.shutdown_until(Instant::now() + Duration::from_secs(2)).unwrap();
        assert!(host.tracked().unwrap().scheduler.as_ref().unwrap().stopped);
        assert!(lease.exists(), "final shutdown is not lease recovery");
        assert!(host.state.start_scheduler().is_err());
    }

    #[test]
    fn unresolved_scheduled_run_is_preserved_in_shutdown_report() {
        let dir = tempfile::tempdir().unwrap();
        let host = IsolatedStaticHost::init(dir.path()).unwrap();
        let mut run = host.state.scheduled_lifecycle.admit("fixture-run").unwrap();
        run.claimed();
        drop(run);
        let failures = host.shutdown_until(Instant::now() + Duration::from_millis(20)).unwrap_err();
        assert!(failures.iter().any(|failure| failure.name == "scheduler-final-shutdown"));
        let tracked = host.tracked().unwrap();
        let report = tracked.scheduler.as_ref().unwrap();
        assert!(!report.stopped);
        assert!(!report.active_unknown.is_empty());
        assert!(tracked.sessions.as_ref().unwrap().exited.is_empty());
        drop(tracked);
        assert!(host.state.scheduled_lifecycle.admit("late").is_err());
        assert!(host.state.start_scheduler().is_err());
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
