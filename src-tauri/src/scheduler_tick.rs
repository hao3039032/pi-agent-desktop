//! One scheduler pass. The caller supplies wall time and owns the timer.
use std::sync::Arc;
use serde_json::json;
use task_scheduler::task_repository::{SlotClaim, TaskRepository};
use crate::pi_ipc::{management_call, IpcHostState};

#[cfg(unix)]
pub(crate) fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else { return false };
    if pid <= 0 { return false; }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
#[cfg(windows)]
pub(crate) fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process == 0 {
            // Access denied means the process may still exist; only the OS's
            // invalid-PID result proves it is gone.
            return std::io::Error::last_os_error().raw_os_error() != Some(ERROR_INVALID_PARAMETER as i32);
        }
        let mut exit_code = 0;
        let queried = GetExitCodeProcess(process, &mut exit_code);
        CloseHandle(process);
        queried == 0 || exit_code == STILL_ACTIVE
    }
}
#[cfg(not(any(unix, windows)))]
pub(crate) fn pid_alive(_pid: u32) -> bool { true }

pub fn tick(state: &Arc<IpcHostState>, now_ms: i64) -> Result<bool, String> {
    if state.scheduled_lifecycle.is_closing() { return Ok(false); }
    let agent = state.agent_dir();
    let pid = std::process::id();
    let acquired_at = std::time::Instant::now();
    if !task_scheduler::lease::acquire(&agent, pid, now_ms, pid_alive)? { return Ok(false); }
    let repo = TaskRepository::new(&agent);
    let now = task_scheduler::store::ms_to_iso(now_ms);
    let tasks = repo.list()?;
    let mut active = state.scheduled_active.lock().unwrap().clone();
    // A failed ledger/setup path can leave a claimed run unresolved even
    // after its worker unwound. Do not reinterpret it as an orphan.
    active.extend(state.scheduled_lifecycle.snapshot()?.into_iter().map(|(id, _, _, _)| id));
    for task in &tasks {
        let Some(task_id) = task["id"].as_str() else { continue };
        if repo.runs(task_id)?.iter().any(|run| orphaned(run, pid, &active)) {
            repo.mutate_runs(task_id, |runs| {
                for run in runs.iter_mut().filter(|run| orphaned(run, pid, &active)) {
                    run["status"] = json!("aborted");
                    run["endedAt"] = json!(now);
                    run["error"] = json!("Interrupted: the app closed during the run");
                    run["errorCode"] = json!("interrupted");
                }
                Ok(())
            })?;
            state.scheduled_events.emit(json!({ "type": "task_changed", "taskId": task_id }));
        }
    }
    for task in tasks {
        if task["enabled"] != true || !matches!(task["schedule"]["kind"].as_str(), Some("cron" | "once")) { continue; }
        let Some(since) = task["lastScheduledFor"].as_str().or_else(|| task["createdAt"].as_str()) else { continue };
        let decision = management_call(state, "tasks.decideSlot", json!({ "task": task, "now": now, "since": since }))
            .map_err(|(_, message)| message)?;
        if decision["valid"] != true {
            eprintln!("skipping invalid scheduled task {}: {}", task["id"], decision["error"].as_str().unwrap_or("invalid schedule"));
            continue;
        }
        let action = decision["action"].as_str().unwrap_or("none");
        if action != "fire" && action != "drop" { continue; }
        let slot = decision["scheduledFor"].as_str().ok_or("slot decision omitted scheduledFor")?;
        let task_id = task["id"].as_str().ok_or("task missing id")?;
        let run_id = crate::scheduled_runner::new_run_id()?;
        let mut tracking = match state.scheduled_lifecycle.admit(&run_id) {
            Ok(tracking) => tracking,
            Err(_) if state.scheduled_lifecycle.is_closing() => break,
            Err(error) => return Err(error.into()),
        };
        let trigger = decision["trigger"].as_str().unwrap_or("schedule");
        let mut run = json!({ "runId": run_id, "taskId": task_id, "trigger": trigger, "scheduledFor": slot,
            "startedAt": now, "status": "running", "pid": pid });
        if let Some(skipped) = decision["skippedSlots"].as_u64().filter(|n| *n > 0) { run["skippedSlots"] = json!(skipped); }
        let claim_now = now_ms.saturating_add(acquired_at.elapsed().as_millis().min(i64::MAX as u128) as i64);
        state.scheduled_active.lock().unwrap().insert(run_id.clone());
        tracking.claimed();
        let claim = match repo.claim_slot(&task, slot, run, action == "drop", claim_now, pid) {
            Ok(claim) => claim,
            Err(error) => { state.scheduled_active.lock().unwrap().remove(&run_id); return Err(error); }
        };
        match claim {
            SlotClaim::Fired(record) => {
                let state = Arc::clone(state);
                let task_for_thread = task.clone();
                let record_for_thread = record.clone();
                let state_for_thread = Arc::clone(&state);
                if let Err(error) = std::thread::Builder::new().name(format!("scheduled-spawn-{run_id}")).spawn(move || {
                    if let Err(error) = crate::scheduled_runner::spawn_claimed(&state_for_thread, task_for_thread, record_for_thread, tracking) {
                        eprintln!("scheduled run could not complete setup: {error}");
                    }
                }) {
                    state.scheduled_active.lock().unwrap().remove(&run_id);
                    crate::scheduled_runner::fail_claimed(&state, &task, &record, error.to_string())?;
                }
            }
            SlotClaim::Skipped(record) => {
                tracking.resolved();
                state.scheduled_active.lock().unwrap().remove(&run_id);
                state.scheduled_events.emit(json!({ "type": "run_skipped", "taskId": task_id,
                    "runId": record["runId"], "skipReason": record["skipReason"] }));
                state.scheduled_events.emit(json!({ "type": "task_changed", "taskId": task_id }));
            }
            SlotClaim::Deferred | SlotClaim::Lost => { tracking.resolved(); state.scheduled_active.lock().unwrap().remove(&run_id); }
        }
    }
    Ok(true)
}

