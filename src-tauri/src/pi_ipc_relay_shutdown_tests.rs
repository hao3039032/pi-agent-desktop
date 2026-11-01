use super::*;
use crate::static_host::IsolatedStaticHost;
use std::sync::mpsc;
use std::time::Instant;

fn fixture_host() -> (tempfile::TempDir, IsolatedStaticHost) {
    let dir = tempfile::tempdir().unwrap();
    let host = IsolatedStaticHost::init(dir.path()).unwrap();
    (dir, host)
}

fn channel() -> (Channel<Value>, mpsc::Receiver<Value>) {
    let (tx, rx) = mpsc::channel();
    (Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(text) = body {
            let _ = tx.send(serde_json::from_str(&text).unwrap());
        }
        Ok(())
    }), rx)
}

// This isolated fake speaks only the handshake needed by the relay fixture.
#[cfg(unix)]
fn start_mock_session(host: &IsolatedStaticHost, dir: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    let executable = dir.join("mock-pi.cjs");
    std::fs::write(&executable, r##"#!/usr/bin/env node
const args = process.argv;
const id = args[args.indexOf('--mock-session-id') + 1];
const commands = JSON.parse(Buffer.from(args[args.indexOf('--mock-commands') + 1], 'base64').toString());
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const data = request.type === 'get_state' ? { sessionId: id, isStreaming: false, isCompacting: false, thinkingLevel: 'off' }
    : request.type === 'get_commands' ? commands : {};
  process.stdout.write(JSON.stringify({ id: request.id, type: 'response', command: request.type, success: true, data }) + '\n');
});
"##).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let cwd = dir.join("work");
    std::fs::create_dir(&cwd).unwrap();
    let (file, id) = session_host::create_session_file(&dir.join("sessions"), &cwd).unwrap();
    let bridge = Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs").canonicalize().unwrap();
    let commands = json!({"commands":[{"name":"pi-web:bridge", "source":"extension", "sourceInfo":{"path":bridge}}]});
    let encoded = base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&commands).unwrap());
    let config = session_host::SessionSpawnConfig {
        executable: executable.to_string_lossy().into_owned(), agent_dir: Some(dir.to_path_buf()), session_dir: None, bridge_asset: bridge,
        artifacts_asset: None, chat_asset: None, chat_asset_sha256: None,
        shape: session_host::SessionSpawnShape::Project { tool_args: None },
        initial_model: None, thinking_level: None,
        extra_args: vec!["--mock-session-id".into(), id.clone(), "--mock-commands".into(), encoded],
    };
    host.state.registry.start(&id, &file, &id, &cwd, &config).unwrap();
    id
}

#[cfg(unix)]
#[test]
fn static_shutdown_wakes_ack_and_quiet_relays() {
    let (dir, host) = fixture_host();
    let id = start_mock_session(&host, dir.path());
    let (session_channel, session_rx) = channel();
    let session = subscribe_session_events(&host.state, id.clone(), session_channel);
    assert!(session["subscriptionId"].is_string(), "{session}");
    session_rx.recv_timeout(Duration::from_secs(2)).unwrap(); // no ACK
    let (quiet_session_channel, quiet_session_rx) = channel();
    let quiet_session = subscribe_session_events(&host.state, id, quiet_session_channel);
    let frame = quiet_session_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let ack = host.state.event_relays.lock().unwrap().get(quiet_session["subscriptionId"].as_str().unwrap()).unwrap().ack.clone().unwrap();
    assert!(ack.acknowledge(frame["seq"].as_u64().unwrap()));
    let (running_channel, running_rx) = channel();
    let running = subscribe_running(&host.state, running_channel, Duration::from_secs(60));
    let running_frame = running_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let running_id = running["subscriptionId"].as_str().unwrap();
    let ack = host.state.event_relays.lock().unwrap().get(running_id).unwrap().ack.clone().unwrap();
    assert!(ack.acknowledge(running_frame["seq"].as_u64().unwrap())); // quiet wait
    let (unacked_running_channel, unacked_running_rx) = channel();
    subscribe_running(&host.state, unacked_running_channel, Duration::from_secs(60));
    unacked_running_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let (scheduled_channel, scheduled_rx) = channel();
    let scheduled = host.state.scheduled_events.subscribe(scheduled_channel).unwrap();
    let frame = scheduled_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(host.state.scheduled_events.acknowledge(&scheduled, 1, frame["seq"].as_u64().unwrap()));
    let (unacked_scheduled_channel, unacked_scheduled_rx) = channel();
    host.state.scheduled_events.subscribe(unacked_scheduled_channel).unwrap();
    unacked_scheduled_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let started = Instant::now();
    let result = host.shutdown_until(started + Duration::from_secs(3));
    let report = host.tracked().unwrap();
    let relays = report.relays.as_ref().unwrap();
    assert!(relays.is_complete(), "{relays:?}, {result:?}");
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(Arc::clone(&host.state.session_relay_gate).try_acquire_owned().is_err());
    assert!(Arc::clone(&host.state.running_relay_gate).try_acquire_owned().is_err());
    assert!(host.state.scheduled_events.subscribe(channel().0).is_err());
}

