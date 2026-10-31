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

use crate::{Session, SettleOutcome};

/// One queued message (`PendingComposerMessage`).
#[derive(Debug, Clone)]
pub struct PendingComposerMessage {
    pub id: String,
    pub message: String,
    pub images: Option<Value>,
    /// This item's last delivery ended UNKNOWN (it may already be running):
    /// it is never re-delivered automatically — a resend is the user's
    /// explicit choice after checking the session. The flag rides the ITEM
    /// (not a front-position bool), so a later `restore_front` inserting at
    /// position 0 cannot silently unmark it.
    pub unknown: bool,
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
        if self.unknown {
            // The UI's unknown-outcome marker (a plain pending row must not
            // look resendable-without-thought).
            item["unknown"] = json!(true);
        }
        item
    }
}

#[derive(Default)]
struct OutboxState {
    items: Vec<PendingComposerMessage>,
    /// Strictly increasing on every actual queue change (enqueue, take,
    /// send-claim, restore, drain-claim) — the client's staleness check
    /// drops any snapshot whose version is not newer than one it already
    /// held (`lib/composer-queue-types.ts`'s contract). Read under the SAME
    /// lock as the items, so a snapshot's version always belongs to exactly
    /// the items beside it.
    version: u64,
    paused: bool,
    /// The delivery-generation fence (Terra round-4): bumped every time the
    /// session that owned this outbox is removed from the registry. A drain
    /// claims with the generation its Session captured at spawn; a claim
    /// under a stale generation is refused under the SAME lock — a replaced
    /// session's drain that wakes between its alive-check and its claim
    /// must never consume or pause the queue the replacement now owns.
    /// (The fence only gates CLAIMS: an item the old drain already claimed
    /// is in flight, and its outcome — parked unknown — still lands here,
    /// because losing it would be worse than pausing for it.)
    generation: u64,
}

impl OutboxState {
    /// Record an actual change: bump the version ONCE per mutation, under
    /// the state lock the caller already holds.
    fn changed(&mut self) {
        self.version = self.version.saturating_add(1);
    }
}

/// The per-session outbox.
#[derive(Default)]
pub struct ComposerOutbox {
    state: std::sync::Mutex<OutboxState>,
    in_flight: std::sync::atomic::AtomicUsize,
}

struct DeliveryGuard<'a>(&'a ComposerOutbox);
impl Drop for DeliveryGuard<'_> {
    fn drop(&mut self) { self.0.in_flight.fetch_sub(1, std::sync::atomic::Ordering::SeqCst); }
}

impl ComposerOutbox {
    pub fn new() -> Self {
        Self::default()
    }