fn orphaned(run: &serde_json::Value, current_pid: u32, active: &std::collections::BTreeSet<String>) -> bool {
    if run["status"] != "running" { return false; }
    match run["pid"].as_u64().and_then(|pid| u32::try_from(pid).ok()) {
        Some(pid) if pid == current_pid => run["runId"].as_str().is_none_or(|id| !active.contains(id)),
        Some(pid) => !pid_alive(pid),
        None => true,
    }
}

/// Starts independently of any window. Product startup is wired by the M5
/// static-host switch, not by the still-active Next-based shell.
pub struct SchedulerLoop {
    stop: std::sync::mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
    failed: bool,
}
impl SchedulerLoop {
    pub fn start(state: Arc<IpcHostState>, interval: std::time::Duration) -> Result<Self, String> {
        if interval.is_zero() { return Err("scheduler interval must be positive".into()); }
        let (stop, receiver) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new().name("scheduled-tick".into()).spawn(move || {
            let mut owner = false;
            loop {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
                let next = match tick(&state, now) {
                    Ok(owner) => owner,
                    Err(error) => { eprintln!("scheduled tick failed: {error}"); false }
                };
                let owns_lease = !state.scheduled_lifecycle.is_closing() && if next { true } else if owner {
                    task_scheduler::lease::info(&state.agent_dir(), now, pid_alive).ok().flatten()
                        .is_some_and(|info| info["pid"].as_u64() == Some(std::process::id() as u64) && info["fresh"] == true)
                } else { false };
                state.scheduler_owner.store(owns_lease, std::sync::atomic::Ordering::SeqCst);
                if owner != owns_lease {
                    owner = owns_lease;
                    state.scheduled_events.emit(json!({ "type": "scheduler_owner", "owner": owner }));
                }
                if matches!(receiver.recv_timeout(interval), Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected)) { break; }
            }
            state.scheduler_owner.store(false, std::sync::atomic::Ordering::SeqCst);
            // Ordinary pause releases after the last tracked run; a final
            // shutdown instead keeps the lease for explicit recovery.
            if owner && !state.scheduled_lifecycle.is_closing() {
                state.scheduled_lifecycle.defer_pause_release(state.agent_dir());
            }
        }).map_err(|error| error.to_string())?;
        Ok(Self { stop, thread: Some(thread), failed: false })
    }
    /// Request that the timer stop after its current tick. This does not
    /// interrupt a tick already blocked in filesystem or management work.
    pub fn begin_shutdown(&self) { let _ = self.stop.send(()); }

    /// Wait only until the caller's shared deadline. A timed-out worker stays
    /// owned here. Success covers only the timer thread, not its runs or host
    /// shutdown; final shutdown retains the lease and ordinary pause defers
    /// release until tracked runs resolve.
    pub fn shutdown_until(&mut self, deadline: std::time::Instant) -> bool {
        self.begin_shutdown();
        loop {
            let Some(thread) = self.thread.as_ref() else { return !self.failed };
            if thread.is_finished() {
                self.failed = self.thread.take().unwrap().join().is_err();
                return !self.failed;
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() { return false; }
            std::thread::sleep(remaining.min(std::time::Duration::from_millis(5)));
        }
    }

    pub fn stop(&mut self) {
        self.begin_shutdown();
        if let Some(thread) = self.thread.take() { self.failed = thread.join().is_err(); }
    }
}
// Never turn a deadline failure into an unbounded join during unwinding/drop.
// The detached thread owns its state; lease disposition follows the loop's
// final-shutdown versus ordinary-pause rules, not Drop.
impl Drop for SchedulerLoop { fn drop(&mut self) { self.begin_shutdown(); } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocked_tick_obeys_shared_deadline_and_retains_worker() {
        let (stop, _receiver) = std::sync::mpsc::channel();
        let (release, blocked) = std::sync::mpsc::channel::<()>();
        let thread = std::thread::spawn(move || { blocked.recv().unwrap(); });
        let mut scheduler = SchedulerLoop { stop, thread: Some(thread), failed: false };
        let start = std::time::Instant::now();
        assert!(!scheduler.shutdown_until(start + std::time::Duration::from_millis(50)));
        assert!(start.elapsed() < std::time::Duration::from_millis(500));
        assert!(scheduler.thread.is_some());
        release.send(()).unwrap();
        assert!(scheduler.shutdown_until(std::time::Instant::now() + std::time::Duration::from_secs(2)));
    }

