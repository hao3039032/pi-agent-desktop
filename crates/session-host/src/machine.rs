//! The message-level session state machine — the Rust port of
//! `lib/pi-rpc/session.ts`'s event projection (M2).
//!
//! Inputs are the child's event records (one JSON object per event); the
//! machine maintains the run state (`isStreaming`, `isIdle`, epochs, retry
//! attempts, queues), the streaming assistant message (delta accumulation
//! over content blocks) and the counters. Frozen semantics from the TS
//! engine:
//!
//! - `agent_start` bumps the run epoch and flips streaming/idle;
//! - `agent_settled` settles the epoch, clears retry/streaming and is where
//!   a get_state/get_stats refresh is requested (the CALLER performs the
//!   refresh; a stale reply must not flip a newer live run back to idle —
//!   [`SessionMachine::epoch`] is the guard);
//! - `autoRetryEnabled` starts UNKNOWN (Option) — only `auto_retry_start`
//!   or `set_auto_retry` proves a value (a hard rule of this repo);
//! - a run is "running" when streaming, compacting, retrying — OR when
//!   `is_idle == Some(false)` (the `isRunning()` OR-rule that once evicted
//!   wrappers mid-retry when dropped);
//! - streaming messages accumulate delta-only `message_update` events into
//!   dense content blocks (text/thinking/toolcall), clamped contentIndex;
//! - queue updates arrive as `queue_update`/`steering_queued`/`follow_up_queued`.

use serde_json::{json, Value};

/// The projected session state (the fields the UI consumes).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionRunState {
    pub session_id: String,
    pub session_name: Option<String>,
    pub is_streaming: bool,
    pub is_idle: Option<bool>,
    pub is_compacting: bool,
    pub auto_compaction_enabled: Option<bool>,
    /// Unknown until the child proves it (auto_retry_start or set_auto_reply).
    pub auto_retry_enabled: Option<bool>,
    pub retry_attempt: u32,
    pub message_count: u64,
    pub pending_message_count: u64,
    pub steering_queue: Vec<String>,
    pub follow_up_queue: Vec<String>,
    pub model: Option<Value>,
    pub thinking_level: Option<String>,
    /// Outstanding child extension-UI request ids seen on the event stream
    /// (the SSE `connected` contract's pendingExtensionUiIds — the client
    /// drops dialogs the session no longer holds). The authoritative holder
    /// is the child; this is the host's view from the records it saw.
    pub pending_ui_request_ids: Vec<String>,
}

impl SessionRunState {
    /// The run-liveness rule: streaming, compacting, a live retry — OR the
    /// child explicitly reporting not-idle (the isRunning OR-rule).
    pub fn is_running(&self) -> bool {
        self.is_streaming || self.is_compacting || (self.retry_attempt > 0 && self.is_streaming) || self.is_idle == Some(false)
    }
}

/// One streaming assistant message being accumulated from deltas.
#[derive(Debug, Clone, Default)]
pub struct StreamingMessage {
    pub content: Vec<Value>,
    pub usage: Option<Value>,
}

/// What the machine wants its owner to do after an event.
#[derive(Debug, Clone, PartialEq)]
pub enum FollowUp {
    /// A run settled at this epoch: refresh get_state + get_stats (guarded
    /// by the epoch — a stale reply must not overwrite a newer live run).
    RefreshAfterSettle { epoch: u64 },
    /// Compaction ended: stats/usage are stale.
    RefreshStats,
    None,
}

/// The machine (pure; no I/O, no threads — the Session feeds it).
#[derive(Debug, Default)]
pub struct SessionMachine {
    pub state: SessionRunState,
    /// Monotonic run counter (bumped by agent_start).
    run_epoch: u64,
    /// The epoch that last settled.
    settled_epoch: u64,
    streaming_message: Option<StreamingMessage>,
    last_assistant_text: Option<String>,
}