    fn delivery_guard(&self) -> DeliveryGuard<'_> {
        self.in_flight.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        DeliveryGuard(self)
    }

    /// Includes claimed messages whose outcome has not yet returned to the outbox.
    pub fn has_pending_or_in_flight(&self) -> bool {
        self.in_flight.load(std::sync::atomic::Ordering::SeqCst) != 0 || self.has_items()
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
            unknown: false,
        };
        state.items.push(item.clone());
        // A new enqueue unpauses the queue (the Next semantics: a refused
        // item may retry once the user acts again) — UNLESS the front item
        // is parked as outcome-unknown: that barrier is the user's to clear
        // (take/edit/delete or an explicit send-now), never a side effect of
        // queueing another message behind it.
        if !state.front_is_unknown_locked() {
            state.paused = false;
        }
        state.changed();
        Ok(item)
    }

    /// Remove one item by id (`take`): a missing id is a normal no-op (idle
    /// delivery, another window or a rapid second click may win the claim).
    /// Taking the UNKNOWN front resolves the barrier it holds: the user has
    /// acted on it, so the rest of the queue may deliver again.
    pub fn take(&self, id: &str) -> Option<PendingComposerMessage> {
        let mut state = self.state.lock().unwrap();
        let index = state.items.iter().position(|item| item.id == id)?;
        let was_unknown_front = index == 0 && state.items[index].unknown;
        let item = state.items.remove(index);
        if was_unknown_front {
            state.paused = false;
        }
        state.changed();
        Some(item)
    }

    /// The snapshot + version every answer and event carries.
    pub fn snapshot(&self) -> (Vec<Value>, u64) {
        let state = self.state.lock().unwrap();
        (state.items.iter().map(PendingComposerMessage::to_json).collect(), state.version)
    }

    /// A delivery whose outcome is KNOWN-not-delivered (the child refused
    /// it): the item goes back to the front and the queue pauses until the
    /// user acts (never a silent retry).
    pub fn restore_front(&self, item: PendingComposerMessage) {
        let mut state = self.state.lock().unwrap();
        state.items.insert(0, item);
        state.paused = true;
        state.changed();
    }

    /// A delivery whose outcome is UNKNOWN (timeout, transport loss, child
    /// exit after the prompt may have reached it): the item is parked back
    /// — visible, editable — marked `unknown`, and the queue stays paused.
    /// It is NEVER re-delivered automatically; resending is the user's
    /// explicit choice after checking the session.
    pub fn park_unknown(&self, mut item: PendingComposerMessage) {
        let mut state = self.state.lock().unwrap();
        item.unknown = true;
        state.items.insert(0, item);
        state.paused = true;
        state.changed();
    }

    /// Whether the front item is parked as outcome-unknown (the state
    /// answer tells the UI which confirmation to show).
    pub fn front_is_unknown(&self) -> bool {
        self.state.lock().unwrap().front_is_unknown_locked()
    }

    pub fn is_paused(&self) -> bool {
        self.state.lock().unwrap().paused
    }

    pub fn has_items(&self) -> bool {
        !self.state.lock().unwrap().items.is_empty()
    }

    /// Whether the front is deliverable RIGHT NOW: there is an item, the
    /// queue is not paused, and the front is not parked outcome-unknown
    /// (that one is re-sent only by an explicit user action —
    /// `composer_send_now`). This is the WAKE's cheap pre-check and the
    /// drain's exit re-check; the authoritative decision is
    /// [`ComposerOutbox::claim_front_for_delivery`], which makes the same
    /// decision and the pop ATOMIC.
    pub fn has_deliverable_front(&self) -> bool {
        let state = self.state.lock().unwrap();
        !state.paused && !state.front_is_unknown_locked() && !state.items.is_empty()
    }

    /// The delivery generation this outbox currently accepts claims from
    /// (a Session captures it at spawn).
    pub fn generation(&self) -> u64 {
        self.state.lock().unwrap().generation
    }

    /// Fence every outstanding claim: the session that owned this outbox
    /// left the registry (removal/replacement/eviction), so its drain —
    /// wherever it is parked — may no longer claim from the queue the next
    /// owner (or the user) now holds.
    pub fn invalidate_delivery_generation(&self) {
        self.state.lock().unwrap().generation += 1;
    }

    /// Whether `generation` may still claim and deliver: the fence matches
    /// AND the front is deliverable. The wake's pre-check and the drain's
    /// exit re-check both route through here so a stale session never even
    /// spawns a drain (and a stale drain never stays the deliverer).
    pub fn may_deliver(&self, generation: u64) -> bool {
        let state = self.state.lock().unwrap();
        state.generation == generation && !state.paused && !state.front_is_unknown_locked() && !state.items.is_empty()
    }

    /// Atomically decide "the front is deliverable" and claim it: ONE lock
    /// covers the generation fence, the paused check, the unknown-front
    /// check and the pop. The check and the claim must not be separable:
    /// between a check under one acquisition and a `pop` under another, a
    /// concurrent `send_now` whose outcome turned UNKNOWN can
    /// `park_unknown` a item at the front — a plain `pop_front` would then
    /// remove the UNKNOWN item and deliver it, re-executing a prompt that
    /// may already be running, without the user's explicit confirmation
    /// (Terra P1-2) — and a drain whose session was replaced meanwhile
    /// would steal the replacement's queue (Terra round-4: the fence rides
    /// the same decision).
    pub fn claim_front_for_delivery(&self, generation: u64) -> Option<PendingComposerMessage> {
        let mut state = self.state.lock().unwrap();
        if state.generation != generation
            || state.paused
            || state.front_is_unknown_locked()
            || state.items.is_empty()
        {
            return None;
        }
        let item = state.items.remove(0);
        state.changed();
        Some(item)
    }
}

