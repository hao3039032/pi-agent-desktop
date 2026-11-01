//! Bounded, independent relays for scheduled-task change notifications.
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use crate::pi_ipc::{SessionRelayAck, RELAY_SHUTDOWN_POLL};

const MAX_RELAYS: usize = 32;
const MAX_FRAMES: usize = 256;
const MAX_BYTES: usize = 1024 * 1024;
const MAX_EVENT_BYTES: usize = 64 * 1024;
const ACK_TIMEOUT: Duration = Duration::from_secs(15);

pub struct ScheduledEvents {
    next: AtomicU64,
    alive: Arc<AtomicUsize>,
    gate: Arc<tokio::sync::Semaphore>,
    shutdown: Arc<AtomicBool>,
    subscribers: Arc<Mutex<HashMap<String, Subscriber>>>,
}
impl Default for ScheduledEvents {
    fn default() -> Self {
        Self { next: AtomicU64::new(0), alive: Arc::new(AtomicUsize::new(0)),
            gate: Arc::new(tokio::sync::Semaphore::new(MAX_RELAYS)),
            shutdown: Arc::new(AtomicBool::new(false)), subscribers: Arc::new(Mutex::new(HashMap::new())) }
    }
}
struct Subscriber {
    tx: mpsc::SyncSender<(Value, usize)>,
    bytes: Arc<AtomicUsize>,
    overflowed: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    ack: Arc<SessionRelayAck>,
}
struct Alive(Arc<AtomicUsize>);
impl Drop for Alive { fn drop(&mut self) { self.0.fetch_sub(1, Ordering::SeqCst); } }
struct SizeCounter(usize);
impl std::io::Write for SizeCounter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.checked_add(bytes.len()).filter(|n| *n <= MAX_EVENT_BYTES)
            .ok_or_else(|| std::io::Error::other("event too large"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}
impl ScheduledEvents {
    pub(crate) fn begin_shutdown(&self) {
        self.gate.close();
        self.shutdown.store(true, Ordering::SeqCst);
    }
    pub(crate) fn in_flight(&self) -> usize { MAX_RELAYS - self.gate.available_permits() }
    pub(crate) fn registry_busy(&self) -> bool { self.subscribers.try_lock().is_err() }
    #[cfg(test)]
    pub(crate) fn hold_registry_for_test(&self, ready: mpsc::Sender<()>, release: mpsc::Receiver<()>) {
        let _guard = self.subscribers.lock().unwrap();
        let _ = ready.send(());
        let _ = release.recv();
    }

    pub fn emit(&self, event: Value) {
        let mut counter = SizeCounter(0);
        let size = if serde_json::to_writer(&mut counter, &event).is_ok() { counter.0 } else { MAX_EVENT_BYTES + 1 };
        self.subscribers.lock().unwrap().retain(|_, subscriber| {
            if subscriber.overflowed.load(Ordering::SeqCst) { return true; }
            if size > MAX_EVENT_BYTES || subscriber.bytes.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(size).filter(|n| *n <= MAX_BYTES)).is_err() {
                subscriber.overflowed.store(true, Ordering::SeqCst);
                return true;
            }
            match subscriber.tx.try_send((event.clone(), size)) {
                Ok(()) => true,
                Err(mpsc::TrySendError::Full(_)) => {
                    subscriber.bytes.fetch_sub(size, Ordering::SeqCst);
                    subscriber.overflowed.store(true, Ordering::SeqCst);
                    true
                }
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    subscriber.bytes.fetch_sub(size, Ordering::SeqCst);
                    false
                }
            }
        });
    }
    pub fn unsubscribe(&self, id: &str) {
        if let Some(subscriber) = self.subscribers.lock().unwrap().remove(id) {
            subscriber.stop.store(true, Ordering::SeqCst);
            subscriber.ack.wake();
        }
    }
    pub fn acknowledge(&self, id: &str, epoch: u64, seq: u64) -> bool {
        epoch == 1 && self.subscribers.lock().unwrap().get(id).is_some_and(|subscriber| subscriber.ack.acknowledge(seq))
    }
    pub fn subscribe(&self, channel: Channel<Value>) -> Result<String, String> {
        let permit = Arc::new(Arc::clone(&self.gate).try_acquire_owned().map_err(|_| "scheduled stream capacity exhausted or closed".to_string())?);
        if self.shutdown.load(Ordering::SeqCst) { return Err("scheduled stream admission closed".into()); }
        self.alive.fetch_add(1, Ordering::SeqCst);
        let alive = Alive(Arc::clone(&self.alive));
        let id = format!("tasks-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let (tx, rx) = mpsc::sync_channel(MAX_FRAMES);
        let bytes = Arc::new(AtomicUsize::new(0));
        let overflowed = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let ack = Arc::new(SessionRelayAck::with_shutdown(Arc::clone(&self.shutdown)));
        self.subscribers.lock().unwrap().insert(id.clone(), Subscriber { tx, bytes: Arc::clone(&bytes), overflowed: Arc::clone(&overflowed), stop: Arc::clone(&stop), ack: Arc::clone(&ack) });
        let thread_id = id.clone();
        let subscribers = Arc::clone(&self.subscribers);
        let relay_permit = Arc::clone(&permit);
        let shutdown = Arc::clone(&self.shutdown);
        if let Err(error) = std::thread::Builder::new().name(format!("scheduled-events-{id}")).spawn(move || {
            let _alive = alive;
            let _permit = relay_permit;
            (move || {
            if shutdown.load(Ordering::SeqCst) { subscribers.lock().unwrap().remove(&thread_id); return; }
            let mut seq = 1u64;
            let send = |seq, kind, payload| ack.forward(&channel, json!({ "subscriptionId": thread_id, "epoch": 1, "seq": seq, "kind": kind, "payload": payload }), seq, &stop, ACK_TIMEOUT);
            let mut ok = send(seq, "snapshot", json!({}));
            let mut heartbeat = std::time::Instant::now() + Duration::from_secs(10);
            while ok && !stop.load(Ordering::SeqCst) && !shutdown.load(Ordering::SeqCst) && !overflowed.load(Ordering::SeqCst) {
                let (kind, event) = match rx.recv_timeout(heartbeat.saturating_duration_since(std::time::Instant::now()).min(RELAY_SHUTDOWN_POLL)) {
                    Ok((event, size)) => { bytes.fetch_sub(size, Ordering::SeqCst); ("event", event) },
                    Err(mpsc::RecvTimeoutError::Timeout) if std::time::Instant::now() < heartbeat => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => ("heartbeat", Value::Null),
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                if stop.load(Ordering::SeqCst) || shutdown.load(Ordering::SeqCst) || overflowed.load(Ordering::SeqCst) { break; }
                seq += 1;
                ok = send(seq, kind, event);
                heartbeat = std::time::Instant::now() + Duration::from_secs(10);
            }
            if !stop.load(Ordering::SeqCst) && !shutdown.load(Ordering::SeqCst) {
                let _ = channel.send(json!({ "subscriptionId": thread_id, "epoch": 1, "seq": seq + 1, "kind": "reset", "payload": { "reason": "relay_gap" } }));
            }
            subscribers.lock().unwrap().remove(&thread_id);
            })();
        }) {
            self.unsubscribe(&id);
            return Err(error.to_string());
        }
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    #[test]
    fn ack_validation_and_unsubscribe_release() {
        let events = ScheduledEvents::default();
        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| { if let tauri::ipc::InvokeResponseBody::Json(text) = body { tx.send(text).unwrap(); } Ok(()) });
        let id = events.subscribe(channel).unwrap();
        let frame: Value = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(2)).unwrap()).unwrap();
        assert_eq!(frame["kind"], "snapshot");
        assert!(!events.acknowledge(&id, 2, 1));
        assert!(!events.acknowledge(&id, 1, 2));
        assert!(events.acknowledge(&id, 1, 1));
        events.emit(json!({"type":"task_changed"}));
        let frame: Value = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(2)).unwrap()).unwrap();
        assert_eq!(frame["seq"], 2);
        events.unsubscribe(&id);
        let deadline = Instant::now() + Duration::from_secs(2);
        while events.alive.load(Ordering::SeqCst) != 0 && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(5)); }
        assert_eq!(events.alive.load(Ordering::SeqCst), 0);
        assert!(!events.acknowledge(&id, 1, 2));
    }
    #[test]
    fn relay_limit_counts_until_threads_exit() {
        let events = ScheduledEvents::default();
        let mut ids = Vec::new();
        for _ in 0..MAX_RELAYS {
            ids.push(events.subscribe(Channel::new(|_| Ok(()))).unwrap());
        }
        assert!(events.subscribe(Channel::new(|_| Ok(()))).is_err());
        for id in ids { events.unsubscribe(&id); }
        let deadline = Instant::now() + Duration::from_secs(2);
        while events.alive.load(Ordering::SeqCst) != 0 && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(5)); }
        assert_eq!(events.alive.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn slow_subscriber_overflows_without_blocking_fast_subscriber() {
        let events = ScheduledEvents::default();
        let (slow_tx, slow_rx) = mpsc::channel();
        let slow = Channel::new(move |body| { if let tauri::ipc::InvokeResponseBody::Json(text) = body { slow_tx.send(text).unwrap(); } Ok(()) });
        let slow_id = events.subscribe(slow).unwrap();
        slow_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let (fast_tx, fast_rx) = mpsc::channel();
        let fast = Channel::new(move |body| { if let tauri::ipc::InvokeResponseBody::Json(text) = body { fast_tx.send(text).unwrap(); } Ok(()) });
        let fast_id = events.subscribe(fast).unwrap();
        fast_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(events.acknowledge(&fast_id, 1, 1));
        events.emit(json!({"type":"task_changed"}));
        let frame: Value = serde_json::from_str(&fast_rx.recv_timeout(Duration::from_secs(2)).unwrap()).unwrap();
        assert_eq!(frame["kind"], "event");
        assert!(events.acknowledge(&fast_id, 1, 2));
        for n in 0..300 { events.emit(json!({"type":"task_changed", "n":n})); }
        assert!(events.acknowledge(&slow_id, 1, 1));
        let reset: Value = serde_json::from_str(&slow_rx.recv_timeout(Duration::from_secs(2)).unwrap()).unwrap();
        assert_eq!(reset["kind"], "reset");
        events.unsubscribe(&fast_id);
    }
}