#[cfg(unix)]
#[test]
fn static_shutdown_tracks_session_start_before_registration() {
    let (dir, host) = fixture_host();
    let id = start_mock_session(&host, dir.path());
    let state = Arc::clone(&host.state);
    let guard = state.event_relays.lock().unwrap();
    let starter_state = Arc::clone(&state);
    let starter = std::thread::spawn(move || subscribe_session_events(&starter_state, id, channel().0));
    let wait = Instant::now() + Duration::from_secs(2);
    while state.session_relay_gate.available_permits() == IPC_MAX_SESSION_RELAYS && Instant::now() < wait { std::thread::sleep(Duration::from_millis(1)); }
    let reserved = state.session_relay_gate.available_permits() < IPC_MAX_SESSION_RELAYS;
    let result = host.shutdown_until(Instant::now() + Duration::from_millis(100));
    let report = host.tracked().unwrap().relays.clone();
    drop(guard);
    starter.join().unwrap();
    let drained = state.drain_stream_relays_until(Instant::now() + Duration::from_secs(2));
    assert!(reserved);
    assert!(result.unwrap_err().iter().any(|f| f.name == "stream-relays"));
    assert_eq!(report.unwrap().session.in_flight, 1);
    assert!(drained.is_complete(), "{drained:?}");
}

struct Release(Option<mpsc::Sender<()>>);
impl Drop for Release { fn drop(&mut self) { if let Some(tx) = self.0.take() { let _ = tx.send(()); } } }

#[cfg(unix)]
#[test]
fn static_shutdown_reports_blocked_channel_until_released() {
    for kind in ["session", "running", "scheduled"] {
    let (dir, host) = fixture_host();
    let session_id = (kind == "session").then(|| start_mock_session(&host, dir.path()));
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let release = Release(Some(release_tx));
    let release_rx = Mutex::new(release_rx);
    let blocked = Channel::new(move |_| {
        let _ = entered_tx.send(());
        let _ = release_rx.lock().unwrap().recv();
        Ok(())
    });
    let reply = match kind {
        "session" => subscribe_session_events(&host.state, session_id.unwrap(), blocked),
        "running" => subscribe_running(&host.state, blocked, Duration::from_secs(60)),
        _ => json!({"subscriptionId": host.state.scheduled_events.subscribe(blocked).unwrap()}),
    };
    let entered = entered_rx.recv_timeout(Duration::from_secs(2));
    let started = Instant::now();
    let result = host.shutdown_until(started + Duration::from_millis(80));
    let counts = host.tracked().unwrap().relays.clone();
    drop(release); // release even if subsequent assertions fail
    let drained = host.state.drain_stream_relays_until(Instant::now() + Duration::from_secs(2));
    assert!(reply["subscriptionId"].is_string());
    entered.unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(result.unwrap_err().iter().any(|f| f.name == "stream-relays"));
    let counts = counts.unwrap();
    assert_eq!(match kind { "session" => counts.session.in_flight, "running" => counts.running.in_flight, _ => counts.scheduled.in_flight }, 1, "{kind}");
    assert!(drained.is_complete(), "{kind}: {drained:?}");
    }
}

#[test]
fn static_shutdown_registry_busy_and_starting_reservation_are_unknown() {
    let (_dir, host) = fixture_host();
    let state = Arc::clone(&host.state);
    let guard = state.event_relays.lock().unwrap();
    let (ready_tx, ready_rx) = mpsc::channel();
    let scheduled = Arc::clone(&state.scheduled_events);
    let (release_tx, release_rx) = mpsc::channel();
    let holder = std::thread::spawn(move || scheduled.hold_registry_for_test(ready_tx, release_rx));
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let starter_state = Arc::clone(&state);
    let starter = std::thread::spawn(move || subscribe_running(&starter_state, channel().0, Duration::from_secs(60)));
    let scheduled_state = Arc::clone(&state.scheduled_events);
    let scheduled_starter = std::thread::spawn(move || scheduled_state.subscribe(channel().0));
    let wait = Instant::now() + Duration::from_secs(2);
    while (state.running_relay_gate.available_permits() == IPC_MAX_RUNNING_RELAYS || state.scheduled_events.in_flight() == 0) && Instant::now() < wait { std::thread::sleep(Duration::from_millis(1)); }
    let reserved = state.running_relay_gate.available_permits() < IPC_MAX_RUNNING_RELAYS && state.scheduled_events.in_flight() == 1;
    let started = Instant::now();
    let result = host.shutdown_until(started + Duration::from_millis(80));
    let report = host.tracked().unwrap().relays.clone();
    drop(guard);
    let _ = release_tx.send(());
    holder.join().unwrap();
    starter.join().unwrap();
    scheduled_starter.join().unwrap().unwrap();
    let drained = state.drain_stream_relays_until(Instant::now() + Duration::from_secs(2));
    assert!(reserved);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(result.unwrap_err().iter().any(|f| f.name == "stream-relays"));
    let report = report.unwrap();
    assert_eq!(report.running.in_flight, 1);
    assert_eq!(report.scheduled.in_flight, 1);
    assert!(report.session.registry_busy && report.running.registry_busy && report.scheduled.registry_busy);
    assert!(drained.is_complete(), "{drained:?}");
}