impl SessionMachine {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            state: SessionRunState { session_id: session_id.into(), ..SessionRunState::default() },
            ..Self::default()
        }
    }

    pub fn epoch(&self) -> u64 {
        self.run_epoch
    }

    pub fn settled_epoch(&self) -> u64 {
        self.settled_epoch
    }

    pub fn streaming_message(&self) -> Option<&StreamingMessage> {
        self.streaming_message.as_ref()
    }

    pub fn last_assistant_text(&self) -> Option<&str> {
        self.last_assistant_text.as_deref()
    }

    /// Apply one event record; returns the follow-up the caller owes.
    pub fn apply_event(&mut self, record: &Value) -> FollowUp {
        let record_type = record.get("type").and_then(Value::as_str).unwrap_or("");
        match record_type {
            "agent_start" => {
                self.state.is_streaming = true;
                self.state.is_idle = Some(false);
                self.run_epoch += 1;
                FollowUp::None
            }
            "agent_settled" => {
                self.state.is_streaming = false;
                self.state.is_idle = Some(true);
                self.state.retry_attempt = 0;
                self.streaming_message = None;
                self.settled_epoch = self.run_epoch;
                FollowUp::RefreshAfterSettle { epoch: self.run_epoch }
            }
            "message_start" => {
                if message_role(record) == Some("assistant") {
                    let content = message_content(record)
                        .map(|content| content.as_array().cloned().unwrap_or_default())
                        .unwrap_or_default();
                    self.streaming_message = Some(StreamingMessage {
                        content,
                        usage: record.get("usage").cloned(),
                    });
                }
                FollowUp::None
            }
            "message_update" => {
                let message = record.get("message");
                if message.and_then(|m| m.get("role")).and_then(Value::as_str) == Some("assistant") {
                    // A cumulative snapshot (in-process SDK shape): adopt it.
                    self.streaming_message = Some(StreamingMessage {
                        content: message
                            .and_then(|m| m.get("content"))
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                        usage: record.get("usage").cloned(),
                    });
                } else if self.streaming_message.is_some() {
                    self.apply_streaming_delta(record);
                }
                FollowUp::None
            }
            "message_end" => {
                let role = message_role(record);
                match role {
                    Some("assistant") => {
                        if let Some(content) = message_content(record) {
                            if let Some(message) = self.streaming_message.as_mut() {
                                message.content = content.as_array().cloned().unwrap_or_default();
                            }
                        }
                        self.state.message_count += 1;
                        let text = self.assistant_text();
                        if text.is_some() {
                            self.last_assistant_text = text;
                        }
                    }
                    Some("user") => {
                        self.state.message_count += 1;
                    }
                    _ => {}
                }
                FollowUp::None
            }
            "compaction_start" => {
                self.state.is_compacting = true;
                FollowUp::None
            }
            "compaction_end" => {
                self.state.is_compacting = false;
                FollowUp::RefreshStats
            }
            // Child extension-UI requests: track the outstanding ids for
            // the snapshot contract (pendingExtensionUiIds). A request seen
            // again with `cancelled`/answered semantics leaves the set; the
            // authoritative holder is the child, this is the host's view.
            "extension_ui_request" => {
                if let Some(id) = record.get("id").and_then(Value::as_str) {
                    let id = id.to_string();
                    if !self.state.pending_ui_request_ids.contains(&id) {
                        self.state.pending_ui_request_ids.push(id);
                    }
                }
                FollowUp::None
            }
            "extension_ui_cancelled" | "extension_ui_closed" => {
                if let Some(id) = record.get("id").and_then(Value::as_str) {
                    self.state.pending_ui_request_ids.retain(|seen| seen != id);
                }
                FollowUp::None
            }
            "queue_update" | "steering_queued" | "follow_up_queued" => {
                if let Some(steering) = record.get("steering").and_then(Value::as_array) {
                    self.state.steering_queue = steering
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect();
                }
                if let Some(follow_up) = record.get("followUp").and_then(Value::as_array) {
                    self.state.follow_up_queue = follow_up
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect();
                }
                FollowUp::None
            }
            "auto_retry_start" => {
                // A retry starting proves the child's policy is ON.
                self.state.auto_retry_enabled = Some(true);
                self.state.retry_attempt = match record.get("attempt").and_then(Value::as_u64) {
                    Some(attempt) => attempt as u32,
                    None => self.state.retry_attempt.saturating_add(1),
                };
                FollowUp::None
            }
            "auto_retry_end" => {
                if record.get("success").and_then(Value::as_bool) == Some(true) {
                    self.state.retry_attempt = 0;
                }
                FollowUp::None
            }
            "model_change" => {
                if let Some(model) = record.get("model") {
                    self.state.model = Some(model.clone());
                }
                FollowUp::None
            }
            _ => FollowUp::None,
        }
    }

    /// Merge one get_state snapshot. `volatile` fields (isStreaming/isIdle/
    /// retry) only apply when the snapshot is not stale: pass the epoch
    /// captured when the request was sent; a mismatch keeps them.
    pub fn apply_state_snapshot(&mut self, snapshot: &Value, captured_epoch: u64) {
        let stale = captured_epoch != self.run_epoch;
        if let Some(id) = snapshot.get("sessionId").and_then(Value::as_str) {
            self.state.session_id = id.to_string();
        }
        if let Some(name) = snapshot.get("sessionName").and_then(Value::as_str) {
            self.state.session_name = Some(name.to_string());
        }
        if let Some(level) = snapshot.get("thinkingLevel").and_then(Value::as_str) {
            self.state.thinking_level = Some(level.to_string());
        }
        if snapshot.get("model").map(Value::is_object).unwrap_or(false) {
            self.state.model = snapshot.get("model").cloned();
        }
        if let Some(count) = snapshot.get("messageCount").and_then(Value::as_u64) {
            self.state.message_count = count;
        }
        if let Some(count) = snapshot.get("pendingMessageCount").and_then(Value::as_u64) {
            self.state.pending_message_count = count;
        }
        if let Some(enabled) = snapshot.get("autoCompactionEnabled").and_then(Value::as_bool) {
            self.state.auto_compaction_enabled = Some(enabled);
        }
        if !stale {
            if let Some(streaming) = snapshot.get("isStreaming").and_then(Value::as_bool) {
                self.state.is_streaming = streaming;
            }
            if let Some(idle) = snapshot.get("isIdle") {
                if idle.is_boolean() {
                    self.state.is_idle = idle.as_bool();
                }
            }
        }
    }

    /// The reconstructed assistant text of the streamed message (for
    /// last-assistant-text consumers between settles).
    fn assistant_text(&self) -> Option<String> {
        let message = self.streaming_message.as_ref()?;
        let text: String = message
            .content
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect();
        if text.is_empty() { None } else { Some(text) }
    }

    /// Delta accumulation over dense content blocks (the wire's
    /// message_update events without a `message` field).
    fn apply_streaming_delta(&mut self, record: &Value) {
        let Some(message) = self.streaming_message.as_mut() else { return };
        let Some(event) = record.get("event") else { return };
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
        let blocks = &mut message.content;
        let content_index = event
            .get("contentIndex")
            .and_then(Value::as_u64)
            .map(|index| index as usize)
            .filter(|index| *index <= blocks.len())
            .unwrap_or(blocks.len());
        // Keep the array dense: clamp to the end (a real stream has no gaps).
        let index = content_index.min(blocks.len());
        let ensure = |blocks: &mut Vec<Value>, index: usize, block: Value| {
            if index == blocks.len() {
                blocks.push(block);
            } else {
                blocks[index] = block;
            }
        };
        match event_type {
            "text_start" => ensure(blocks, index, json!({ "type": "text", "text": "" })),
            "text_delta" => {
                let mut block = text_block(blocks.get(index));
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    let text = block.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                    block["text"] = json!(format!("{text}{delta}"));
                }
                ensure(blocks, index, block);
            }
            "text_end" => {
                let mut block = text_block(blocks.get(index));
                block["text"] = json!(event.get("content").and_then(Value::as_str).unwrap_or(""));
                ensure(blocks, index, block);
            }
            "thinking_start" => ensure(blocks, index, json!({ "type": "thinking", "thinking": "" })),
            "thinking_delta" => {
                let mut block = thinking_block(blocks.get(index));
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    let thinking = block.get("thinking").and_then(Value::as_str).unwrap_or("").to_string();
                    block["thinking"] = json!(format!("{thinking}{delta}"));
                }
                ensure(blocks, index, block);
            }
            "thinking_end" => {
                let mut block = thinking_block(blocks.get(index));
                block["thinking"] = json!(event.get("content").and_then(Value::as_str).unwrap_or(""));
                ensure(blocks, index, block);
            }
            "toolcall_start" => ensure(
                blocks,
                index,
                json!({
                    "type": "toolCall",
                    "id": event.get("id").and_then(Value::as_str).unwrap_or(""),
                    "name": event.get("toolName").and_then(Value::as_str).unwrap_or(""),
                    "arguments": {},
                }),
            ),
            "toolcall_delta" => {
                let mut block = blocks.get(index).cloned().unwrap_or(json!({ "type": "toolCall", "arguments": {} }));
                let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
                let partial = block.get("partialArguments").and_then(Value::as_str).unwrap_or("").to_string();
                block["partialArguments"] = json!(format!("{partial}{delta}"));
                block["type"] = json!("toolCall");
                ensure(blocks, index, block);
            }
            "toolcall_end" => {
                if let Some(tool_call) = event.get("toolCall").filter(|value| value.is_object()) {
                    ensure(blocks, index, tool_call.clone());
                }
            }
            _ => {}
        }
        if let Some(usage) = record.get("usage") {
            message.usage = Some(usage.clone());
        }
    }
}

