use super::*;
use crate::static_host::IsolatedStaticHost;
use std::sync::mpsc;
use std::time::Instant;

fn channel() -> (Channel<Value>, mpsc::Receiver<Value>) {
    let (tx, rx) = mpsc::channel();
    (Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(text) = body {
            let _ = tx.send(serde_json::from_str(&text).unwrap());
        }
        Ok(())
    }), rx)
}

#[test]
fn missing_relay_report_is_unknown_not_empty_success() {
    let fields = crate::static_host::relay_report_fields(None);
    assert_eq!(fields["relayReportStatus"], "unknown");
    assert!(fields["relays"].is_null());
}

#[test]
fn close_before_management_lookup_tracks_open_and_rejects_late_open() {
    let dir = tempfile::tempdir().unwrap();
    let host = IsolatedStaticHost::init(dir.path()).unwrap();
    let state = Arc::clone(&host.state);
    let guard = state.management_config.lock().unwrap();
    let starter_state = Arc::clone(&state);
    let starter = std::thread::spawn(move || open_login_stream(&starter_state, "fake".into(), None, None, channel().0));
    let until = Instant::now() + Duration::from_secs(2);
    while state.login_relays.shutdown_status().in_flight == 0 && Instant::now() < until { std::thread::yield_now(); }
    let result = host.shutdown_until(Instant::now() + Duration::from_millis(80));
    let report = host.tracked().unwrap().relays.clone().unwrap();
    drop(guard);
    let reply = starter.join().unwrap();
    assert_eq!(report.auth.in_flight, 1);
    assert!(result.unwrap_err().iter().any(|f| f.name == "stream-relays"));
    assert_eq!(reply["error"]["code"], "busy");
    assert_eq!(open_login_stream(&state, "fake".into(), None, None, channel().0)["error"]["code"], "busy");
    assert!(state.drain_stream_relays_until(Instant::now() + Duration::from_secs(1)).is_complete());
    assert!(host.shutdown_until(Instant::now()).is_err());
}

#[test]
fn close_before_registration_and_binding_preserves_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let host = IsolatedStaticHost::init(dir.path()).unwrap();
    let state = Arc::clone(&host.state);
    let guard = state.login_relays.relays.lock().unwrap();
    let worker_state = Arc::clone(&state);
    let worker = std::thread::spawn(move || reserve_login_relay(&worker_state, "starting".into(), channel().0));
    let until = Instant::now() + Duration::from_secs(2);
    while state.login_relays.alive.load(Ordering::SeqCst) == 0 && Instant::now() < until { std::thread::yield_now(); }
    let passed_shutdown_check = state.login_relays.alive.load(Ordering::SeqCst) == 1;
    let result = host.shutdown_until(Instant::now() + Duration::from_millis(80));
    let report = host.tracked().unwrap().relays.clone().unwrap();
    drop(guard);
    let sender = worker.join().unwrap();
    assert!(passed_shutdown_check, "observer did not reach registration before deadline");
    drop(sender.unwrap());
    assert_eq!(report.auth.in_flight, 1);
    assert!(report.auth.registry_busy);
    assert!(result.is_err());
    assert!(state.drain_stream_relays_until(Instant::now() + Duration::from_secs(2)).is_complete());
}

#[test]
fn waiting_for_binding_stops_without_sender_drop() {
    let dir = tempfile::tempdir().unwrap();
    let host = IsolatedStaticHost::init(dir.path()).unwrap();
    let sender = reserve_login_relay(&host.state, "binding".into(), channel().0).unwrap();
    let result = host.shutdown_until(Instant::now() + Duration::from_secs(2));
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(host.tracked().unwrap().relays.as_ref().unwrap().auth.in_flight, 0);
    drop(sender);
}

#[cfg(unix)]
fn fake_instance(state: &Arc<IpcHostState>, dir: &std::path::Path) -> Arc<management_host::ManagementInstance> {
    // A stable read-only executable avoids the write/fork/exec ETXTBSY window
    // of freshly-created scripts when multiple process fixtures run in parallel.
    let child = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("test-fixtures/auth-relay.py").canonicalize().unwrap();
    let config = management_host::ManagementSpawnConfig { executable: child.to_string_lossy().into_owned(), agent_dir: Some(dir.to_path_buf()), extensions: vec![], env: vec![] };
    state.management.instance("global", &config).unwrap()
}

#[cfg(unix)]
#[test]
fn close_wakes_ack_and_quiet_observers_even_with_busy_registry() {
    let dir = tempfile::tempdir().unwrap();
    let host = IsolatedStaticHost::init(dir.path()).unwrap();
    let instance = fake_instance(&host.state, dir.path());
    let task = instance.start_task("auth.loginStart", json!({}), LOGIN_FLOW_DEADLINE, management_host::TaskKind::Mutation).unwrap();
    let (ch1, rx1) = channel();
    let tx1 = reserve_login_relay(&host.state, "unacked".into(), ch1).unwrap();
    tx1.send(("flow".into(), task.clone(), Arc::clone(&instance))).unwrap();
    rx1.recv_timeout(Duration::from_secs(2)).unwrap();
    let (ch2, rx2) = channel();
    let tx2 = reserve_login_relay(&host.state, "quiet".into(), ch2).unwrap();
    tx2.send(("flow".into(), task.clone(), Arc::clone(&instance))).unwrap();
    rx2.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(host.state.login_relays.acknowledge("quiet", 1, 1));
    let guard = host.state.login_relays.relays.lock().unwrap();
    let result = host.shutdown_until(Instant::now() + Duration::from_millis(150));
    let report = host.tracked().unwrap().relays.clone().unwrap();
    drop(guard);
    assert!(result.is_err());
    assert!(report.auth.registry_busy);
    assert_eq!(report.auth.in_flight, 2);
    assert!(host.state.drain_stream_relays_until(Instant::now() + Duration::from_secs(2)).is_complete());
    assert_eq!(host.tracked().unwrap().relays.as_ref().unwrap().auth.in_flight, 2);
}

