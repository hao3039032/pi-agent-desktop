//! The composer outbox (M2): the editable queue of messages the user wrote
//! while a run was active (`lib/composer-queue.ts`'s host half).
//!
//! Items enter through `queue_composer` and STAY in the host until the
//! session is idle (never joining the child's steering queue); the user can
//! take one back (edit/delete) or send it now (as a steer). Delivery rides
//! the ordinary prompt command with `streamingBehavior` — exactly the
//! wrapper's `deliver` callback. Every change emits `composer_queue_update`
//! so every subscriber's pending list stays in step, and a delivery failure
//! puts the item back, pauses the queue and emits `prompt_error`.
//!
//! The queue state lives on the Session (the wrapper kept it in a globalThis
//! registry so it survived idle eviction; the registry entry here owns the
//! same lifetime).

use std::sync::Arc;

use serde_json::{json, Value};

use crate::Session;

/// One queued message (`PendingComposerMessage`).
#[derive(Debug, Clone)]
pub struct PendingComposerMessage {
    pub id: String,
    pub message: String,
    pub images: Option<Value>,
}

impl PendingComposerMessage {
    fn to_json(&self) -> Value {
        let mut item = json!({ "id": self.id, "message": self.message });
        if let Some(images) = self
            .images
            .as_ref()
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty())
        {
            item["images"] = json!(images);
        }
        item
    }
}

#[derive(Default)]
struct OutboxState {
    items: Vec<PendingComposerMessage>,
    version: u64,
    paused: bool,
}

/// The per-session outbox.
#[derive(Default)]
pub struct ComposerOutbox {
    state: std::sync::Mutex<OutboxState>,
}

impl ComposerOutbox {
    pub fn new() -> Self {
        Self::default()
    }

    /// `queue_composer`: enqueue one message (empty refused, 100 max).
    /// Returns the queued item; the caller notifies and wakes delivery.
    pub fn enqueue(&self, message: &str, images: Option<Value>) -> Result<PendingComposerMessage, String> {
        let image_count = images.as_ref().and_then(Value::as_array).map_or(0, Vec::len);
        if message.trim().is_empty() && image_count == 0 {
            return Err("Message is empty".to_string());
        }
        let mut state = self.state.lock().unwrap();
        if state.items.len() >= 100 {
            return Err("Too many queued messages".to_string());
        }
        let item = PendingComposerMessage {
            id: uuid::Uuid::new_v4().to_string(),
            message: message.to_string(),
            images: if image_count > 0 { images } else { None },
        };
        state.items.push(item.clone());
        state.paused = false;
        Ok(item)
    }

    /// Remove one item by id (`take`): a missing id is a normal no-op (idle
    /// delivery, another window or a rapid second click may win the claim).
    pub fn take(&self, id: &str) -> Option<PendingComposerMessage> {
        let mut state = self.state.lock().unwrap();
        let index = state.items.iter().position(|item| item.id == id)?;
        Some(state.items.remove(index))
    }

    /// The snapshot + version every answer and event carries.
    pub fn snapshot(&self) -> (Vec<Value>, u64) {
        let state = self.state.lock().unwrap();
        (state.items.iter().map(PendingComposerMessage::to_json).collect(), state.version)
    }

    /// A delivery failed: the item goes back to the front and the queue
    /// pauses until the user acts (never a silent retry).
    pub fn restore_front(&self, item: PendingComposerMessage) {
        let mut state = self.state.lock().unwrap();
        state.items.insert(0, item);
        state.paused = true;
    }

    pub fn is_paused(&self) -> bool {
        self.state.lock().unwrap().paused
    }

    pub fn has_items(&self) -> bool {
        !self.state.lock().unwrap().items.is_empty()
    }

    fn pop_front(&self) -> Option<PendingComposerMessage> {
        let mut state = self.state.lock().unwrap();
        if state.items.is_empty() {
            return None;
        }
        Some(state.items.remove(0))
    }
}