impl OutboxState {
    fn front_is_unknown_locked(&self) -> bool {
        self.items.first().is_some_and(|item| item.unknown)
    }
}

impl Session {
    /// `queue_composer` (a host-level command): enqueue, notify, wake.
    pub fn composer_enqueue(self: &Arc<Self>, message: &str, images: Option<Value>) -> Result<Value, String> {
        let _admission = self.activity_gate.try_read().map_err(|_| "session branch operation is in progress".to_string())?;
        (self.fence_checker)(&self.id)?;
        let _delivery = self.composer_outbox.delivery_guard();
        if self.client.has_exited() { return Err("session process has exited".to_string()); }
        let item = self.composer_outbox.enqueue(message, images)?;
        self.emit_composer_update();
        self.composer_wake();
        Ok(item.to_json())
    }

    /// `take_composer_message`: remove one item (edit/delete) and answer the
    /// {item, pending, pendingVersion} snapshot. Taking the UNKNOWN front
    /// resolves the barrier it held — and that resolution WAKES delivery:
    /// nothing else will (a settle only follows a run; an idle session with
    /// a resolved barrier would otherwise strand the rest of the queue
    /// until some unrelated event woke it — Terra P1-3). The wake is a
    /// guarded no-op while the queue is still paused or its front still
    /// unknown.
    pub fn composer_take(self: &Arc<Self>, id: &str) -> Value {
        let item = self.composer_outbox.take(id);
        self.emit_composer_update();
        self.composer_wake();
        self.composer_answer(item.as_ref().map(|item| item.to_json()))
    }

    /// `send_composer_message`: send one item NOW (as a steer). The
    /// delivery-error trichotomy decides the restore semantics: a certain
    /// non-delivery goes back as retryable; an UNKNOWN outcome (the prompt
    /// may already be running) is parked with the unknown marker — never
    /// silently re-delivered.
    pub fn composer_send_now(&self, id: &str) -> Result<Value, String> {
        let admission = self.activity_gate.try_read().map_err(|_| "session branch operation is in progress".to_string())?;
        (self.fence_checker)(&self.id)?;
        let _delivery = self.composer_outbox.delivery_guard();
        if self.client.has_exited() { return Err("session process has exited".to_string()); }
        let Some(item) = self.composer_outbox.take(id) else {
            // Missing is a normal no-op (another window won the claim).
            return Ok(self.composer_answer(None));
        };
        self.emit_composer_update();
        match self.deliver_composer(&item, "steer", admission) {
            Ok(()) => Ok(self.composer_answer(None)),
            Err(error) => {
                match error.kind {
                    // The child answered a refusal: definitely not executed.
                    pi_host::ErrorKind::Command | pi_host::ErrorKind::Spawn
                    | pi_host::ErrorKind::Invalid | pi_host::ErrorKind::Closing => {
                        self.composer_outbox.restore_front(item);
                    }
                    // Timeout / exit / transport loss: the outcome is unknown.
                    _ => self.composer_outbox.park_unknown(item),
                }
                self.emit_composer_update();
                self.emit_prompt_error(&error.to_string());
                Err(error.to_string())
            }
        }
    }

    fn composer_answer(&self, item: Option<Value>) -> Value {
        let (pending, pending_version) = self.composer_outbox.snapshot();
        let front_unknown = self.composer_outbox.front_is_unknown();
        json!({
            "item": item,
            "pending": pending,
            "pendingVersion": pending_version,
            // The UI's confirmation choice: an unknown outcome must not look
            // like a plain retryable failure.
            "frontDeliveryUnknown": front_unknown,
        })
    }