#[cfg(unix)]
#[test]
fn panicking_observer_retains_reservation_until_registration_cleanup() {
    struct Unwinding(mpsc::Sender<()>);
    impl Drop for Unwinding { fn drop(&mut self) { let _ = self.0.send(()); } }
    let dir = tempfile::tempdir().unwrap();
    let host = IsolatedStaticHost::init(dir.path()).unwrap();
    let instance = fake_instance(&host.state, dir.path());
    let task = instance.start_task("auth.loginStart", json!({}), LOGIN_FLOW_DEADLINE, management_host::TaskKind::Mutation).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (panic_tx, panic_rx) = mpsc::channel();
    let (unwound_tx, unwound_rx) = mpsc::channel();
    let panic_rx = Mutex::new(panic_rx);
    let ch = Channel::new(move |_| {
        let _unwinding = Unwinding(unwound_tx.clone());
        entered_tx.send(()).unwrap();
        panic_rx.lock().unwrap().recv().unwrap();
        panic!("controlled observer panic");
    });
    let sender = reserve_login_relay(&host.state, "panic".into(), ch).unwrap();
    sender.send(("flow".into(), task.clone(), Arc::clone(&instance))).unwrap();
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let guard = host.state.login_relays.relays.lock().unwrap();
    panic_tx.send(()).unwrap();
    let unwound = unwound_rx.recv_timeout(Duration::from_secs(2));
    let result = host.shutdown_until(Instant::now() + Duration::from_millis(100));
    let report = host.tracked().unwrap().relays.clone().unwrap();
    drop(guard);
    unwound.unwrap();
    assert!(result.is_err());
    assert!(report.auth.registry_busy);
    assert_eq!(report.auth.in_flight, 1);
    assert!(host.state.drain_stream_relays_until(Instant::now() + Duration::from_secs(2)).is_complete());
    assert!(!host.state.login_relays.relays.lock().unwrap().contains_key("panic"));
    assert_eq!(host.tracked().unwrap().relays.as_ref().unwrap().auth.in_flight, 1);
}

#[test]
fn poisoned_registration_cleanup_never_reports_complete_or_panics_again() {
    let state = Arc::new(IpcHostState::new());
    let sender = reserve_login_relay(&state, "poison".into(), channel().0).unwrap();
    let relays = Arc::clone(&state.login_relays);
    assert!(std::thread::spawn(move || {
        let _guard = relays.relays.lock().unwrap();
        panic!("controlled registry poison");
    }).join().is_err());
    drop(sender);
    let until = Instant::now() + Duration::from_secs(2);
    // Registration fields drop in order: alive can reach zero just before
    // the semaphore permit is released. Observe both, not the first counter.
    while (state.login_relays.alive.load(Ordering::SeqCst) != 0
        || state.login_relays.gate.available_permits() != LOGIN_MAX_RELAYS)
        && Instant::now() < until { std::thread::yield_now(); }
    assert_eq!(state.login_relays.alive.load(Ordering::SeqCst), 0);
    assert_eq!(state.login_relays.gate.available_permits(), LOGIN_MAX_RELAYS);
    let poisoned = match state.login_relays.relays.lock() { Ok(_) => panic!("registry was not poisoned"), Err(error) => error.into_inner() };
    assert!(!poisoned.contains_key("poison"));
    drop(poisoned);
    let report = state.drain_stream_relays_until(Instant::now());
    assert_eq!(report.auth.in_flight, 0);
    assert!(report.auth.registry_busy);
    assert!(!report.is_complete());
}

#[cfg(unix)]
#[test]
fn blocked_channel_remains_unknown_until_released() {
    let dir = tempfile::tempdir().unwrap();
    let host = IsolatedStaticHost::init(dir.path()).unwrap();
    let instance = fake_instance(&host.state, dir.path());
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release_rx = Mutex::new(release_rx);
    let ch = Channel::new(move |_| { let _ = entered_tx.send(()); let _ = release_rx.lock().unwrap().recv(); Ok(()) });
    let sender = reserve_login_relay(&host.state, "blocked".into(), ch).unwrap();
    sender.send(("flow".into(), "task".into(), instance)).unwrap();
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let result = host.shutdown_until(Instant::now() + Duration::from_millis(100));
    let report = host.tracked().unwrap().relays.clone().unwrap();
    let _ = release_tx.send(());
    assert!(result.is_err());
    assert_eq!(report.auth.in_flight, 1);
    assert!(host.state.drain_stream_relays_until(Instant::now() + Duration::from_secs(2)).is_complete());
    assert_eq!(host.tracked().unwrap().relays.as_ref().unwrap().auth.in_flight, 1);
}
