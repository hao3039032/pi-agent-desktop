//! Final shutdown admission and in-memory scheduled run tracking.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub struct ScheduledLifecycle {
    closing: AtomicBool,
    entries: Mutex<Tracking>,
}
#[derive(Default)]
struct Tracking {
    runs: BTreeMap<String, RunState>,
    pending_release: Option<std::path::PathBuf>,
    releasing: bool,
    release_failed: bool,
}
#[derive(Clone)]
struct RunState { session: Option<String>, unresolved: bool }
pub(crate) struct ScheduledRunGuard { lifecycle: Arc<ScheduledLifecycle>, id: String, claimed: bool, resolved: bool }

impl ScheduledLifecycle {
    pub fn begin_shutdown(&self) { self.closing.store(true, Ordering::SeqCst); }
    pub fn is_closing(&self) -> bool { self.closing.load(Ordering::SeqCst) }
    pub(crate) fn admit(self: &Arc<Self>, id: &str) -> Result<ScheduledRunGuard, &'static str> {
        let mut entries = self.entries.lock().map_err(|_| "scheduled run tracking unavailable")?;
        if self.is_closing() { return Err("Scheduler is shutting down"); }
        if entries.releasing || entries.release_failed { return Err("scheduler lease release in progress or unresolved"); }
        if entries.runs.contains_key(id) { return Err("duplicate scheduled run id"); }
        if entries.runs.len() >= 128 { return Err("scheduled run tracking capacity reached"); }
        entries.runs.insert(id.to_string(), RunState { session: None, unresolved: false });
        Ok(ScheduledRunGuard { lifecycle: Arc::clone(self), id: id.to_string(), claimed: false, resolved: false })
    }
    pub(crate) fn snapshot(&self) -> Result<Vec<(String, Option<String>, bool)>, &'static str> {
        self.entries.try_lock().map(|entries| {
            let mut snapshot: Vec<_> = entries.runs.iter().map(|(id, state)| (id.clone(), state.session.clone(), state.unresolved)).collect();
            if entries.releasing || entries.release_failed { snapshot.push(("scheduler lease release".into(), None, entries.release_failed)); }
            snapshot
        }).map_err(|_| "scheduled run tracking unavailable or busy")
    }
    /// Starting a new timer cancels a deferred pause release; a release
    /// already executing is allowed to finish before a new owner is started.
    pub(crate) fn prepare_start(&self) -> Result<(), &'static str> {
        let mut entries = self.entries.lock().map_err(|_| "scheduled run tracking unavailable")?;
        if self.is_closing() { return Err("Scheduler is shutting down"); }
        if entries.releasing || entries.release_failed { return Err("scheduler lease release in progress or unresolved"); }
        entries.pending_release = None;
        Ok(())
    }
    pub(crate) fn defer_pause_release(&self, agent: std::path::PathBuf) {
        let release = if let Ok(mut entries) = self.entries.lock() {
            entries.pending_release = Some(agent);
            self.take_ready_release(&mut entries)
        } else { None };
        self.finish_release(release);
    }
    fn take_ready_release(&self, entries: &mut Tracking) -> Option<std::path::PathBuf> {
        if self.is_closing() || entries.releasing || !entries.runs.is_empty() { return None; }
        let path = entries.pending_release.take()?;
        entries.releasing = true;
        Some(path)
    }
    fn finish_release(&self, path: Option<std::path::PathBuf>) {
        let Some(path) = path else { return };
        let result = task_scheduler::lease::release(&path, std::process::id());
        if let Ok(mut entries) = self.entries.lock() {
            entries.releasing = false;
            if result.is_err() { entries.pending_release = Some(path); entries.release_failed = true; }
        }
        if let Err(error) = result { eprintln!("scheduler lease release failed: {error}"); }
    }
}
impl ScheduledRunGuard {
    pub(crate) fn set_session(&self, id: &str) -> Result<(), &'static str> {
        let mut entries = self.lifecycle.entries.lock().map_err(|_| "scheduled run tracking unavailable")?;
        entries.runs.get_mut(&self.id).ok_or("scheduled run tracking lost")?.session = Some(id.to_string());
        Ok(())
    }
    pub(crate) fn claimed(&mut self) { self.claimed = true; }
    pub(crate) fn resolved(&mut self) { self.resolved = true; }
}
impl Drop for ScheduledRunGuard {
    fn drop(&mut self) {
        let release = if let Ok(mut entries) = self.lifecycle.entries.lock() {
            if self.claimed && !self.resolved {
                if let Some(state) = entries.runs.get_mut(&self.id) { state.unresolved = true; }
            } else { entries.runs.remove(&self.id); }
            self.lifecycle.take_ready_release(&mut entries)
        } else { None };
        self.lifecycle.finish_release(release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shutdown_reports_busy_tracking_without_waiting_past_deadline() {
        let state = crate::pi_ipc::IpcHostState::new();
        let lock = state.scheduled_lifecycle.entries.lock().unwrap();
        let start = std::time::Instant::now();
        let report = state.shutdown_scheduler_until(start + std::time::Duration::from_millis(30));
        assert!(!report.stopped);
        assert!(report.active_unknown.iter().any(|item| item.contains("tracking unavailable or busy")), "{report:?}");
        assert!(start.elapsed() < std::time::Duration::from_millis(500));
        drop(lock);
    }

    #[test]
    fn failed_pause_release_is_unknown_and_blocks_restart() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("scheduled-tasks")).unwrap();
        std::fs::write(dir.path().join("scheduled-tasks/scheduler.lock"), "{broken").unwrap();
        let lifecycle = ScheduledLifecycle::default();
        lifecycle.defer_pause_release(dir.path().to_path_buf());
        assert!(lifecycle.prepare_start().is_err());
        assert_eq!(lifecycle.snapshot().unwrap(), vec![("scheduler lease release".into(), None, true)]);
    }

    #[test]
    fn busy_tracking_is_unknown_and_unresolved_claim_is_retained() {
        let lifecycle = Arc::new(ScheduledLifecycle::default());
        let mut guard = lifecycle.admit("run").unwrap();
        guard.claimed();
        let lock = lifecycle.entries.lock().unwrap();
        assert!(lifecycle.snapshot().is_err());
        lifecycle.begin_shutdown();
        drop(lock);
        drop(guard);
        assert_eq!(lifecycle.snapshot().unwrap(), vec![("run".into(), None, true)]);
        assert!(lifecycle.admit("late").is_err());
    }
}
