//! In-process event fanout for scheduled-task changes.
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use serde_json::{json, Value};
use tauri::ipc::Channel;

#[derive(Default)]
pub struct ScheduledEvents {
    next: AtomicU64,
    subscribers: Arc<Mutex<HashMap<String, Subscriber>>>,
}
struct Subscriber {
    tx: mpsc::SyncSender<Value>,
    overflowed: Arc<AtomicBool>,
}
impl ScheduledEvents {
    pub fn emit(&self, event: Value) {
        self.subscribers.lock().unwrap().retain(|_, subscriber| match subscriber.tx.try_send(event.clone()) {
            Ok(()) => true,
            Err(mpsc::TrySendError::Full(_)) => {
                subscriber.overflowed.store(true, Ordering::SeqCst);
                false
            }
            Err(mpsc::TrySendError::Disconnected(_)) => false,
        });
    }
    pub fn unsubscribe(&self, id: &str) { self.subscribers.lock().unwrap().remove(id); }
    pub fn subscribe(&self, channel: Channel<Value>) -> Result<String, String> {
        let id = format!("tasks-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let (tx, rx) = mpsc::sync_channel(256);
        let overflowed = Arc::new(AtomicBool::new(false));
        self.subscribers.lock().unwrap().insert(id.clone(), Subscriber { tx, overflowed: Arc::clone(&overflowed) });
        let thread_id = id.clone();
        let subscribers = Arc::clone(&self.subscribers);
        if let Err(error) = std::thread::Builder::new().name(format!("scheduled-events-{id}")).spawn(move || {
            let mut seq = 1u64;
            if channel.send(json!({ "subscriptionId": thread_id, "epoch": 1, "seq": seq, "kind": "snapshot", "payload": {} })).is_err() {
                subscribers.lock().unwrap().remove(&thread_id);
                return;
            }
            loop {
                if overflowed.load(Ordering::SeqCst) {
                    seq += 1;
                    let _ = channel.send(json!({ "subscriptionId": thread_id, "epoch": 1, "seq": seq, "kind": "reset", "payload": { "reason": "overflow" } }));
                    break;
                }
                let (kind, event) = match rx.recv_timeout(std::time::Duration::from_secs(10)) {
                    Ok(event) => ("event", event),
                    Err(mpsc::RecvTimeoutError::Timeout) => ("heartbeat", Value::Null),
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                seq += 1;
                if channel.send(json!({ "subscriptionId": thread_id, "epoch": 1, "seq": seq, "kind": kind, "payload": event })).is_err() { break; }
            }
            subscribers.lock().unwrap().remove(&thread_id);
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
    #[test]
    fn delivers_events_and_detaches_on_unsubscribe() {
        let events = ScheduledEvents::default();
        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body { tx.send(text).unwrap(); }
            Ok(())
        });
        let id = events.subscribe(channel).unwrap();
        events.emit(json!({ "type": "task_changed", "taskId": "t" }));
        let snapshot: Value = serde_json::from_str(&rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap()).unwrap();
        assert_eq!(snapshot["kind"], "snapshot");
        let text = rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        let frame: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(frame["payload"]["taskId"], "t");
        assert_eq!(frame["subscriptionId"], id);
        events.unsubscribe(&id);
        assert!(rx.recv_timeout(std::time::Duration::from_secs(1)).is_err());
    }

    #[test]
    fn slow_subscriber_is_bounded_and_receives_reset() {
        let events = ScheduledEvents::default();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (frames_tx, frames_rx) = mpsc::channel();
        let first = std::sync::atomic::AtomicBool::new(true);
        let release_rx = Mutex::new(release_rx);
        let channel = Channel::new(move |body| {
            if first.swap(false, Ordering::SeqCst) {
                entered_tx.send(()).unwrap();
                release_rx.lock().unwrap().recv().unwrap();
            }
            if let tauri::ipc::InvokeResponseBody::Json(text) = body { frames_tx.send(text).unwrap(); }
            Ok(())
        });
        events.subscribe(channel).unwrap();
        events.emit(json!({ "type": "task_changed" }));
        entered_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        for _ in 0..300 { events.emit(json!({ "type": "task_changed" })); }
        assert!(events.subscribers.lock().unwrap().is_empty());
        release_tx.send(()).unwrap();
        let _first = frames_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        let reset: Value = serde_json::from_str(&frames_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap()).unwrap();
        assert_eq!(reset["kind"], "reset");
        assert_eq!(reset["payload"]["reason"], "overflow");
    }
}