    #[test]
    fn panicked_worker_remains_unknown_on_repeated_wait() {
        let (stop, _receiver) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(|| panic!("fixture panic"));
        let mut scheduler = SchedulerLoop { stop, thread: Some(thread), failed: false };
        assert!(!scheduler.shutdown_until(std::time::Instant::now() + std::time::Duration::from_secs(2)));
        assert!(!scheduler.shutdown_until(std::time::Instant::now()));
    }

    #[test]
    fn timer_runs_without_a_window_and_releases_lease_on_stop() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let mut scheduler = SchedulerLoop::start(Arc::clone(&state), std::time::Duration::from_millis(20)).unwrap();
        let lock = dir.path().join("scheduled-tasks/scheduler.lock");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !lock.exists() {
            assert!(std::time::Instant::now() < deadline, "scheduler did not acquire its lease");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        scheduler.stop();
        assert!(!lock.exists());
        state.start_scheduler().unwrap();
        state.start_scheduler().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !state.scheduler_owner.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        state.shutdown_scheduler().unwrap();
        assert!(lock.exists(), "final shutdown retains the lease");
    }

    #[test]
    fn host_shutdown_reports_blocked_timer_with_same_deadline() {
        let state = Arc::new(IpcHostState::new());
        let (stop, _receiver) = std::sync::mpsc::channel();
        let (release, blocked) = std::sync::mpsc::channel::<()>();
        let thread = std::thread::spawn(move || { blocked.recv().unwrap(); });
        *state.scheduler_loop.lock().unwrap() = Some(SchedulerLoop { stop, thread: Some(thread), failed: false });
        let start = std::time::Instant::now();
        let report = state.shutdown_scheduler_until(start + std::time::Duration::from_millis(40));
        assert!(!report.stopped);
        assert!(report.active_unknown.iter().any(|item| item.contains("timer still running")), "{report:?}");
        assert!(start.elapsed() < std::time::Duration::from_millis(500));
        release.send(()).unwrap();
        assert!(state.shutdown_scheduler_until(std::time::Instant::now() + std::time::Duration::from_secs(1)).stopped);
    }

