//! One scheduler pass. The caller supplies wall time and owns the timer.
use std::sync::Arc;
use serde_json::json;
use task_scheduler::task_repository::{SlotClaim, TaskRepository};
use crate::pi_ipc::{management_call, IpcHostState};

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else { return false };
    if pid <= 0 { return false; }
    let result = unsafe { libc::kill(pid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool { true }

pub fn tick(state: &Arc<IpcHostState>, now_ms: i64) -> Result<bool, String> {
    let agent = state.agent_dir();
    let pid = std::process::id();
    if !task_scheduler::lease::acquire(&agent, pid, now_ms, pid_alive)? { return Ok(false); }
    let repo = TaskRepository::new(&agent);
    let now = task_scheduler::store::ms_to_iso(now_ms);
    let tasks = repo.list()?;
    for task in &tasks {
        let Some(task_id) = task["id"].as_str() else { continue };
        if repo.runs(task_id)?.iter().any(|run| orphaned(run, pid)) {
            repo.mutate_runs(task_id, |runs| {
                for run in runs.iter_mut().filter(|run| orphaned(run, pid)) {
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
        if task["enabled"] != true || task["schedule"]["kind"] == "manual" { continue; }
        let Some(since) = task["lastScheduledFor"].as_str().or_else(|| task["createdAt"].as_str()) else { continue };
        let decision = management_call(state, "tasks.decideSlot", json!({ "task": task, "now": now, "since": since }))
            .map_err(|(_, message)| message)?;
        let action = decision["action"].as_str().unwrap_or("none");
        if action != "fire" && action != "drop" { continue; }
        let slot = decision["scheduledFor"].as_str().ok_or("slot decision omitted scheduledFor")?;
        let task_id = task["id"].as_str().ok_or("task missing id")?;
        let run_id = crate::scheduled_runner::new_run_id()?;
        let trigger = decision["trigger"].as_str().unwrap_or("schedule");
        let mut run = json!({ "runId": run_id, "taskId": task_id, "trigger": trigger, "scheduledFor": slot,
            "startedAt": now, "status": "running", "pid": pid });
        if let Some(skipped) = decision["skippedSlots"].as_u64().filter(|n| *n > 0) { run["skippedSlots"] = json!(skipped); }
        match repo.claim_slot(&task, slot, run, action == "drop", now_ms, pid)? {
            SlotClaim::Fired(record) => {
                let state = Arc::clone(state);
                let task_for_thread = task.clone();
                let record_for_thread = record.clone();
                let state_for_thread = Arc::clone(&state);
                if let Err(error) = std::thread::Builder::new().name(format!("scheduled-spawn-{run_id}")).spawn(move || {
                    if let Err(error) = crate::scheduled_runner::spawn_claimed(&state_for_thread, task_for_thread, record_for_thread) {
                        eprintln!("scheduled run could not complete setup: {error}");
                    }
                }) {
                    crate::scheduled_runner::fail_claimed(&state, &task, &record, error.to_string())?;
                }
            }
            SlotClaim::Skipped(record) => {
                state.scheduled_events.emit(json!({ "type": "run_skipped", "taskId": task_id,
                    "runId": record["runId"], "skipReason": record["skipReason"] }));
                state.scheduled_events.emit(json!({ "type": "task_changed", "taskId": task_id }));
            }
            SlotClaim::Deferred | SlotClaim::Lost => {}
        }
    }
    Ok(true)
}

fn orphaned(run: &serde_json::Value, current_pid: u32) -> bool {
    if run["status"] != "running" { return false; }
    match run["pid"].as_u64().and_then(|pid| u32::try_from(pid).ok()) {
        Some(pid) if pid == current_pid => false,
        Some(pid) => !pid_alive(pid),
        None => true,
    }
}

/// Starts independently of any window. Not registered at product startup until
/// migration integration proves exclusive upgrade from unpatched old binaries.
pub struct SchedulerLoop {
    stop: std::sync::mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
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
                if owner != next {
                    owner = next;
                    state.scheduled_events.emit(json!({ "type": "scheduler_owner", "owner": owner }));
                }
                if receiver.recv_timeout(interval).is_ok() { break; }
            }
            if let Err(error) = task_scheduler::lease::release(&state.agent_dir(), std::process::id()) {
                eprintln!("scheduler lease release failed: {error}");
            }
        }).map_err(|error| error.to_string())?;
        Ok(Self { stop, thread: Some(thread) })
    }
    pub fn stop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}
impl Drop for SchedulerLoop { fn drop(&mut self) { self.stop(); } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timer_runs_without_a_window_and_releases_lease_on_stop() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
        let mut scheduler = SchedulerLoop::start(state, std::time::Duration::from_millis(20)).unwrap();
        let lock = dir.path().join("scheduled-tasks/scheduler.lock");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while !lock.exists() {
            assert!(std::time::Instant::now() < deadline, "scheduler did not acquire its lease");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        scheduler.stop();
        assert!(!lock.exists());
    }
}