    /// One prompt delivery (the wrapper's `deliver`): the ordinary prompt
    /// command with the streaming behavior the queue chose, followed by the
    /// SDK settle wait — a `started` run waits for the NEXT epoch to settle,
    /// a `queued` one for the current. Waiting for ADMISSION alone is not
    /// enough: between the prompt response and the `agent_start` event the
    /// run is not yet projected, and a drain that continues there would
    /// pop the next item early, stealing its editability mid-run.
    fn deliver_composer(
        &self,
        item: &PendingComposerMessage,
        behavior: &str,
        admission: std::sync::RwLockReadGuard<'_, ()>,
    ) -> Result<(), pi_host::PiRpcError> {
        let mut payload = json!({ "message": item.message, "streamingBehavior": behavior });
        if let Some(images) = item.images.as_ref().and_then(Value::as_array).filter(|items| !items.is_empty()) {
            payload["images"] = json!(images);
        }
        let epoch_at_send = self.machine.lock().unwrap().epoch();
        let response = self.client.command("prompt", payload, Some(std::time::Duration::from_secs(120)))?;
        drop(admission);
        let disposition = match response.get("disposition").and_then(Value::as_str) {
            Some("queued") => "queued",
            Some("handled") => "handled",
            _ => "started",
        };
        match disposition {
            "started" => match self.wait_for_settle(epoch_at_send + 1, std::time::Duration::from_secs(600)) {
                SettleOutcome::Settled => Ok(()),
                // The run was cut short: the outcome of the DELIVERED prompt
                // is unknown — surface as an error so the caller parks it.
                SettleOutcome::ChildExited => Err(pi_host::PiRpcError::exit(
                    "pi process exited during the run",
                )),
                SettleOutcome::Timeout => Err(pi_host::PiRpcError::timeout(
                    "the run did not settle in time",
                )),
            },
            "queued" => match self.wait_for_settle(epoch_at_send, std::time::Duration::from_secs(600)) {
                SettleOutcome::Settled => Ok(()),
                SettleOutcome::ChildExited => Err(pi_host::PiRpcError::exit(
                    "pi process exited with the item queued",
                )),
                SettleOutcome::Timeout => Err(pi_host::PiRpcError::timeout(
                    "the queued run did not settle in time",
                )),
            },
            _ => Ok(()),
        }
    }

    /// The composer_queue_update event every subscriber consumes. The
    /// version and the items come from ONE snapshot call (one lock), so an
    /// event's version always belongs to exactly the items beside it.
    pub fn emit_composer_update(&self) {
        let (items, pending_version) = self.composer_outbox.snapshot();
        self.emit_host_event(json!({
            "type": "composer_queue_update",
            "items": items,
            "pendingVersion": pending_version,
            "frontDeliveryUnknown": self.composer_outbox.front_is_unknown(),
        }));
    }

    fn emit_prompt_error(&self, message: &str) {
        self.emit_host_event(json!({ "type": "prompt_error", "errorMessage": message }));
    }

    /// Wake idle delivery (the wrapper's 0-tick timer): while items wait,
    /// the queue is not paused, the front is not an unknown-parked item and
    /// the session is idle, deliver them as follow-ups. Off the dispatch
    /// path — a slow prompt must not stall the caller (and only one drain
    /// runs at a time).
    ///
    /// The wake is delivered through `drain_once`'s exit re-check, not just
    /// the spawn: a drain that is about to finish clears the flag and then
    /// RE-CHECKS for deliverable work under the same lock, so an enqueue
    /// whose spawned thread found `delivering == true` and gave up cannot
    /// strand its item (the JS original closed this race by being
    /// single-threaded — `drain`'s `finally { this.wake() }`).
    pub fn composer_wake(self: &Arc<Self>) {
        if !self.composer_outbox.may_deliver(self.composer_generation) {
            return;
        }
        let session = Arc::clone(self);
        std::thread::Builder::new()
            .name("composer-drain".into())
            .spawn(move || session.drain_once())
            .ok();
    }