fn message_role(record: &Value) -> Option<&str> {
    record.get("message").and_then(|message| message.get("role")).and_then(Value::as_str)
}

fn message_content(record: &Value) -> Option<&Value> {
    record.get("message").and_then(|message| message.get("content"))
}

fn text_block(existing: Option<&Value>) -> Value {
    existing
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .cloned()
        .unwrap_or(json!({ "type": "text", "text": "" }))
}

fn thinking_block(existing: Option<&Value>) -> Value {
    existing
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("thinking"))
        .cloned()
        .unwrap_or(json!({ "type": "thinking", "thinking": "" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(type_: &str) -> Value {
        json!({ "type": type_ })
    }

    #[test]
    fn run_lifecycle_and_epochs() {
        let mut machine = SessionMachine::new("s");
        assert_eq!(machine.apply_event(&event("agent_start")), FollowUp::None);
        assert!(machine.state.is_streaming);
        assert_eq!(machine.state.is_idle, Some(false));
        assert!(machine.state.is_running());
        assert_eq!(machine.epoch(), 1);
        assert_eq!(
            machine.apply_event(&event("agent_settled")),
            FollowUp::RefreshAfterSettle { epoch: 1 }
        );
        assert!(!machine.state.is_streaming);
        assert_eq!(machine.state.is_idle, Some(true));
        assert!(!machine.state.is_running());
        assert_eq!(machine.settled_epoch(), 1);
    }

    #[test]
    fn the_isrunning_or_rule_keeps_a_not_idle_child_running() {
        let mut machine = SessionMachine::new("s");
        // get_state says not idle while no event ever said streaming: the
        // hard rule — isRunning ORs isIdle === false.
        machine.apply_state_snapshot(&json!({ "isIdle": false }), 0);
        assert!(machine.state.is_running(), "not-idle alone means running");
        machine.apply_state_snapshot(&json!({ "isIdle": true }), 0);
        assert!(!machine.state.is_running());
    }

    #[test]
    fn auto_retry_starts_unknown_proves_on_and_resets_on_settle() {
        let mut machine = SessionMachine::new("s");
        assert_eq!(machine.state.auto_retry_enabled, None, "unknown until proven");
        machine.apply_event(&event("agent_start"));
        machine.apply_event(&json!({ "type": "auto_retry_start", "attempt": 2 }));
        assert_eq!(machine.state.auto_retry_enabled, Some(true));
        assert_eq!(machine.state.retry_attempt, 2);
        machine.apply_event(&json!({ "type": "auto_retry_end", "success": false }));
        assert_eq!(machine.state.retry_attempt, 2, "a failed last attempt keeps the counter");
        machine.apply_event(&event("agent_settled"));
        assert_eq!(machine.state.retry_attempt, 0, "settle resets");
    }

    #[test]
    fn streaming_message_accumulates_deltas_into_dense_blocks() {
        let mut machine = SessionMachine::new("s");
        machine.apply_event(&json!({
            "type": "message_start",
            "message": { "role": "assistant", "content": [] },
        }));
        machine.apply_event(&json!({
            "type": "message_update",
            "event": { "type": "text_start", "contentIndex": 0 },
        }));
        machine.apply_event(&json!({
            "type": "message_update",
            "event": { "type": "text_delta", "contentIndex": 0, "delta": "Hello" },
        }));
        machine.apply_event(&json!({
            "type": "message_update",
            "event": { "type": "text_delta", "contentIndex": 0, "delta": " 世界" },
        }));
        machine.apply_event(&json!({
            "type": "message_update",
            "event": { "type": "thinking_start", "contentIndex": 1 },
        }));
        machine.apply_event(&json!({
            "type": "message_update",
            "event": { "type": "thinking_delta", "contentIndex": 1, "delta": "hmm" },
        }));
        machine.apply_event(&json!({
            "type": "message_update",
            "event": { "type": "toolcall_start", "contentIndex": 2, "id": "tc1", "toolName": "read" },
        }));
        machine.apply_event(&json!({
            "type": "message_update",
            "event": { "type": "toolcall_delta", "contentIndex": 2, "delta": "{\"path\":" },
        }));
        machine.apply_event(&json!({
            "type": "message_update",
            "event": { "type": "toolcall_end", "contentIndex": 2, "toolCall": { "type": "toolCall", "id": "tc1", "name": "read", "arguments": { "path": "x" } } },
        }));
        let message = machine.streaming_message().expect("streaming");
        assert_eq!(message.content.len(), 3);
        assert_eq!(message.content[0]["text"], "Hello 世界");
        assert_eq!(message.content[1]["thinking"], "hmm");
        assert_eq!(message.content[2]["name"], "read");
        assert_eq!(message.content[2]["arguments"]["path"], "x");

        // A cumulative snapshot replaces the accumulation whole.
        machine.apply_event(&json!({
            "type": "message_update",
            "message": { "role": "assistant", "content": [ { "type": "text", "text": "final" } ] },
        }));
        assert_eq!(machine.streaming_message().unwrap().content.len(), 1);

        // message_end counts and records the assistant text.
        machine.apply_event(&json!({
            "type": "message_end",
            "message": { "role": "assistant", "content": [ { "type": "text", "text": "final text" } ] },
        }));
        assert_eq!(machine.state.message_count, 1);
        assert_eq!(machine.last_assistant_text(), Some("final text"));
    }

    #[test]
    fn user_messages_count_assistant_snapshots_adopt() {
        let mut machine = SessionMachine::new("s");
        machine.apply_event(&json!({
            "type": "message_end",
            "message": { "role": "user", "content": "hi" },
        }));
        assert_eq!(machine.state.message_count, 1);
    }

    #[test]
    fn queue_updates_apply_both_queues() {
        let mut machine = SessionMachine::new("s");
        machine.apply_event(&json!({ "type": "queue_update", "steering": ["s1"], "followUp": ["f1", "f2"] }));
        assert_eq!(machine.state.steering_queue, vec!["s1"]);
        assert_eq!(machine.state.follow_up_queue, vec!["f1", "f2"]);
    }

    #[test]
    fn stale_snapshots_never_flip_a_newer_live_run_idle() {
        let mut machine = SessionMachine::new("s");
        machine.apply_event(&event("agent_start")); // epoch 1, streaming
        // A get_state reply captured BEFORE the run (epoch 0) says idle: it
        // must not flip the live run back to idle.
        machine.apply_state_snapshot(&json!({ "isStreaming": false, "isIdle": true }), 0);
        assert!(machine.state.is_streaming, "stale snapshot kept the live flags");
        assert_eq!(machine.state.is_idle, Some(false));
        // A current-epoch snapshot applies.
        machine.apply_state_snapshot(&json!({ "isStreaming": false, "isIdle": true }), 1);
        assert!(!machine.state.is_streaming);
        assert_eq!(machine.state.is_idle, Some(true));
    }

    #[test]
    fn compaction_flags_and_stats_refresh() {
        let mut machine = SessionMachine::new("s");
        assert_eq!(machine.apply_event(&event("compaction_start")), FollowUp::None);
        assert!(machine.state.is_compacting);
        assert!(machine.state.is_running(), "compaction is a live state");
        assert_eq!(machine.apply_event(&event("compaction_end")), FollowUp::RefreshStats);
        assert!(!machine.state.is_compacting);
    }

    #[test]
    fn model_change_updates_the_model() {
        let mut machine = SessionMachine::new("s");
        machine.apply_event(&json!({
            "type": "model_change",
            "model": { "provider": "p", "id": "m" },
        }));
        assert_eq!(machine.state.model.as_ref().unwrap()["id"], "m");
    }
}
