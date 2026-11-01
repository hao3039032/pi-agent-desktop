//! Admission and shutdown tracking for the fixed short-lived session writer.
//! This is not a replacement for its durable source/target fences.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct SessionWriterLifecycle {
    closing: AtomicBool,
    entries: Mutex<BTreeMap<String, WriterState>>,
}
#[derive(Clone, Copy)]
enum WriterState { Preparing, Started, Unknown, Completed }

#[derive(Debug, Default)]
pub struct SessionWriterShutdownReport { pub exited: Vec<String>, pub unknown: Vec<String> }

pub(crate) struct WriterGuard { lifecycle: Arc<SessionWriterLifecycle>, operation: String, started: bool, complete: bool }

impl SessionWriterLifecycle {
    pub(crate) fn admit(self: &Arc<Self>, operation: &str) -> Result<WriterGuard, &'static str> {
        if operation.is_empty() { return Err("invalid session writer operation"); }
        let mut entries = self.entries.lock().map_err(|_| "session writer admission unavailable")?;
        if self.closing.load(Ordering::SeqCst) { return Err("session writer host is shutting down"); }
        if entries.contains_key(operation) { return Err("duplicate session writer operation"); }
        if entries.len() >= 128 { return Err("session writer tracking capacity reached"); }
        entries.insert(operation.to_string(), WriterState::Preparing);
        Ok(WriterGuard { lifecycle: Arc::clone(self), operation: operation.to_string(), started: false, complete: false })
    }
    pub fn begin_shutdown(&self) { self.closing.store(true, Ordering::SeqCst); }
    /// Reports pending admissions and unresolved operations; no child is killed
    /// here. `exited` means the operation completed its own exit/fence checks,
    /// not that arbitrary descendants or other writers stopped.
    pub fn shutdown_until(&self, deadline: Instant) -> SessionWriterShutdownReport {
        self.begin_shutdown();
        loop {
            match self.entries.try_lock() {
                Ok(entries) => {
                    let mut report = SessionWriterShutdownReport::default();
                    for (id, state) in entries.iter() {
                        match state {
                            WriterState::Completed => report.exited.push(id.clone()),
                            state => report.unknown.push(format!("{id}: {}", match state {
                                WriterState::Preparing => "writer admission in flight",
                                WriterState::Started => "writer or result verification in flight",
                                WriterState::Unknown => "writer outcome unresolved; inspect session fences",
                                WriterState::Completed => unreachable!(),
                            })),
                        }
                    }
                    if report.unknown.is_empty() || Instant::now() >= deadline || entries.values().any(|state| matches!(state, WriterState::Unknown)) { return report; }
                }
                Err(std::sync::TryLockError::Poisoned(_)) => return SessionWriterShutdownReport { unknown: vec!["session writer registry poisoned".into()], ..Default::default() },
                Err(std::sync::TryLockError::WouldBlock) => {},
            }
            let Some(left) = deadline.checked_duration_since(Instant::now()) else { return SessionWriterShutdownReport { unknown: vec!["session writer registry busy".into()], ..Default::default() } };
            std::thread::sleep(left.min(Duration::from_millis(2)));
        }
    }
}
impl WriterGuard {
    /// Call only after the operation's durable fences exist, before spawn.
    pub(crate) fn before_spawn(&mut self) -> Result<(), &'static str> {
        let mut entries = self.lifecycle.entries.lock().map_err(|_| "session writer admission unavailable")?;
        if self.lifecycle.closing.load(Ordering::SeqCst) { return Err("session writer host is shutting down"); }
        let state = entries.get_mut(&self.operation).ok_or("session writer admission missing")?;
        *state = WriterState::Started;
        self.started = true;
        Ok(())
    }
    /// Only after leader exit, result validation, and own fence completion.
    pub(crate) fn complete(mut self) {
        self.complete = true;
    }
}
impl Drop for WriterGuard {
    fn drop(&mut self) {
        let Ok(mut entries) = self.lifecycle.entries.lock() else { return };
        if self.complete && self.lifecycle.closing.load(Ordering::SeqCst) {
            if let Some(state) = entries.get_mut(&self.operation) { *state = WriterState::Completed; }
        } else if self.complete || !self.started { entries.remove(&self.operation); }
        else if let Some(state) = entries.get_mut(&self.operation) { *state = WriterState::Unknown; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shutdown_fences_spawn_and_reports_prior_admission() {
        let host = Arc::new(SessionWriterLifecycle::default());
        let mut guard = host.admit("op").unwrap();
        let report = host.shutdown_until(Instant::now() + Duration::from_millis(10));
        assert!(report.unknown[0].contains("admission in flight"));
        assert!(guard.before_spawn().is_err());
        drop(guard);
        assert!(host.admit("next").is_err());
        assert!(host.shutdown_until(Instant::now()).unknown.is_empty());
    }
    #[test]
    fn unfinished_started_writer_remains_unknown() {
        let host = Arc::new(SessionWriterLifecycle::default());
        let mut guard = host.admit("op").unwrap();
        guard.before_spawn().unwrap();
        drop(guard);
        assert!(host.shutdown_until(Instant::now()).unknown[0].contains("unresolved"));
    }
    #[test]
    fn completed_writer_releases_admission() {
        let host = Arc::new(SessionWriterLifecycle::default());
        let mut guard = host.admit("op").unwrap();
        guard.before_spawn().unwrap();
        guard.complete();
        assert!(host.shutdown_until(Instant::now()).unknown.is_empty());
    }
}