    /// One drain pass under the delivering flag. The exit path re-checks
    /// for late work UNDER THE FLAG'S LOCK: either this thread continues
    /// draining, or a later waker sees `delivering == false` and drains
    /// itself — one of the two always observes the queued item.
    fn drain_once(&self) {
        loop {
            {
                let mut delivering = self.composer_delivering.lock().unwrap();
                if *delivering {
                    return;
                }
                *delivering = true;
            }
            loop {
                // canDeliver: alive and not running (the machine's view).
                if self.run_state().is_running() || self.client.has_exited() {
                    break;
                }
                self.drain_barrier("claim");
                // The check and the claim are ONE call: a `park_unknown`
                // that lands while this thread is at the barrier (or anywhere
                // else) pauses the queue or marks the front unknown, and the
                // claim answers None — an unknown outcome is never popped and
                // delivered by the drain (Terra P1-2). The generation in the
                // same call fences this drain once its session was replaced:
                // a drain parked between its alive-check and its claim must
                // not take the replacement's queue (Terra round-4).
                let admission = self.activity_gate.read().unwrap();
                if self.client.has_exited() || (self.fence_checker)(&self.id).is_err() { break; }
                let _delivery = self.composer_outbox.delivery_guard();
                let Some(item) = self
                    .composer_outbox
                    .claim_front_for_delivery(self.composer_generation)
                else {
                    break;
                };
                self.emit_composer_update();
                if let Err(error) = self.deliver_composer(&item, "followUp", admission) {
                    // The delivery's result is about to land on the shared
                    // outbox (restore or park) — the deterministic seam for
                    // the replacement interleavings: a drain whose child died
                    // mid-delivery reaches this point AFTER the replacement
                    // session has started (the fence already refuses its
                    // CLAIMS; the in-flight item's result must still land,
                    // never be lost).
                    self.drain_barrier("result");
                    match error.kind {
                        pi_host::ErrorKind::Command | pi_host::ErrorKind::Spawn
                        | pi_host::ErrorKind::Invalid | pi_host::ErrorKind::Closing => {
                            self.composer_outbox.restore_front(item);
                        }
                        _ => self.composer_outbox.park_unknown(item),
                    }
                    self.emit_composer_update();
                    self.emit_prompt_error(&error.to_string());
                    break;
                }
            }
            // The exit window: the last loop-top check is behind us; the
            // flag is still held. A wake that arrives HERE finds
            // `delivering == true` and returns — only the re-check under the
            // same lock can observe its work.
            self.drain_barrier("exit");
            // Exit: clear the flag and re-check under the SAME lock. Work
            // that arrived after the loop's last check but whose waker saw
            // `delivering == true` (and returned) is caught here.
            {
                let mut delivering = self.composer_delivering.lock().unwrap();
                *delivering = false;
                if self.composer_outbox.may_deliver(self.composer_generation)
                    && (self.fence_checker)(&self.id).is_ok()
                    && !self.run_state().is_running()
                    && !self.client.has_exited()
                {
                    continue; // late work: this thread stays the deliverer
                }
            }
            return;
        }
    }

