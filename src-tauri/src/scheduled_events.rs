//! In-process event fanout for scheduled-task changes.
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use serde_json::{json, Value};
use tauri::ipc::Channel;

#[derive(Default)]
pub struct ScheduledEvents {
    next: AtomicU64,
    subscribers: Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>,
}
impl ScheduledEvents {
    pub fn emit(&self, event: Value) {
        self.subscribers.lock().unwrap().retain(|_, tx| tx.send(event.clone()).is_ok());
    }
    pub fn unsubscribe(&self, id: &str) { self.subscribers.lock().unwrap().remove(id); }
    pub fn subscribe(&self, channel: Channel<Value>) -> Result<String, String> {
        let id = format!("tasks-{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let (tx, rx) = mpsc::channel();
        self.subscribers.lock().unwrap().insert(id.clone(), tx);
        let thread_id = id.clone();
        let subscribers = Arc::clone(&self.subscribers);
        if let Err(error) = std::thread::Builder::new().name(format!("scheduled-events-{id}")).spawn(move || {
            let mut seq = 0u64;
            loop {
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
        let text = rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        let frame: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(frame["payload"]["taskId"], "t");
        assert_eq!(frame["subscriptionId"], id);
        events.unsubscribe(&id);
        assert!(rx.recv_timeout(std::time::Duration::from_secs(1)).is_err());
    }
}
