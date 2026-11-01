//! Task-input admission uses the host fence even on retained instance handles.
use super::*;
use std::os::unix::fs::PermissionsExt;

struct Fixture {
    dir: tempfile::TempDir,
    host: ManagementHost,
    instance: Arc<ManagementInstance>,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("fake-input.cjs");
        std::fs::write(&executable, r##"#!/usr/bin/env node
const fs = require('node:fs');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const command = JSON.parse(line);
  if (command.type !== 'prompt') return;
  const [, rid, token] = command.message.split(' ');
  const payload = JSON.parse(Buffer.from(token, 'base64url'));
  if (payload.op !== '__input') return;
  fs.appendFileSync(process.env.INPUT_MARKER, 'input\n');
  emit({type:'response', id:command.id, command:'prompt', success:true, data:{disposition:'handled'}});
  emit({type:'extension_ui_request', id:rid, method:'notify', message:'PI_WEB_MGMT_V1 ' + JSON.stringify({rid, nonce:process.env.PI_WEB_MGMT_NONCE, ok:true, result:{status:'accepted'}})});
});
"##).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = ManagementSpawnConfig {
            executable: executable.to_string_lossy().into_owned(),
            agent_dir: Some(dir.path().to_path_buf()), extensions: vec![],
            env: vec![("INPUT_MARKER".into(), dir.path().join("inputs").display().to_string())],
        };
        let host = ManagementHost::new();
        let instance = host.instance("global", &config).unwrap();
        // Only the input control protocol is under test, not an SDK login.
        instance.state.lock().unwrap().tasks.insert("fixture-task".into(), Arc::new(Mutex::new(TaskRecord {
            snapshot: TaskSnapshot { status: TaskStatus::Running, progress: None, result: None, error: None, cancel_requested: false },
            finished_at: None, serial_scope: false, blocks_mutations: true, exclusive: false,
            operation: "auth.loginStart".into(), ledger_operation_id: None, mcp_target: None,
            mcp_guard: None, revoked: false, runner: None,
        })));
        Self { dir, host, instance }
    }
    fn inputs(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("inputs")).unwrap_or_default()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { self.host.shutdown_all(Duration::from_secs(1)); }
}

#[test]
fn task_input_has_a_bounded_lane_even_when_ordinary_activity_is_full() {
    let f = Fixture::new();
    let ordinary: Vec<_> = (0..128).map(|_| f.instance.admit().unwrap()).collect();
    assert!(f.instance.admit().is_err());
    assert_eq!(f.instance.submit_task_input("fixture-task", json!({"code":"fake"})).unwrap()["status"], "accepted");
    let controls: Vec<_> = (0..4).map(|_| f.instance.admit_task_input().unwrap()).collect();
    assert!(f.instance.submit_task_input("fixture-task", json!({"code":"fake"})).unwrap_err().contains("capacity"));
    assert_eq!(f.inputs(), "input\n", "saturated input must be rejected before dispatch");
    drop(controls);
    assert_eq!(f.instance.state.lock().unwrap().active, 128);
    drop(ordinary);
    assert_eq!(f.instance.state.lock().unwrap().active, 0);
    assert_eq!(f.instance.state.lock().unwrap().task_inputs, 0);
}

#[test]
fn task_input_old_handle_refuses_after_host_admission_closes() {
    let f = Fixture::new();
    assert_eq!(f.instance.submit_task_input("fixture-task", json!({"code":"fake"})).unwrap()["status"], "accepted");
    assert_eq!(f.instance.state.lock().unwrap().active, 0);
    f.host.begin_shutdown();
    assert!(!f.instance.state.lock().unwrap().closing, "the shared fence, not per-instance close, must suffice");
    let result = f.instance.submit_task_input("fixture-task", json!({"code":"fake"}));
    assert!(result.unwrap_err().contains("closing"));
    assert_eq!(f.inputs(), "input\n", "no second input may reach the child");
}

#[test]
fn task_input_waiting_for_instance_lock_rechecks_shared_close() {
    let f = Fixture::new();
    let guard = f.instance.state.lock().unwrap();
    let instance = Arc::clone(&f.instance);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        ready_tx.send(()).unwrap();
        instance.submit_task_input("fixture-task", json!({"code":"fake"}))
    });
    let ready = ready_rx.recv_timeout(Duration::from_secs(2));
    f.host.begin_shutdown();
    drop(guard);
    let result = worker.join().unwrap();
    ready.unwrap();
    assert!(result.unwrap_err().contains("closing"));
    assert_eq!(f.inputs(), "");
}

#[test]
fn task_input_admitted_before_send_remains_in_shutdown_report() {
    let f = Fixture::new();
    // Hold the dispatch registration, after input admission but before the
    // command can be sent. No extra test-only hook is needed in production.
    let pending = f.instance.pending.lock().unwrap();
    let instance = Arc::clone(&f.instance);
    let worker = std::thread::spawn(move || instance.submit_task_input("fixture-task", json!({"code":"fake"})));
    let until = Instant::now() + Duration::from_secs(2);
    let admitted = loop {
        if f.instance.state.lock().unwrap().active == 1 { break true; }
        if Instant::now() >= until { break false; }
        std::thread::sleep(Duration::from_millis(1));
    };
    let report = f.host.shutdown_until(Instant::now());
    drop(pending); // Release before any assertion or join.
    let result = worker.join().unwrap();
    assert!(admitted, "input must acquire tracked activity before dispatch");
    assert!(report.unknown.iter().any(|entry| entry == "global: 1 operations in flight"), "{report:?}");
    assert!(result.is_err(), "the closed client must not admit the delayed send");
    assert_eq!(f.inputs(), "");
    assert_eq!(f.instance.state.lock().unwrap().active, 0);
}
