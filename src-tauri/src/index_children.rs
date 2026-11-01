//! Bounded ownership of direct Git index children. Descendants are not covered.
#[cfg(unix)]
mod unix {
    use std::process::{Child, Command, ExitStatus};
    use std::sync::{Arc, Condvar, Mutex, OnceLock};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    const MAX_CHILDREN: usize = 8;
    struct OwnerState { closing: AtomicBool }
    pub struct IndexChildOwner { inner: Arc<OwnerState> }
    impl Default for IndexChildOwner {
        fn default() -> Self { Self { inner: Arc::new(OwnerState { closing: AtomicBool::new(false) }) } }
    }
    impl Drop for IndexChildOwner { fn drop(&mut self) { self.begin_shutdown(); } }

    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct IndexChildShutdownReport { pub unknown: usize, pub tracker_busy: bool }
    enum State { Active, Reaping(Child) }
    struct Slot { owner: Arc<OwnerState>, state: State }
    struct Tracker { slots: Mutex<Vec<Option<Slot>>>, wake: Condvar }
    static TRACKER: OnceLock<Result<Arc<Tracker>, String>> = OnceLock::new();
    fn tracker() -> Result<&'static Arc<Tracker>, String> {
        TRACKER.get_or_init(|| {
            let tracker = Arc::new(Tracker { slots: Mutex::new((0..MAX_CHILDREN).map(|_| None).collect()), wake: Condvar::new() });
            let worker = Arc::clone(&tracker);
            std::thread::Builder::new().name("file-index-reaper".into()).spawn(move || {
                let mut slots = worker.slots.lock().unwrap_or_else(|e| e.into_inner());
                loop {
                    let mut pending = false;
                    for slot in slots.iter_mut() {
                        if let Some(Slot { state: State::Reaping(child), .. }) = slot {
                            match child.try_wait() {
                                Ok(Some(_)) => { *slot = None; }
                                Ok(None) | Err(_) => pending = true,
                            }
                        }
                    }
                    if pending {
                        let (guard, _) = worker.wake.wait_timeout(slots, Duration::from_millis(50)).unwrap_or_else(|e| e.into_inner());
                        slots = guard;
                    } else {
                        slots = worker.wake.wait(slots).unwrap_or_else(|e| e.into_inner());
                    }
                }
            }).map_err(|e| format!("cannot start index child reaper: {e}"))?;
            Ok(tracker)
        }).as_ref().map_err(Clone::clone)
    }

    impl IndexChildOwner {
        pub fn begin_shutdown(&self) { self.inner.closing.store(true, Ordering::SeqCst); }
        pub fn is_closing(&self) -> bool { self.inner.closing.load(Ordering::SeqCst) }
        pub fn shutdown_until(&self, deadline: Instant) -> IndexChildShutdownReport {
            self.begin_shutdown();
            let tracker = match TRACKER.get() {
                None => return IndexChildShutdownReport { unknown: 0, tracker_busy: false },
                Some(Err(_)) => return IndexChildShutdownReport { unknown: 0, tracker_busy: false },
                Some(Ok(tracker)) => tracker,
            };
            self.shutdown_on(tracker, deadline)
        }
        fn shutdown_on(&self, tracker: &Tracker, deadline: Instant) -> IndexChildShutdownReport {
            loop {
                let result = tracker.slots.try_lock().ok().map(|slots| slots.iter().flatten().filter(|slot| Arc::ptr_eq(&slot.owner, &self.inner)).count());
                match result {
                    Some(0) => return IndexChildShutdownReport { unknown: 0, tracker_busy: false },
                    Some(n) if Instant::now() >= deadline => return IndexChildShutdownReport { unknown: n, tracker_busy: false },
                    None if Instant::now() >= deadline => return IndexChildShutdownReport { unknown: 0, tracker_busy: true },
                    _ => std::thread::sleep(Duration::from_millis(2).min(deadline.saturating_duration_since(Instant::now()))),
                }
            }
        }
        pub fn reserve(&self) -> Result<ChildLease, String> {
            self.reserve_on(Arc::clone(tracker()?))
        }
        fn reserve_on(&self, tracker: Arc<Tracker>) -> Result<ChildLease, String> {
            let mut slots = tracker.slots.try_lock().map_err(|_| "index child tracker busy".to_string())?;
            if self.is_closing() { return Err("index child owner is closing".into()); }
            let index = slots.iter().position(Option::is_none).ok_or("index child capacity exhausted")?;
            slots[index] = Some(Slot { owner: Arc::clone(&self.inner), state: State::Active });
            drop(slots);
            Ok(ChildLease { tracker, index, child: None, released: false })
        }
    }
    pub struct ChildLease { tracker: Arc<Tracker>, index: usize, child: Option<Child>, released: bool }
    impl ChildLease {
        pub fn spawn(&mut self, command: &mut Command) -> std::io::Result<()> {
            self.child = Some(command.spawn()?);
            Ok(())
        }
        pub fn child_mut(&mut self) -> &mut Child { self.child.as_mut().expect("spawned child") }
        fn release(&mut self) {
            let mut slots = self.tracker.slots.lock().unwrap_or_else(|e| e.into_inner());
            slots[self.index] = None;
            self.released = true;
        }
        pub fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
            let status = self.child_mut().try_wait()?;
            if status.is_some() { self.child = None; self.release(); }
            Ok(status)
        }
        pub fn kill(&mut self) { if let Some(child) = self.child.as_mut() { let _ = child.kill(); } }
    }
    impl Drop for ChildLease {
        fn drop(&mut self) {
            if self.released { return; }
            self.kill();
            let mut slots = self.tracker.slots.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(child) = self.child.take() {
                if let Some(slot) = &mut slots[self.index] { slot.state = State::Reaping(child); }
                self.tracker.wake.notify_one();
            } else { slots[self.index] = None; }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn spawn_in_flight_slot_survives_shutdown_until_owner_releases() {
            let owner = Arc::new(IndexChildOwner::default());
            let tracker = Arc::new(Tracker { slots: Mutex::new((0..MAX_CHILDREN).map(|_| None).collect()), wake: Condvar::new() });
            let worker_owner = Arc::clone(&owner);
            let worker_tracker = Arc::clone(&tracker);
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                let lease = worker_owner.reserve_on(worker_tracker).unwrap();
                ready_tx.send(()).unwrap();
                let _ = release_rx.recv();
                drop(lease);
            });
            ready_rx.recv().unwrap();
            let start = Instant::now();
            owner.begin_shutdown();
            let report = owner.shutdown_on(&tracker, start + Duration::from_millis(30));
            let elapsed = start.elapsed();
            let _ = release_tx.send(());
            worker.join().unwrap();
            assert_eq!(report.unknown, 1, "{report:?}");
            assert!(elapsed < Duration::from_secs(1));
            assert_eq!(owner.shutdown_on(&tracker, Instant::now() + Duration::from_secs(1)).unknown, 0);
        }

        #[test]
        fn capacity_owner_isolation_lock_busy_and_deadline() {
            let tracker = Arc::new(Tracker { slots: Mutex::new((0..MAX_CHILDREN).map(|_| None).collect()), wake: Condvar::new() });
            let first = IndexChildOwner::default();
            let second = IndexChildOwner::default();
            let mut leases = Vec::new();
            leases.push(second.reserve_on(Arc::clone(&tracker)).unwrap());
            for _ in 1..MAX_CHILDREN { leases.push(first.reserve_on(Arc::clone(&tracker)).unwrap()); }
            assert!(first.reserve_on(Arc::clone(&tracker)).is_err());
            first.begin_shutdown();
            let report = first.shutdown_on(&tracker, Instant::now());
            assert_eq!(report.unknown, MAX_CHILDREN - 1);
            assert!(!report.tracker_busy);
            drop(leases);
            assert_eq!(first.shutdown_on(&tracker, Instant::now()).unknown, 0);
            let second_lease = second.reserve_on(Arc::clone(&tracker)).unwrap();
            let guard = tracker.slots.lock().unwrap();
            assert!(second.reserve_on(Arc::clone(&tracker)).is_err());
            assert!(second.shutdown_on(&tracker, Instant::now()).tracker_busy);
            drop(guard);
            drop(second_lease);
        }
    }
}
#[cfg(unix)]
pub use unix::{ChildLease, IndexChildOwner, IndexChildShutdownReport};

#[cfg(not(unix))]
#[derive(Default)]
pub struct IndexChildOwner;
#[cfg(not(unix))]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexChildShutdownReport { pub unknown: usize, pub tracker_busy: bool }
#[cfg(not(unix))]
impl IndexChildOwner {
    pub fn begin_shutdown(&self) {}
    pub fn shutdown_until(&self, _: std::time::Instant) -> IndexChildShutdownReport { IndexChildShutdownReport { unknown: 0, tracker_busy: false } }
}