    /// A deterministic-interleaving seam for the drain tests (Terra P1-2 /
    /// P1-3): with `PI_COMPOSER_DRAIN_BARRIER=<session-id>:<point>:<dir>`
    /// naming THIS session and THIS point, the drain signals
    /// `<dir>/<point>.reached` and waits for `<dir>/<point>.release`
    /// (bounded; a missing or late release never wedges the drain). Points:
    /// `claim` (immediately before the atomic claim — where a concurrent
    /// `park_unknown` must be observed), `exit` (the exit window between
    /// the last deliverability check and clearing the delivering flag) and
    /// `result` (after a delivery failed, immediately before its result is
    /// written to the shared outbox — the replacement interleavings).
    ///
    /// TEST-SEAM ONLY (`test-seams` feature): the env-reading, file-writing,
    /// 30-second-waiting body exists solely in this crate's own test builds
    /// (the self dev-dependency enables the feature); release and dependent
    /// builds compile the no-op below — an inherited `PI_COMPOSER_DRAIN_BARRIER`
    /// can never stall a shipped host (Terra round-4). The id/point match
    /// keeps parallel tests on other sessions unaffected.
    #[cfg(feature = "test-seams")]
    fn drain_barrier(&self, point: &str) {
        let Ok(spec) = std::env::var("PI_COMPOSER_DRAIN_BARRIER") else { return };
        let mut parts = spec.splitn(3, ':');
        let dir = match (parts.next(), parts.next(), parts.next()) {
            (Some(id), Some(at), Some(dir)) if id == self.id && at == point => {
                std::path::PathBuf::from(dir)
            }
            _ => return,
        };
        let reached = dir.join(format!("{point}.reached"));
        let release = dir.join(format!("{point}.release"));
        if std::fs::write(&reached, b"1\n").is_err() {
            return;
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !release.exists() {
            if std::time::Instant::now() >= deadline {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// The release-build body of the test seam: nothing. (See the
    /// `test-seams` twin above for the contract this stands in for.)
    #[cfg(not(feature = "test-seams"))]
    #[inline]
    fn drain_barrier(&self, _point: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_observes_claimed_delivery_until_outcome_is_recorded() {
        let outbox = ComposerOutbox::new();
        let item = outbox.enqueue("queued", None).unwrap();
        let delivery = outbox.delivery_guard();
        outbox.take(&item.id).unwrap();
        assert!(outbox.has_pending_or_in_flight());
        outbox.park_unknown(item);
        drop(delivery);
        assert!(outbox.has_pending_or_in_flight());
        let id = outbox.snapshot().0[0]["id"].as_str().unwrap().to_string();
        outbox.take(&id);
        assert!(!outbox.has_pending_or_in_flight());
    }

    #[test]
    fn every_queue_change_bumps_the_version_under_the_same_lock() {
        let outbox = ComposerOutbox::new();
        let (_, v0) = outbox.snapshot();
        assert_eq!(v0, 0, "a fresh queue starts at version 0");

        // enqueue bumps.
        let item = outbox.enqueue("one", None).expect("enqueue");
        let (_, v1) = outbox.snapshot();
        assert_eq!(v1, 1, "enqueue bumps the version");

        // take bumps (the item leaves the editable queue).
        outbox.take(&item.id).expect("take");
        let (_, v2) = outbox.snapshot();
        assert_eq!(v2, 2, "take bumps the version");

        // restore (a known-not-delivered send) bumps.
        outbox.restore_front(item.clone());
        let (_, v3) = outbox.snapshot();
        assert_eq!(v3, 3, "restore bumps the version");

        // park_unknown bumps and flags (the take back out bumped first).
        outbox.take(&item.id).expect("take again");
        outbox.park_unknown(item);
        let (items, v4) = outbox.snapshot();
        assert_eq!(v4, 5, "park_unknown bumps the version");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["unknown"], json!(true), "the parked item carries its unknown marker on the wire");
        assert!(outbox.front_is_unknown(), "the parked front is marked unknown");
        assert!(outbox.is_paused(), "an unknown delivery pauses the queue");
    }

    #[test]
    fn an_unknown_front_is_never_auto_delivered_behind_a_new_enqueue() {
        // The P1 fix (Terra P1-5A): after park_unknown(A) the user queues B;
        // A must NOT re-enter delivery and the queue must stay paused.
        let outbox = ComposerOutbox::new();
        let a = outbox.enqueue("A", None).expect("A");
        // The delivery path popped A before its outcome turned unknown —
        // park_unknown is what puts it BACK.
        outbox.take(&a.id.clone()).expect("pop A for delivery");
        outbox.park_unknown(a);
        assert!(outbox.is_paused());

        outbox.enqueue("B", None).expect("B");
        assert!(
            outbox.is_paused(),
            "enqueuing behind an unknown front must not resume the queue"
        );
        let (items, _) = outbox.snapshot();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["message"], "A", "the unknown item stays at the front");
        assert_eq!(items[0]["unknown"], json!(true));
        assert_eq!(items[1]["unknown"], Value::Null, "B is a plain pending item");

        // The claim (what a drain does) refuses the unknown front atomically
        // — verified here against the exact state the claim reads, and
        // exercised end-to-end against the real drain in
        // `the_drain_never_claims_an_item_parked_unknown_in_the_check_window`.
        assert!(outbox.front_is_unknown());
        assert!(outbox.claim_front_for_delivery(outbox.generation()).is_none(), "the claim refuses the unknown front");
        let (items_after, _) = outbox.snapshot();
        assert_eq!(items_after.len(), 2, "the refused claim changed nothing");
    }

    #[test]
    fn the_claim_is_one_atomic_decision() {
        // Terra P1-2: the deliverability decision and the pop share ONE
        // lock. Each refusal leaves the queue untouched (no version bump,
        // no item lost) — a claim that had checked under one acquisition
        // and popped under another could remove an item a concurrent
        // park_unknown had just marked unknown.
        let outbox = ComposerOutbox::new();
        // Paused: refused, untouched.
        let a = outbox.enqueue("A", None).expect("A");
        outbox.take(&a.id).expect("pop A");
        outbox.restore_front(a.clone());
        assert!(outbox.is_paused());
        let (_, version) = outbox.snapshot();
        assert!(outbox.claim_front_for_delivery(outbox.generation()).is_none(), "paused refuses the claim");
        let (items, version_after) = outbox.snapshot();
        assert_eq!(items.len(), 1, "the refused claim did not touch the items");
        assert_eq!(version_after, version, "the refused claim did not bump the version");

        // Front unknown: refused, untouched (the user's confirmation is the
        // only way that item leaves again).
        let taken = outbox.take(&a.id).expect("resolve the refusal");
        outbox.park_unknown(taken);
        assert!(outbox.is_paused());
        assert!(outbox.claim_front_for_delivery(outbox.generation()).is_none(), "an unknown front refuses the claim");
        assert!(outbox.has_items(), "the refused claim kept the item");

        // Deliverable: claimed (removed) under the same decision, with the
        // version bump the client's staleness check keys on.
        let front = outbox.snapshot().0.first().and_then(|item| item.get("id")).and_then(|id| id.as_str()).map(str::to_string).expect("front id");
        outbox.take(&front).expect("resolve the barrier");
        let b = outbox.enqueue("B", None).expect("B");
        let claimed = outbox.claim_front_for_delivery(outbox.generation()).expect("a deliverable front is claimed");
        assert_eq!(claimed.id, b.id);
        assert!(!outbox.has_items(), "the claim removed the item");
        assert!(!outbox.has_deliverable_front());
        assert!(outbox.claim_front_for_delivery(outbox.generation()).is_none(), "an empty queue refuses the claim");
    }

    #[test]
    fn a_stale_generation_cannot_claim_the_replacements_queue() {
        // Terra round-4: the fence. A drain whose session was replaced holds
        // a generation the outbox no longer accepts — its claim is refused
        // under the SAME lock (no item taken, no version bump), and the
        // replacement's own generation still claims. The parked-unknown and
        // restore paths stay open to it (an in-flight item must not be
        // lost) — only CLAIMS are fenced.
        let outbox = ComposerOutbox::new();
        let stale = outbox.generation();
        outbox.enqueue("A", None).expect("A queued for the replacement");

        // The replacement happens: the fence bumps, the old generation is
        // stale, and a drain parked between its alive-check and its claim
        // arrives here with the OLD generation.
        outbox.invalidate_delivery_generation();
        assert_ne!(outbox.generation(), stale, "the fence moved");
        assert!(!outbox.may_deliver(stale), "the stale drain may not deliver");
        let (_, version) = outbox.snapshot();
        assert!(
            outbox.claim_front_for_delivery(stale).is_none(),
            "the stale claim is refused"
        );
        let (items, version_after) = outbox.snapshot();
        assert_eq!(items.len(), 1, "the refused stale claim took nothing");
        assert_eq!(version_after, version, "the refused stale claim changed nothing");

        // The replacement's session claims with the CURRENT generation.
        assert!(outbox.may_deliver(outbox.generation()));
        let claimed = outbox
            .claim_front_for_delivery(outbox.generation())
            .expect("the current generation claims");
        assert_eq!(claimed.message, "A");

        // The fence does not close the in-flight paths: the old drain's
        // claimed-but-unknown item still parks here (visible, paused, never
        // silently dropped).
        outbox.park_unknown(claimed);
        assert!(outbox.front_is_unknown());
        assert!(outbox.is_paused());
    }

    #[test]
    fn taking_the_unknown_front_resumes_the_queue() {
        // The user acted on the unknown item (edit/delete): the barrier it
        // held is resolved, the rest of the queue may deliver again.
        let outbox = ComposerOutbox::new();
        let a = outbox.enqueue("A", None).expect("A");
        let a_id = a.id.clone();
        outbox.enqueue("B", None).expect("B");
        outbox.park_unknown(a);
        assert!(outbox.is_paused());

        let taken = outbox.take(&a_id).expect("the user takes the unknown item");
        assert!(taken.unknown, "the taken item still reports its unknown outcome (the edit path can warn)");
        assert!(!outbox.is_paused(), "the user resolving the barrier unpauses the queue");
        assert!(!outbox.front_is_unknown());

        // Taking a NON-front unknown item must not unpause (send_now on a
        // later item while the front is parked unknown leaves the barrier).
        let c = outbox.enqueue("C", None).expect("C");
        outbox.park_unknown(outbox.take(&c.id).expect("take C"));
        assert!(outbox.is_paused());
    }

    #[test]
    fn the_unknown_marker_survives_a_restore_front_insertion() {
        // The marker rides the item, not the front position: a known-refused
        // delivery restored at position 0 cannot unmark the parked item.
        let outbox = ComposerOutbox::new();
        let a = outbox.enqueue("A", None).expect("A");
        outbox.park_unknown(a);
        let refused = outbox.enqueue("C", None).expect("C");
        // A send_now on C failed with an explicit refusal: C returns to the
        // front (queue paused — it already was).
        outbox.restore_front(refused);
        let (items, _) = outbox.snapshot();
        assert_eq!(items[0]["message"], "C");
        assert_eq!(items[1]["message"], "A");
        assert_eq!(items[1]["unknown"], json!(true), "A keeps its unknown marker even off the front");
        assert_eq!(items[0]["unknown"], Value::Null, "C is a plain refused item");
    }

    #[test]
    fn a_stale_snapshot_cannot_resurrect_a_deleted_item() {
        // The client contract (lib/composer-queue-types.ts): a snapshot is
        // applied only when its version is NEWER than the one held. The
        // pairing under one lock is what makes that check sound: a snapshot
        // taken before a take must carry an older version than the take's.
        let outbox = ComposerOutbox::new();
        let a = outbox.enqueue("a", None).expect("a");
        let _b = outbox.enqueue("b", None).expect("b");
        // A client holds this snapshot…
        let (stale_items, stale_version) = outbox.snapshot();
        assert_eq!(stale_version, 2);
        // …then the user deletes `a` (a NEWER version).
        outbox.take(&a.id).expect("delete a");
        let (current_items, current_version) = outbox.snapshot();
        assert_eq!(current_version, 3);
        assert_eq!(current_items.len(), 1);
        // The stale snapshot's version cannot pass the client's check, so
        // the deleted item cannot come back through it.
        assert!(stale_version < current_version);
        assert_eq!(stale_items.len(), 2, "the stale snapshot still holds both (proving the versions differ)");
    }

    #[test]
    fn the_queue_survives_the_session_object() {
        // The P1 fix: the outbox lives in the registry keyed by session id,
        // so a Session being dropped (idle eviction, remove-then-resume)
        // must not take the queued messages with it. The same Arc answers.
        let registry = crate::SessionRegistry::with_fence_checker(std::sync::Arc::new(|_| Ok(())));
        let outbox = registry.composer_outbox_for("s-1");
        outbox.enqueue("still queued", None).expect("enqueue");

        // A second fetch answers the SAME store (not a fresh empty queue).
        let again = registry.composer_outbox_for("s-1");
        let (items, version) = again.snapshot();
        assert_eq!(version, 1, "the shared store kept the change");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["message"], "still queued");

        // Dropping every handle and re-fetching still keeps the state (the
        // registry owns it, not the Session).
        drop(outbox);
        drop(again);
        let (items, _) = registry.composer_outbox_for("s-1").snapshot();
        assert_eq!(items.len(), 1, "the queue outlives its Session handles");
    }
}