    #[test]
    fn ordinary_pause_releases_lease_after_last_active_run() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        state.start_scheduler().unwrap();
        let lock = dir.path().join("scheduled-tasks/scheduler.lock");
        let ready = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !lock.exists() { assert!(std::time::Instant::now() < ready); std::thread::sleep(std::time::Duration::from_millis(5)); }
        let run = state.scheduled_lifecycle.admit("run").unwrap();
        state.stop_scheduler();
        assert!(lock.exists(), "active run still holds lease");
        drop(run);
        assert!(!lock.exists(), "ordinary pause releases when the run finishes");
    }

    #[test]
    fn scheduler_restart_cancels_deferred_pause_release() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        state.start_scheduler().unwrap();
        let lock = dir.path().join("scheduled-tasks/scheduler.lock");
        let ready = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !lock.exists() { assert!(std::time::Instant::now() < ready); std::thread::sleep(std::time::Duration::from_millis(5)); }
        let run = state.scheduled_lifecycle.admit("run").unwrap();
        state.stop_scheduler();
        state.start_scheduler().unwrap();
        drop(run);
        assert!(lock.exists(), "old pause must not release the restarted owner's lease");
        state.stop_scheduler();
        assert!(!lock.exists());
    }

    #[test]
    fn final_shutdown_keeps_lease_and_reports_multiple_active_runs() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        state.start_scheduler().unwrap();
        let lock = dir.path().join("scheduled-tasks/scheduler.lock");
        let ready = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !lock.exists() { assert!(std::time::Instant::now() < ready); std::thread::sleep(std::time::Duration::from_millis(5)); }
        let first = state.scheduled_lifecycle.admit("first").unwrap();
        let second = state.scheduled_lifecycle.admit("second").unwrap();
        let before = std::time::Instant::now();
        let report = state.shutdown_scheduler_until(before + std::time::Duration::from_millis(50));
        assert!(!report.stopped, "{report:?}");
        assert_eq!(report.active_unknown.iter().filter(|line| line.contains("in flight")).count(), 2, "{report:?}");
        assert!(before.elapsed() < std::time::Duration::from_millis(500));
        assert!(lock.exists(), "active runs retain lease");
        drop((first, second));
        assert!(state.shutdown_scheduler_until(std::time::Instant::now() + std::time::Duration::from_secs(1)).stopped);
        assert!(lock.exists(), "final shutdown does not grant lease recovery");
    }

    #[test]
    fn final_shutdown_reports_two_real_session_children_and_unknown_prompts() {
        use base64::Engine as _;
        struct ChildCleanup(Arc<session_host::Session>);
        impl Drop for ChildCleanup { fn drop(&mut self) { self.0.shutdown(std::time::Duration::ZERO); } }
        let Ok(executable) = std::env::var("SCHEDULER_MOCK_PI") else { eprintln!("skipping: SCHEDULER_MOCK_PI not set"); return };
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("work");
        std::fs::create_dir_all(&cwd).unwrap();
        let state = Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs").canonicalize().unwrap();
        let commands = base64::engine::general_purpose::STANDARD.encode(json!({"commands":[{"name":"pi-web:bridge","source":"extension","sourceInfo":{"path":bridge}}]}).to_string());
        let mut guards = Vec::new();
        for index in 0..2 {
            let (file, id) = session_host::create_session_file(&dir.path().join("sessions"), &cwd).unwrap();
            let config = session_host::SessionSpawnConfig {
                executable: executable.clone(), agent_dir: Some(dir.path().to_path_buf()), session_dir: None,
                bridge_asset: bridge.clone(), artifacts_asset: None, chat_asset: None, chat_asset_sha256: None,
                shape: session_host::SessionSpawnShape::Project { tool_args: None }, initial_model: None,
                thinking_level: None, extra_args: vec!["--mock-session-id".into(), id.clone(), "--mock-commands".into(), commands.clone(), "--mock-stay-after-eof".into()],
            };
            let child = ChildCleanup(state.registry.start(&id, &file, &id, &cwd, &config).unwrap());
            let mut guard = state.scheduled_lifecycle.admit(&format!("run-{index}")).unwrap();
            guard.claimed();
            guard.set_session(&id).unwrap();
            child.0.command("prompt", json!({"message":"fake provider"}), Some(std::time::Duration::from_secs(2))).unwrap();
            guards.push((guard, id, child));
        }
        let started = std::time::Instant::now();
        let report = state.shutdown_scheduler_until(started + std::time::Duration::from_millis(150));
        assert!(started.elapsed() < std::time::Duration::from_millis(700));
        assert!(!report.stopped, "{report:?}");
        for (_, id, _) in &guards {
            assert!(report.active_unknown.iter().any(|item| item.contains(id) && item.contains("prompt")), "{report:?}");
        }
        for (mut guard, _, _child) in guards { guard.resolved(); }
    }

    #[test]
    fn manual_starts_are_registered_before_lifecycle_lock() {
        let state = Arc::new(IpcHostState::new());
        state.scheduler_owner.store(true, std::sync::atomic::Ordering::SeqCst);
        let lifecycle = state.scheduler_lifecycle.lock().unwrap();
        let workers: Vec<_> = (0..2).map(|_| {
            let state = Arc::clone(&state);
            std::thread::spawn(move || crate::scheduled_runner::run_now(&state, "not-read"))
        }).collect();
        let ready = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while state.scheduled_lifecycle.snapshot().unwrap().len() != 2 {
            assert!(std::time::Instant::now() < ready);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let report = state.shutdown_scheduler_until(std::time::Instant::now() + std::time::Duration::from_millis(50));
        assert!(!report.stopped);
        assert!(report.active_unknown.iter().any(|item| item.contains("lifecycle busy")), "{report:?}");
        assert_eq!(report.active_unknown.iter().filter(|item| item.contains("in flight")).count(), 2, "{report:?}");
        drop(lifecycle);
        for worker in workers { assert!(worker.join().unwrap().is_err()); }
        assert!(state.shutdown_scheduler_until(std::time::Instant::now() + std::time::Duration::from_secs(1)).stopped);
    }

    #[test]
    fn failed_recovery_never_publishes_owner() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("scheduled-tasks.json"), "{broken").unwrap();
        let state = Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let mut scheduler = SchedulerLoop::start(Arc::clone(&state), std::time::Duration::from_millis(20)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(!state.scheduler_owner.load(std::sync::atomic::Ordering::SeqCst));
        scheduler.stop();
    }

    #[test]
    fn pid_liveness_recognizes_self_and_impossible_pid() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(u32::MAX));
    }

    #[test]
    fn owner_recovers_own_orphan_before_admitting_new_runs() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let repo = TaskRepository::new(dir.path());
        let id = "12345678-1234-1234-1234-123456789abc";
        repo.mutate(|tasks| { tasks.push(json!({ "id": id, "name": "x", "prompt": "p", "cwd": "/tmp", "schedule": { "kind": "manual" }, "enabled": true })); Ok(()) }).unwrap();
        repo.mutate_runs(id, |runs| { runs.push(json!({ "runId": "orphan", "taskId": id, "pid": std::process::id(), "status": "running" })); Ok(()) }).unwrap();
        state.start_scheduler().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !state.scheduler_owner.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(repo.runs(id).unwrap()[0]["errorCode"], "interrupted");
        state.stop_scheduler();
    }
}