impl Session {
    /// `queue_composer` (a host-level command): enqueue, notify, wake.
    pub fn composer_enqueue(self: &Arc<Self>, message: &str, images: Option<Value>) -> Result<Value, String> {
        let item = self.composer_outbox.enqueue(message, images)?;
        self.emit_composer_update();
        self.composer_wake();
        Ok(item.to_json())
    }

    /// `take_composer_message`: remove one item (edit/delete) and answer the
    /// {item, pending, pendingVersion} snapshot.
    pub fn composer_take(&self, id: &str) -> Value {
        let item = self.composer_outbox.take(id);
        self.emit_composer_update();
        self.composer_answer(item.as_ref().map(|item| item.to_json()))
    }

    /// `send_composer_message`: send one item NOW (as a steer). A delivery
    /// failure puts it back, pauses the queue and emits prompt_error.
    pub fn composer_send_now(&self, id: &str) -> Result<Value, String> {
        let Some(item) = self.composer_outbox.take(id) else {
            // Missing is a normal no-op (another window won the claim).
            return Ok(self.composer_answer(None));
        };
        self.emit_composer_update();
        match self.deliver_composer(&item, "steer") {
            Ok(()) => Ok(self.composer_answer(None)),
            Err(error) => {
                self.composer_outbox.restore_front(item);
                self.emit_composer_update();
                self.emit_prompt_error(&error);
                Err(error)
            }
        }
    }

    fn composer_answer(&self, item: Option<Value>) -> Value {
        let (pending, pending_version) = self.composer_outbox.snapshot();
        json!({ "item": item, "pending": pending, "pendingVersion": pending_version })
    }

    /// One prompt delivery (the wrapper's `deliver`): the ordinary prompt
    /// command with the streaming behavior the queue chose.
    fn deliver_composer(&self, item: &PendingComposerMessage, behavior: &str) -> Result<(), String> {
        let mut payload = json!({ "message": item.message, "streamingBehavior": behavior });
        if let Some(images) = item.images.as_ref().and_then(Value::as_array).filter(|items| !items.is_empty()) {
            payload["images"] = json!(images);
        }
        self.command("prompt", payload, Some(std::time::Duration::from_secs(120)))
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// The composer_queue_update event every subscriber consumes.
    pub fn emit_composer_update(&self) {
        let (items, pending_version) = self.composer_outbox.snapshot();
        self.emit_host_event(json!({
            "type": "composer_queue_update",
            "items": items,
            "pendingVersion": pending_version,
        }));
    }

    fn emit_prompt_error(&self, message: &str) {
        self.emit_host_event(json!({ "type": "prompt_error", "errorMessage": message }));
    }

    /// Wake idle delivery (the wrapper's 0-tick timer): while items wait,
    /// the queue is not paused and the session is idle, deliver them as
    /// follow-ups. Off the dispatch path — a slow prompt must not stall the
    /// caller (and only one drain runs at a time).
    pub fn composer_wake(self: &Arc<Self>) {
        if self.composer_outbox.is_paused() || !self.composer_outbox.has_items() {
            return;
        }
        let session = Arc::clone(self);
        std::thread::Builder::new()
            .name("composer-drain".into())
            .spawn(move || session.drain_once())
            .ok();
    }

    /// One drain pass under the delivering flag.
    fn drain_once(&self) {
        {
            let mut delivering = self.composer_delivering.lock().unwrap();
            if *delivering {
                return;
            }
            *delivering = true;
        }
        loop {
            if self.composer_outbox.is_paused() || !self.composer_outbox.has_items() {
                break;
            }
            // canDeliver: alive and not running (the machine's view).
            if self.run_state().is_running() || self.client.has_exited() {
                break;
            }
            let Some(item) = self.composer_outbox.pop_front() else { break };
            self.emit_composer_update();
            if let Err(error) = self.deliver_composer(&item, "followUp") {
                self.composer_outbox.restore_front(item);
                self.emit_composer_update();
                self.emit_prompt_error(&error);
                break;
            }
        }
        *self.composer_delivering.lock().unwrap() = false;
    }
}
