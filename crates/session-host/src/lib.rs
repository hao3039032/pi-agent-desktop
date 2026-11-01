//! # session-host — the Rust session host (M2 backbone)
//!
//! One `pi --mode rpc` child per ACTIVE session (plan §五), assembled over
//! [`pi_host`]:
//!
//! - [`SessionRegistry`]: id-keyed registry with concurrent-start
//!   deduplication (one shared start), idle eviction (10 minutes,
//!   [`SessionHost::lease`] holds a session alive) and explicit shutdown —
//!   the semantics `lib/rpc-manager.ts` had on the Node side;
//! - session files: the host creates the JSONL header (id, cwd,
//!   timestamp) before the child opens the file, exactly the
//!   `ensureSessionFile` contract;
//! - the production spawn shape: `--session <file> --session-dir <dir>`
//!   plus the discovery-off flags, the shipped bridge asset and the
//!   session-binding nonce (`PI_WEB_BRIDGE_NONCE`);
//! - the handshake: `get_state` (session identity must equal the header),
//!   `get_commands` and bridge-command attribution (source-path verified);
//! - events: every session fans its child's records out to N subscribers
//!   (each subscriber gets its own channel; drops detach);
//! - [`dispatch`]: the closed operation table for the Tauri `pi_ipc`
//!   command — unknown operations never reach a child.
//!
//! The message-level session state machine (queueing, steering, compaction,
//! tool events, fleet monitoring) layers on top in later M2 steps; this
//! crate freezes the process-level backbone with real-pi tests.

pub mod composer_outbox;
pub mod history;
pub mod machine;
mod session_ui;
pub mod spawn_plan;
pub use history::{list_session_files, scan_session_file_info, scan_sessions, SessionIndex, SessionSummary};
pub use machine::{FollowUp, SessionMachine, SessionRunState, StreamingMessage};

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pi_host::bridge::{find_bridge_commands, Bridge};
use pi_host::client::PiRpcClient;
use pi_host::{EnvPolicy, SpawnOptions};
use serde_json::{json, Value};

/// Idle sessions are evicted after this long without a lease refresh
/// (rpc-manager.ts: 10 minutes).
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// One running session (its child, its bridge, its subscribers).
/// The running-set change signal (the event-driven running stream).
///
/// Every session in a registry shares ONE signal. Two kinds of change
/// exist:
///
/// - a run-state TRANSITION (start, settle, child exit, removal) — recorded
///   as a bounded ring of [`RunningTransition`] entries beside the epoch, so
///   a relay that was blocked (a slow Channel send) while a run started AND
///   settled can still REPLAY both transitions instead of seeing only the
///   final set (a short run must not be swallowed — Terra P2-1);
/// - a wake-only bump (a catalogue-version change, an unsubscribe): the
///   epoch moves and waiters re-derive, but no transition is recorded.
///
/// The ring is bounded: a burst longer than it is answered with a `gap`, and
/// the consumer falls back to one full re-derivation (a resync frame), never
/// unbounded memory.
pub struct RunningSignal {
    state: std::sync::Mutex<RunningSignalState>,
    cv: std::sync::Condvar,
}

/// One recorded run-state transition (the replay unit). `seq` is the
/// ring's OWN dense sequence — +1 per recorded transition, never consumed
/// by the wake-only `notify()` bumps — so a consumer's replay cursor stays
/// valid across them (an epoch cursor would see spurious gaps wherever a
/// wake-only bump moved the epoch between two transitions).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningTransition {
    pub seq: u64,
    pub session: String,
    pub running: bool,
}

struct RunningSignalState {
    epoch: u64,
    next_seq: u64,
    ring: std::collections::VecDeque<RunningTransition>,
}

/// How many transitions the replay ring keeps (bounded memory; beyond it
/// consumers get a gap and re-derive from a full snapshot).
const RUNNING_TRANSITION_RING: usize = 512;

impl Default for RunningSignal {
    fn default() -> Self {
        Self {
            state: std::sync::Mutex::new(RunningSignalState {
                epoch: 0,
                next_seq: 0,
                ring: std::collections::VecDeque::new(),
            }),
            cv: std::sync::Condvar::new(),
        }
    }
}

impl RunningSignal {
    /// Wake every waiter WITHOUT recording a transition (a catalogue-version
    /// change, an unsubscribe): waiters re-derive their view from scratch.
    pub fn notify(&self) {
        let mut state = self.state.lock().unwrap();
        state.epoch += 1;
        drop(state);
        self.cv.notify_all();
    }

    /// Record one run-state TRANSITION and wake every waiter: `session`
    /// entered (`running == true`) or left the running set.
    pub fn notify_transition(&self, session: &str, running: bool) {
        let mut state = self.state.lock().unwrap();
        state.epoch += 1;
        state.next_seq += 1;
        let seq = state.next_seq;
        state.ring.push_back(RunningTransition {
            seq,
            session: session.to_string(),
            running,
        });
        while state.ring.len() > RUNNING_TRANSITION_RING {
            state.ring.pop_front();
        }
        drop(state);
        self.cv.notify_all();
    }

    /// The current epoch (a waiter's change-token).
    pub fn epoch(&self) -> u64 {
        self.state.lock().unwrap().epoch
    }

    /// Block until the epoch moves past `seen` or the timeout passes;
    /// answers the epoch observed (unchanged on timeout).
    pub fn wait_for_change(&self, seen: u64, timeout: Duration) -> u64 {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap();
        while state.epoch == seen {
            let now = Instant::now();
            if now >= deadline {
                return state.epoch;
            }
            let (guard, _) = self.cv.wait_timeout(state, deadline - now).unwrap();
            state = guard;
        }
        state.epoch
    }

    /// The transitions recorded after `seen_seq` (in sequence order), and
    /// whether the ring dropped any entry the consumer had not yet seen:
    /// on a gap the caller cannot reconstruct the intermediate sets it
    /// missed and must fall back to a full re-derivation (a resync).
    pub fn changes_since(&self, seen_seq: u64) -> (Vec<RunningTransition>, bool) {
        let state = self.state.lock().unwrap();
        let Some(oldest) = state.ring.front() else {
            // Empty = nothing was EVER recorded (overflow never empties
            // the ring) — nothing to replay, no gap possible.
            return (Vec::new(), false);
        };
        if oldest.seq > seen_seq + 1 {
            return (Vec::new(), true);
        }
        (
            state
                .ring
                .iter()
                .filter(|transition| transition.seq > seen_seq)
                .cloned()
                .collect(),
            false,
        )
    }

    /// The sequence of the most recent recorded transition (0 if none).
    /// A consumer deriving its own baseline NOW starts its replay cursor
    /// here: everything older is already net-reflected in that baseline.
    pub fn last_seq(&self) -> u64 {
        self.state
            .lock()
            .unwrap()
            .ring
            .back()
            .map(|transition| transition.seq)
            .unwrap_or(0)
    }
}

pub type SessionFenceChecker = Arc<dyn Fn(&str, Option<&str>) -> Result<(), String> + Send + Sync>;

pub struct Session {
    fence_checker: SessionFenceChecker,
    /// The registry key (the URL-facing session id).
    pub id: String,
    /// The session file's own header id (the child's sessionId).
    pub session_file_id: String,
    pub session_file: PathBuf,
    pub cwd: PathBuf,
    configured_system_prompt: Option<String>,
    pub(crate) client: Arc<PiRpcClient>,
    pub(crate) bridge: Arc<Bridge>,
    state: Mutex<SessionState>,
    /// Epoch for event subscribers (bumped if the session is ever reset).
    epoch: AtomicU64,
    /// The message-level state machine (fed before fan-out).
    machine: Mutex<crate::machine::SessionMachine>,
    /// The composer outbox (`lib/composer-queue.ts`'s host half): messages
    /// queued while a run was active, delivered once the session is idle.
    /// Arc-shared with the REGISTRY's session-id-keyed store — the queue
    /// must outlive this Session (idle eviction or a remove-then-resume
    /// must not drop queued messages; the Next registry survived wrapper
    /// eviction the same way).
    pub composer_outbox: Arc<composer_outbox::ComposerOutbox>,
    /// The delivery-generation this Session's drain claims under: captured
    /// from the outbox at spawn, fenced off by
    /// [`ComposerOutbox::invalidate_delivery_generation`] the moment this
    /// session leaves the registry (removal/replacement/eviction) — a drain
    /// parked between its alive-check and its claim must never take the
    /// replacement's queue (Terra round-4).
    pub(crate) composer_generation: u64,
    /// One drain at a time (the wrapper's `delivering` flag).
    composer_delivering: Mutex<bool>,
    /// Serializes host branch changes against prompt admission and outbox delivery.
    activity_gate: std::sync::RwLock<()>,
    /// Host-wide policy changes exclude prompt admission and queued delivery.
    policy_gate: Arc<std::sync::RwLock<()>>,
    /// Notified when a run settles (prompt waits) or the child exits.
    settle_cv: std::sync::Condvar,
    /// The registry-wide running-set signal (shared with the relay).
    running_signal: Arc<RunningSignal>,
}

/// Exclusive activity permit, bound to the Session which created it.
pub struct SessionActivityGuard<'a> {
    owner: &'a Session,
    _guard: std::sync::RwLockWriteGuard<'a, ()>,
}

struct SessionState {
    lease_until: Instant,
    started_at: Instant,
    last_active: Instant,
    subscribers: Vec<(u64, std::sync::mpsc::Sender<Value>)>,
    ui: session_ui::SessionUi,
}

impl Session {
    /// Send one RPC command to the child.
    pub fn command(
        &self,
        command: &str,
        data: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, pi_host::PiRpcError> {
        let _policy = if matches!(command, "prompt" | "bash" | "compact" | "set_session_name" | "set_model" | "set_thinking_level") {
            Some(self.policy_gate.try_read().map_err(|_| pi_host::PiRpcError::invalid("session policy change is in progress"))?)
        } else { None };
        let _admission = if matches!(command, "prompt" | "bash" | "compact" | "set_session_name" | "set_model" | "set_thinking_level") {
            Some(self.activity_gate.try_read().map_err(|_| pi_host::PiRpcError::invalid("session branch operation is in progress"))?)
        } else { None };
        if matches!(command, "abort" | "abort_bash") { self.cancel_ui(); }
        if _admission.is_some() {
            (self.fence_checker)(&self.id, None).map_err(pi_host::PiRpcError::invalid)?;
        }
        let result = self.client.command(command, data, timeout);
        self.touch();
        result
    }

    /// Hold across branch validation and mutation so admissions cannot race it.
    pub fn try_branch_activity(&self) -> Result<SessionActivityGuard<'_>, &'static str> {
        let guard = self.activity_gate.try_write().map_err(|_| "session is busy")?;
        (self.fence_checker)(&self.id, None).map_err(|_| "session has an unresolved writer outcome")?;
        Ok(SessionActivityGuard { owner: self, _guard: guard })
    }

    /// Whether the child transport is closing or has exited.
    pub fn is_transport_closing(&self) -> bool {
        self.client.is_closing()
    }

    /// One bridge request (nonce/session-verified by pi-host).
    pub fn bridge_request(
        &self,
        op: &str,
        args: Option<Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, pi_host::bridge::BridgeError> {
        // Steering can execute new work even through a retained Session Arc.
        // Status and stop/interrupt remain available to inspect or stop work.
        let refusal = |message: String| pi_host::bridge::BridgeError::Op(pi_host::bridge::BridgeOpError {
            op: op.to_string(), message, code: Some("busy".into()),
        });
        let _branch_policy = if matches!(op, "tree.navigate" | "session.rename") {
            Some(self.policy_gate.try_read().map_err(|_| refusal("session policy change is in progress".into()))?)
        } else { None };
        let _branch = if _branch_policy.is_some() {
            Some(self.try_branch_activity().map_err(|message| refusal(message.into()))?)
        } else { None };
        let _policy = if op == "subagents.steer" {
            Some(self.policy_gate.try_read().map_err(|_| refusal("session policy change is in progress".into()))?)
        } else { None };
        let _admission = if op == "subagents.steer" {
            Some(self.activity_gate.try_read().map_err(|_| refusal("session branch operation is in progress".into()))?)
        } else { None };
        if _admission.is_some() { (self.fence_checker)(&self.id, None).map_err(refusal)?; }
        self.bridge.request(op, args, timeout)
    }

    /// Issue a branch mutation while the caller holds this session's activity
    /// guard. This avoids reacquiring the guard in composite host operations.
    pub fn bridge_request_with_activity(
        &self, guard: &SessionActivityGuard<'_>, op: &str,
        args: Option<Value>, timeout: Option<Duration>,
    ) -> Result<Value, pi_host::bridge::BridgeError> {
        if !std::ptr::eq(guard.owner, self) || !matches!(op, "tree.navigate" | "session.rename") {
            return Err(pi_host::bridge::BridgeError::Op(pi_host::bridge::BridgeOpError {
                op: op.to_string(), message: "invalid guarded branch operation".into(), code: Some("invalid_args".into()),
            }));
        }
        (self.fence_checker)(&self.id, None).map_err(|message| pi_host::bridge::BridgeError::Op(pi_host::bridge::BridgeOpError {
            op: op.to_string(), message, code: Some("busy".into()),
        }))?;
        self.bridge.request(op, args, timeout)
    }

    /// The activity owner may dispatch only its own persistently fenced title rename.
    pub fn title_rename_with_owned_fence(
        &self, guard: &SessionActivityGuard<'_>, operation_id: &str,
        task_id: &str, name: &str, timeout: Option<Duration>,
    ) -> Result<Value, pi_host::bridge::BridgeError> {
        if !std::ptr::eq(guard.owner, self) {
            return Err(pi_host::bridge::BridgeError::Op(pi_host::bridge::BridgeOpError {
                op: "title.rename".into(), message: "activity guard belongs to another session".into(), code: Some("fence_refused".into()),
            }));
        }
        (self.fence_checker)(&self.id, Some(operation_id)).map_err(|message| pi_host::bridge::BridgeError::Op(pi_host::bridge::BridgeOpError {
            op: "title.rename".into(), message, code: Some("fence_refused".into()),
        }))?;
        self.bridge.request("title.rename", Some(json!({"id":task_id, "name": name})), timeout)
    }

    /// The exact custom base passed at spawn, not the composed run prompt.
    pub fn configured_system_prompt(&self) -> Option<&str> {
        self.configured_system_prompt.as_deref()
    }

    /// The current get_state snapshot from the child.
    pub fn get_state(&self) -> Result<Value, pi_host::PiRpcError> {
        self.command("get_state", json!({}), Some(Duration::from_secs(30)))
    }

    /// Subscribe to the child's session events. Dropping the receiver
    /// detaches; [`Session::unsubscribe`] detaches by id (the IPC layer's
    /// explicit unsubscribe). Returns (subscriber id, receiver).
    pub fn subscribe(&self) -> (u64, std::sync::mpsc::Receiver<Value>) {
        let (id, rx, _) = self.subscribe_with_ui();
        (id, rx)
    }

    /// Atomically subscribe and snapshot the still-pending dialog records.
    pub fn subscribe_with_ui(&self) -> (u64, std::sync::mpsc::Receiver<Value>, Vec<Value>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut state = self.state.lock().unwrap();
        let id = self.next_subscriber_id();
        let pending = state.ui.records();
        state.subscribers.push((id, tx));
        (id, rx, pending)
    }

    pub fn pending_ui_ids(&self) -> Vec<String> {
        self.state.lock().unwrap().ui.ids()
    }

    /// Extension status and string-array widget state observed from the child.
    pub fn extension_ui_state(&self) -> (Vec<Value>, Vec<Value>) {
        let state = self.state.lock().unwrap();
        (state.ui.statuses(), state.ui.widgets())
    }

    /// Consume a current dialog once, with a response appropriate to its method.
    pub fn respond_ui(&self, id: &str, response: &Value) -> Result<(), &'static str> {
        let mut state = self.state.lock().unwrap();
        let (child_id, payload) = state.ui.answer(id, response)?;
        if !self.client.respond_ui(&child_id, payload) { return Err("session process is closed") }
        let event = json!({"type":"extension_ui_closed", "id":id});
        state.subscribers.retain(|(_, tx)| tx.send(event.clone()).is_ok());
        Ok(())
    }

    fn relay_ui(&self, record: Value) {
        let mut state = self.state.lock().unwrap();
        let (record, cancel) = state.ui.insert(record);
        if let Some((child_id, id)) = cancel {
            self.client.respond_ui(&child_id, json!({"cancelled": true}));
            let closed = json!({"type":"extension_ui_closed", "id":id});
            state.subscribers.retain(|(_, tx)| tx.send(closed.clone()).is_ok());
        }
        if let Some(record) = record {
            state.subscribers.retain(|(_, tx)| tx.send(record.clone()).is_ok());
        }
    }

    fn cancel_ui(&self) {
        let mut state = self.state.lock().unwrap();
        let ids = state.ui.ids();
        for child_id in state.ui.drain() { self.client.respond_ui(&child_id, json!({"cancelled": true})); }
        for id in ids {
            let event = json!({"type":"extension_ui_closed", "id":id});
            state.subscribers.retain(|(_, tx)| tx.send(event.clone()).is_ok());
        }
    }

    fn expire_ui(&self) {
        let mut state = self.state.lock().unwrap();
        for (child_id, id) in state.ui.expire() {
            self.client.respond_ui(&child_id, json!({"cancelled": true}));
            let event = json!({"type":"extension_ui_closed", "id":id});
            state.subscribers.retain(|(_, tx)| tx.send(event.clone()).is_ok());
        }
    }

    /// Detach the subscriber with this id (its relay thread's recv then
    /// fails and the thread exits). Unknown ids are ignored.
    pub fn unsubscribe(&self, subscriber_id: u64) {
        let mut state = self.state.lock().unwrap();
        state.subscribers.retain(|(id, _)| *id != subscriber_id);
        if state.subscribers.is_empty() {
            for id in state.ui.drain() { self.client.respond_ui(&id, json!({"cancelled": true})); }
        }
    }

    fn next_subscriber_id(&self) -> u64 {
        SUBSCRIBER_COUNTER.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Extend the idle lease (a window is attached).
    pub fn lease(&self) {
        let mut state = self.state.lock().unwrap();
        state.lease_until = Instant::now() + IDLE_TIMEOUT;
    }

    /// Whether the session should be evicted now.
    pub fn is_idle_expired(&self) -> bool {
        self.state.lock().unwrap().lease_until <= Instant::now()
    }

    /// Seconds idle (diagnostics).
    pub fn idle_for(&self) -> Duration {
        self.state.lock().unwrap().lease_until.saturating_duration_since(Instant::now())
    }

    fn touch(&self) {
        let mut state = self.state.lock().unwrap();
        state.last_active = Instant::now();
        state.lease_until = Instant::now() + IDLE_TIMEOUT;
    }

    /// The event-stream epoch (M2 reset semantics; bumps when the host
    /// re-attaches a session's stream identity).
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }

    /// The run epoch the machine last saw settled.
    pub fn machine_settled_epoch(&self) -> u64 {
        self.machine.lock().unwrap().settled_epoch()
    }

    /// When the session started (diagnostics).
    pub fn started_at(&self) -> Instant {
        self.state.lock().unwrap().started_at
    }

    /// Emit a HOST-authored event to every subscriber (the composer
    /// outbox's updates): the state machine never sees it (it models the
    /// child's records only), subscribers receive it in arrival order.
    pub(crate) fn emit_host_event(&self, event: Value) {
        let mut state = self.state.lock().unwrap();
        state.last_active = Instant::now();
        state.subscribers.retain(|(_, tx)| tx.send(event.clone()).is_ok());
    }

    fn fan_out(self: &Arc<Self>, record: Value) {
        // 1. The state machine eats first (it may request follow-ups).
        let follow_up = {
            let mut machine = self.machine.lock().unwrap();
            let was_running = machine.state.is_running();
            let follow_up = machine.apply_event(&record);
            if matches!(follow_up, crate::machine::FollowUp::RefreshAfterSettle { .. }) {
                self.settle_cv.notify_all();
            }
            // A run-state TRANSITION (start/settle) is what the running-set
            // stream derives on: signal the relay instead of letting it
            // sample for the change (the event-driven half of the stream).
            if machine.state.is_running() != was_running {
                self.running_signal.notify_transition(&self.id, machine.state.is_running());
            }
            follow_up
        };
        // 2. Subscribers see the raw record in arrival order.
        {
            let mut state = self.state.lock().unwrap();
            state.subscribers.retain(|(_, tx)| tx.send(record.clone()).is_ok());
        }
        // 3. Follow-ups run off the dispatch path (a slow get_state must not
        //    stall the event thread): a settle refresh is epoch-guarded when
        //    it lands (apply_snapshot), stats are advisory.
        match follow_up {
            crate::machine::FollowUp::RefreshAfterSettle { epoch } => {
                let client = Arc::clone(&self.client);
                let session = Arc::clone(self);
                std::thread::Builder::new()
                    .name("settle-refresh".into())
                    .spawn(move || {
                        if let Ok(snapshot) =
                            client.command("get_state", json!({}), Some(Duration::from_secs(30)))
                        {
                            session.apply_snapshot(snapshot, epoch);
                        }
                        let _ =
                            client.command("get_session_stats", json!({}), Some(Duration::from_secs(30)));
                        // A run settled: queued composer messages may deliver now
                        // (the wrapper's agent_settled → wake).
                        session.composer_wake();
                    })
                    .ok();
            }
            crate::machine::FollowUp::RefreshStats => {
                let client = Arc::clone(&self.client);
                std::thread::Builder::new()
                    .name("stats-refresh".into())
                    .spawn(move || {
                        let _ =
                            client.command("get_session_stats", json!({}), Some(Duration::from_secs(30)));
                    })
                    .ok();
            }
            crate::machine::FollowUp::None => {}
        }
    }

    /// Merge one get_state snapshot into the machine (epoch-guarded for the
    /// volatile run flags).
    pub fn apply_snapshot(&self, snapshot: Value, captured_epoch: u64) {
        let was_running = self.machine.lock().unwrap().state.is_running();
        self.machine.lock().unwrap().apply_state_snapshot(&snapshot, captured_epoch);
        // A state merge can move the run flags too (the settle refresh, a
        // cold get_state): a transition wakes the running-set relay.
        let running_now = self.machine.lock().unwrap().state.is_running();
        if running_now != was_running {
            self.running_signal.notify_transition(&self.id, running_now);
        }
    }

    /// Pull one get_state NOW and merge it at the current epoch (stable
    /// fields always apply; a run in flight keeps its live flags).
    pub fn refresh_state_now(&self) -> Result<(), pi_host::PiRpcError> {
        let epoch = self.machine.lock().unwrap().epoch();
        let snapshot = self.command("get_state", json!({}), Some(Duration::from_secs(30)))?;
        self.apply_snapshot(snapshot, epoch);
        Ok(())
    }

    /// The projected run state (a cheap copy for IPC responses).
    pub fn run_state(&self) -> crate::machine::SessionRunState {
        let mut result = self.machine.lock().unwrap().state.clone();
        result.pending_ui_request_ids = self.pending_ui_ids();
        result
    }

    /// Wait until the run of `min_epoch` (or later) settled, the child
    /// exited, or `limit` passed. The TS prompt contract: the promise
    /// resolves only once the run is fully idle.
    pub fn wait_for_settle(&self, min_epoch: u64, limit: Duration) -> SettleOutcome {
        let deadline = Instant::now() + limit;
        let mut machine = self.machine.lock().unwrap();
        loop {
            if machine.settled_epoch() >= min_epoch && !machine.state.is_streaming {
                return SettleOutcome::Settled;
            }
            if self.client.has_exited() {
                return SettleOutcome::ChildExited;
            }
            let now = Instant::now();
            if now >= deadline {
                return SettleOutcome::Timeout;
            }
            let (guard, _) = self.settle_cv.wait_timeout(machine, deadline - now).unwrap();
            machine = guard;
        }
    }

    /// Send a prompt and wait for its run to settle (the SDK contract).
    pub fn prompt(&self, message: &str) -> Result<crate::machine::SessionRunState, SessionHostError> {
        let epoch_at_send = self.machine.lock().unwrap().epoch();
        let response = self
            .command(
                "prompt",
                json!({ "message": message }),
                Some(Duration::from_secs(120)),
            )
            .map_err(|error| SessionHostError::Spawn(error.to_string()))?;
        let disposition = match response.get("disposition").and_then(Value::as_str) {
            Some("queued") => "queued",
            Some("handled") => "handled",
            _ => "started",
        };
        match disposition {
            // A started run waits for the NEXT epoch; a queued one for the
            // current; "handled" starts no run.
            "started" => {
                match self.wait_for_settle(epoch_at_send + 1, Duration::from_secs(600)) {
                    SettleOutcome::Settled => {}
                    SettleOutcome::ChildExited => {
                        return Err(SessionHostError::Spawn("pi process exited during the run".into()))
                    }
                    SettleOutcome::Timeout => {
                        return Err(SessionHostError::Spawn("the run did not settle in time".into()))
                    }
                }
            }
            "queued" => {
                match self.wait_for_settle(epoch_at_send, Duration::from_secs(600)) {
                    SettleOutcome::Settled => {}
                    SettleOutcome::ChildExited => {
                        return Err(SessionHostError::Spawn("pi process exited during the run".into()))
                    }
                    SettleOutcome::Timeout => {
                        return Err(SessionHostError::Spawn("the run did not settle in time".into()))
                    }
                }
            }
            _ => {}
        }
        Ok(self.run_state())
    }

    /// The current projected state after any events so far.
    pub fn state(&self) -> crate::machine::SessionRunState {
        self.run_state()
    }

    /// The in-memory partial assistant message (the state responses'
    /// `streamingMessage`): the machine's accumulated dense content blocks
    /// projected onto the AgentMessage shape the UI seeds its snapshot with.
    pub fn streaming_message_value(&self) -> Value {
        let machine = self.machine.lock().unwrap();
        match machine.streaming_message() {
            Some(message) => {
                let mut value = json!({
                    "role": "assistant",
                    "content": message.content,
                });
                if let Some(usage) = &message.usage {
                    value["usage"] = usage.clone();
                }
                value
            }
            None => Value::Null,
        }
    }

    /// Orderly shutdown: stdin EOF then grace kill (pi-host close).
    pub fn shutdown(&self, grace: Duration) -> Option<i32> {
        // A shutdown while a settle waiter sleeps must wake it at once (the
        // fan thread's exit wake covers a child-side exit; this covers the
        // host-ordered one — remove/evict during an in-flight delivery).
        self.cancel_ui();
        let exit = self.client.close(grace);
        self.settle_cv.notify_all();
        exit
    }

    /// Test seam (`test-seams` feature — this crate's own test builds only;
    /// release builds never compile it): shorten the lease to force the
    /// idle path deterministically.
    #[cfg(feature = "test-seams")]
    pub fn state_for_tests_set_lease(&self, remaining: Duration) {
        self.state.lock().unwrap().lease_until = Instant::now() + remaining;
    }

    /// Test seam (`test-seams` feature): whether the child process exited.
    #[cfg(feature = "test-seams")]
    pub fn client_has_exited_for_tests(&self) -> bool {
        self.client.has_exited()
    }

    /// Test seam (`test-seams` feature — this crate's own test builds only):
    /// SIGKILL the child (deterministically reproducing a child crash while
    /// a delivery or settle waiter is in flight).
    #[cfg(feature = "test-seams")]
    pub fn client_kill_for_tests(&self) {
        self.client.kill();
    }
}

static SUBSCRIBER_COUNTER: AtomicU64 = AtomicU64::new(0);

/// How to spawn session children: the KIND drives everything the Next
/// factory (`lib/pi-rpc/factory.ts` startCliRpcSessionFromManager) decided
/// per session — discovery flags, tools, exact prompts and the chat policy.
#[derive(Clone)]
pub enum SessionSpawnShape {
    /// A project session (the factory's normal path): discovery stays ON —
    /// the child loads user extensions, skills, prompt templates, themes and
    /// context files on its own, exactly like the Next server's children. An
    /// optional pinned selection applies via `--tools` (already entry-
    /// mapped with the shell switch applied by [`spawn_plan::build_tool_entries`]).
    Project { tool_args: Option<Vec<String>> },
    /// The chat-only pin (an empty pinned selection in a project): no tools,
    /// no discovery, and the exact prompt built from the session cwd's
    /// context files replaces pi's own (`--no-*` + `--system-prompt`).
    ChatOnly { prompt_file: PathBuf },
    /// A chat workspace session: the chat policy extension, the exact chat
    /// prompt, and — while locked — the chat tool loadout replacing the
    /// coding domain plus the delegation tools excluded.
    Chat { prompt_file: PathBuf, folder: bool, unlocked: bool, files_enabled: bool },
}

#[derive(Clone)]
pub struct SessionSpawnConfig {
    /// Absolute pi executable.
    pub executable: String,
    /// Overrides ~/.pi/agent for settings (tests pass a sandbox).
    pub agent_dir: Option<PathBuf>,
    /// Session storage dir (the fork target dir; defaults beside the file).
    pub session_dir: Option<PathBuf>,
    /// Absolute path of the shipped bridge extension.
    pub bridge_asset: PathBuf,
    /// The artifacts guide asset (loaded wherever the bridge loads).
    pub artifacts_asset: Option<PathBuf>,
    /// The chat policy asset (`pi-web-chat.mjs`) a chat session loads.
    pub chat_asset: Option<PathBuf>,
    /// The pinned SHA-256 (hex) of [`SessionSpawnConfig::chat_asset`]'s
    /// bytes — REQUIRED for the Chat shape: the host verifies the file the
    /// child will load against it before spawning (a swapped, corrupted or
    /// truncated asset that still registers the readiness marker must fail
    /// closed, never hand a chat its tool loadout without the policy hooks
    /// — Terra P1-1). The pin is the CALLER's compile-time constant
    /// (src-tauri embeds the shipped bytes); it is never derived from the
    /// file being checked.
    pub chat_asset_sha256: Option<String>,
    /// What kind of session to spawn (args, discovery, prompt, tools).
    pub shape: SessionSpawnShape,
    /// The model the child must run: the file's saved model, else the
    /// request's initial pick — applied via `set_model` after the handshake
    /// exactly like the factory's restore step (a failure leaves the child
    /// on its default; it never fails the session).
    pub initial_model: Option<(String, String)>,
    /// A requested thinking level (`--thinking`).
    pub thinking_level: Option<String>,
    /// Extra args after the standard set (tests).
    pub extra_args: Vec<String>,
}

/// Create a session file with the pi-web header (id, cwd, timestamp),
/// returning (file path, header id). The child opens THIS file; the host is
/// the header's author, the child appends the conversation.
pub fn create_session_file(session_dir: &Path, cwd: &Path) -> std::io::Result<(PathBuf, String)> {
    std::fs::create_dir_all(session_dir)?;
    let id = uuid::Uuid::new_v4().to_string();
    let file = session_dir.join(format!("{}_{}.jsonl", iso_now_compact(), id));
    let header = json!({
        "type": "session",
        "version": 3,
        "id": id,
        "timestamp": iso_now_iso(),
        "cwd": cwd.to_string_lossy(),
    });
    std::fs::write(&file, format!("{header}\n"))?;
    Ok((file, id))
}

/// Failure to acquire an idle session writer, or an error from its operation.
#[derive(Debug)]
pub enum SessionWriterError<E> {
    Busy(&'static str),
    Operation(E),
}

/// The registry: one child per active session id, shared concurrent starts.
pub struct SessionRegistry {
    fence_checker: SessionFenceChecker,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// One in-flight spawn per id (rpc-manager's `__piStartLocks`): the
    /// first caller spawns, the rest wait on the mutex and read the result
    /// from the session map — a failed spawn is retried by the next caller,
    /// never cached as a poison state.
    start_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// The composer outboxes BY SESSION ID, decoupled from the live
    /// Session objects (the Next `__piComposerQueues` registry: a queued
    /// message survives idle eviction and a remove-then-resume).
    composer_outboxes: Mutex<HashMap<String, Arc<composer_outbox::ComposerOutbox>>>,
    /// The running-set change signal the running stream derives on.
    running_signal: Arc<RunningSignal>,
    policy_gate: Arc<std::sync::RwLock<()>>,
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::with_fence_checker(Arc::new(|_, _| Err("session fence checker is not configured".into())))
    }

    pub fn with_fence_checker(fence_checker: SessionFenceChecker) -> Self {
        Self::with_policy_gate_and_fence_checker(Arc::new(std::sync::RwLock::new(())), fence_checker)
    }

    pub fn with_policy_gate_and_fence_checker(
        policy_gate: Arc<std::sync::RwLock<()>>, fence_checker: SessionFenceChecker,
    ) -> Self {
        Self {
            fence_checker,
            sessions: Mutex::new(HashMap::new()),
            start_locks: Mutex::new(HashMap::new()),
            composer_outboxes: Mutex::new(HashMap::new()),
            running_signal: Arc::new(RunningSignal::default()),
            policy_gate,
        }
    }

    /// The registry-wide running-set signal (the running stream waits on
    /// it instead of sampling).
    pub fn running_signal(&self) -> Arc<RunningSignal> {
        Arc::clone(&self.running_signal)
    }

    /// The session-id-keyed composer outbox (created on first use, kept
    /// across Session lifetimes — the queue outlives the child).
    pub fn composer_outbox_for(&self, id: &str) -> Arc<composer_outbox::ComposerOutbox> {
        let mut outboxes = self.composer_outboxes.lock().unwrap();
        Arc::clone(outboxes.entry(id.to_string()).or_insert_with(|| Arc::new(composer_outbox::ComposerOutbox::new())))
    }

    /// Serialize file mutation with start and real child shutdown for this id.
    pub fn start_lock_for(&self, id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.start_locks.lock().unwrap();
        Arc::clone(locks.entry(id.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))))
    }

    /// Serialize a host writer against spawn/removal and live prompt admission.
    /// The closure runs with both guards held and must not call start/remove or
    /// acquire this session's activity gate again. It may issue a bridge request
    /// that does not itself acquire that gate. Do not wait on network while also
    /// holding a scheduler transaction.
    pub fn with_idle_session_writer<T, E>(
        &self, id: &str, operation: impl FnOnce(Option<&Arc<Session>>) -> Result<T, E>,
    ) -> Result<T, SessionWriterError<E>> {
        let lock = self.start_lock_for(id);
        let _start = lock.try_lock().map_err(|_| SessionWriterError::Busy("session admission is in progress"))?;
        (self.fence_checker)(id, None).map_err(|_| SessionWriterError::Busy("session has an unresolved writer outcome"))?;
        // Include exited entries: their in-flight delivery can still restore an
        // unknown message to the persistent outbox after the process exits.
        let session = self.sessions.lock().unwrap().get(id).cloned();
        let _activity = match &session {
            Some(session) => Some(session.try_branch_activity().map_err(SessionWriterError::Busy)?),
            None => None,
        };
        let outbox = self.composer_outbox_for(id);
        if outbox.has_pending_or_in_flight() || session.as_ref().is_some_and(|session| session.run_state().is_running()) {
            return Err(SessionWriterError::Busy("session is running or has pending messages"));
        }
        operation(session.as_ref()).map_err(SessionWriterError::Operation)
    }

    /// Run a snapshot-based copy while admission is held. When the copy is
    /// ready, optionally close the exact guarded source before finalizing its
    /// fences. Neither callback may re-enter this session's admission gate.
    pub fn with_idle_session_copy<T, U, E>(
        &self, id: &str, grace: Duration,
        copy: impl FnOnce(Option<&Arc<Session>>) -> Result<(T, bool), E>,
        finalize: impl FnOnce(T) -> Result<U, E>,
    ) -> Result<U, SessionWriterError<E>> {
        match self.with_idle_session_writer(id, |session| {
            let (value, close_source) = copy(session).map_err(SessionWriterError::Operation)?;
            if close_source {
                if let Some(session) = session {
                    if session.run_state().is_running() || session.composer_outbox.has_pending_or_in_flight()
                        || session.bridge_request("tree.assertIdle", None, Some(grace)).is_err() {
                        return Err(SessionWriterError::Busy("copy completed but source is no longer idle; do not retry"));
                    }
                    if !session.client.close_without_kill(grace) {
                        return Err(SessionWriterError::Busy("copy completed but source exit is unconfirmed; do not retry"));
                    }
                    self.remove_locked(id, Duration::ZERO);
                    if !session.client.has_exited() {
                        return Err(SessionWriterError::Busy("copy completed but source exit is unconfirmed; do not retry"));
                    }
                }
            }
            finalize(value).map_err(SessionWriterError::Operation)
        }) {
            Ok(value) => Ok(value),
            Err(SessionWriterError::Busy(message)) => Err(SessionWriterError::Busy(message)),
            Err(SessionWriterError::Operation(error)) => Err(error),
        }
    }

    /// Try to lock writers in lexical id order, then acquire their activity
    /// guards in the same order. Busy gates refuse instead of waiting while a
    /// caller may hold a scheduler transaction. The closure must not re-enter.
    pub fn with_idle_session_writers<T, E>(
        &self, ids: &[String], operation: impl FnOnce(&[Option<Arc<Session>>]) -> Result<T, E>,
    ) -> Result<T, SessionWriterError<E>> {
        let mut ids = ids.to_vec();
        ids.sort();
        ids.dedup();
        let locks: Vec<_> = ids.iter().map(|id| self.start_lock_for(id)).collect();
        let _starts: Vec<_> = locks.iter().map(|lock| {
            lock.try_lock().map_err(|_| SessionWriterError::Busy("session admission is in progress"))
        }).collect::<Result<_, _>>()?;
        let sessions: Vec<_> = {
            let registry = self.sessions.lock().unwrap();
            ids.iter().map(|id| registry.get(id).cloned()).collect()
        };
        let mut activities = Vec::with_capacity(sessions.len());
        for session in &sessions {
            activities.push(match session {
                Some(session) => Some(session.try_branch_activity().map_err(SessionWriterError::Busy)?),
                None => None,
            });
        }
        for (id, session) in ids.iter().zip(&sessions) {
            (self.fence_checker)(id, None).map_err(|_| SessionWriterError::Busy("session has an unresolved writer outcome"))?;
            if self.composer_outbox_for(id).has_pending_or_in_flight()
                || session.as_ref().is_some_and(|session| session.run_state().is_running()) {
                return Err(SessionWriterError::Busy("session is running or has pending messages"));
            }
        }
        operation(&sessions).map_err(SessionWriterError::Operation)
    }

    /// Hold ordered session start gates and check their persistent fences for a
    /// bounded read snapshot. The caller holds the host policy read gate first,
    /// then any scheduler transaction, and must not wait on a child or network.
    /// Live sessions remain searchable; callers must detect concurrent in-place
    /// writes while copying and never mutate files.
    pub fn with_session_snapshot_gates<T, E>(
        &self, ids: &[String], operation: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, SessionWriterError<E>> {
        let mut ids = ids.to_vec();
        ids.sort();
        ids.dedup();
        let locks: Vec<_> = ids.iter().map(|id| self.start_lock_for(id)).collect();
        let mut starts = Vec::with_capacity(locks.len());
        for lock in &locks {
            starts.push(lock.try_lock().map_err(|_| SessionWriterError::Busy("session writer is busy"))?);
        }
        for id in &ids {
            (self.fence_checker)(id, None).map_err(|_| SessionWriterError::Busy("session has an unresolved writer outcome"))?;
        }
        operation().map_err(SessionWriterError::Operation)
    }

    /// Stop an idle child without force-killing it, prove its actual exit,
    /// then run an offline writer while the same id and activity gates remain
    /// held. A timeout leaves the child registered and fails closed. The
    /// operation must not call start/remove or re-enter this writer gate.
    pub fn with_offline_session_writer<T, E>(
        &self, id: &str, grace: Duration, operation: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, SessionWriterError<E>> {
        match self.with_idle_session_writer(id, |session| {
            if let Some(session) = session {
                if !session.client.has_exited() {
                    session.bridge_request("tree.assertIdle", None, Some(grace))
                        .map_err(|_| SessionWriterError::Busy("could not confirm that the session is idle"))?;
                    if !session.client.close_without_kill(grace) {
                        return Err(SessionWriterError::Busy("session process has not exited"));
                    }
                }
                self.remove_locked(id, Duration::ZERO);
                if !session.client.has_exited() {
                    return Err(SessionWriterError::Busy("session process has not exited"));
                }
            }
            operation().map_err(SessionWriterError::Operation)
        }) {
            Ok(value) => Ok(value),
            Err(SessionWriterError::Busy(message)) => Err(SessionWriterError::Busy(message)),
            Err(SessionWriterError::Operation(error)) => Err(error),
        }
    }

    /// Start (or return the running) session for an id. Concurrent starts
    /// for the same id share ONE spawn.
    pub fn start(
        &self,
        id: &str,
        session_file: &Path,
        session_file_id: &str,
        cwd: &Path,
        config: &SessionSpawnConfig,
    ) -> Result<Arc<Session>, SessionHostError> {
        self.start_with_plan(id, session_file, session_file_id, cwd, || Ok(config.clone()))
    }

    /// Derive disk-dependent spawn policy only after acquiring the id writer
    /// gate. In particular a chat unlock written by an offline writer must be
    /// observed by every later spawn, even one requested before that write.
    pub fn start_with_plan(
        &self, id: &str, session_file: &Path, session_file_id: &str, cwd: &Path,
        plan: impl FnOnce() -> Result<SessionSpawnConfig, String>,
    ) -> Result<Arc<Session>, SessionHostError> {
        let _policy = self.policy_gate.try_read().map_err(|_| SessionHostError::Spawn("session policy change is in progress".to_string()))?;
        let lock = self.start_lock_for(id);
        let _guard = lock.lock().unwrap();
        (self.fence_checker)(id, None).map_err(SessionHostError::Spawn)?;
        // Won the lock: re-check (another caller may have finished spawning).
        if let Some(existing) = self.get(id) {
            if existing.is_idle_expired() {
                // The old child must die BEFORE the replacement spawns: both
                // would share this session id's composer outbox, and a still-
                // living old child (or its in-flight drain) could consume or
                // duplicate a queued delivery the new child should own. The
                // shutdown is synchronous — stdin EOF, then a grace kill —
                // and its drain observes the exit and stops.
                let _ = self.remove_locked(id, Duration::from_secs(5));
                if !existing.client.has_exited() {
                    return Err(SessionHostError::Spawn("previous session writer has not exited".to_string()));
                }
            } else {
                return Ok(existing);
            }
        }
        // A deletion may have completed while this start waited for the id lock.
        // Never let a stale catalogue result recreate the removed session.
        if !session_file.is_file() {
            return Err(SessionHostError::Spawn("session file no longer exists".to_string()));
        }
        let config = plan().map_err(SessionHostError::Spawn)?;
        // The composer outbox comes from the session-id store: a resumed
        // session inherits the queue an evicted child left behind.
        let composer_outbox = self.composer_outbox_for(id);
        let session = spawn_session(
            id,
            session_file,
            session_file_id,
            cwd,
            &config,
            composer_outbox,
            Arc::clone(&self.running_signal),
            Arc::clone(&self.policy_gate),
            Arc::clone(&self.fence_checker),
        )?;
        self.sessions.lock().unwrap().insert(id.to_string(), Arc::clone(&session));
        Ok(session)
    }

    /// The running session for an id (if alive).
    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .get(id)
            .filter(|session| !session.client.has_exited())
            .cloned()
    }

    /// Detach and shut a session down; returns its exit code. The fence is
    /// raised BEFORE the shutdown: the moment the id leaves the registry,
    /// every outstanding claim right of this session's drain is gone —
    /// wherever that drain is parked — so it cannot wake into the queue the
    /// next owner (or the user) holds (Terra round-4).
    pub fn remove(&self, id: &str, grace: Duration) -> Option<Option<i32>> {
        let lock = self.start_lock_for(id);
        let _guard = lock.lock().unwrap();
        self.remove_locked(id, grace)
    }

    fn remove_locked(&self, id: &str, grace: Duration) -> Option<Option<i32>> {
        let session = self.sessions.lock().unwrap().get(id).cloned()?;
        self.composer_outbox_for(id).invalidate_delivery_generation();
        let exit = session.shutdown(grace);
        // A timeout does not prove the writer exited. Retain the closing
        // session so a start or deletion cannot race its final append.
        if !session.client.has_exited() { return Some(exit); }
        let mut sessions = self.sessions.lock().unwrap();
        if sessions.get(id).is_some_and(|current| Arc::ptr_eq(current, &session)) {
            sessions.remove(id);
        }
        drop(sessions);
        // The session left the registry: it is out of the running set
        // whatever the child's state was — record the transition so a
        // blocked relay still replays the removal.
        self.running_signal.notify_transition(id, false);
        Some(exit)
    }

    /// Evict sessions whose lease expired; returns the evicted ids. The
    /// caller (the host's idle sweep) owns the cadence.
    pub fn evict_idle(&self) -> Vec<String> {
        let expired: Vec<String> = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .iter()
                .filter(|(_, session)| session.is_idle_expired() || session.client.has_exited())
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in &expired {
            self.remove(id, Duration::from_secs(5));
        }
        expired
    }

    /// Registered sessions, including exited children whose outbox may still be unwinding.
    pub fn registered_sessions(&self) -> Vec<Arc<Session>> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }

    /// Outboxes survive closed children and must be considered by policy changes.
    pub fn pending_composer_session_ids(&self) -> Vec<String> {
        self.composer_outboxes.lock().unwrap().iter()
            .filter(|(_, outbox)| outbox.has_pending_or_in_flight())
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Live session ids (diagnostics/tests).
    pub fn ids(&self) -> Vec<String> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, session)| !session.client.has_exited())
            .map(|(id, _)| id.clone())
            .collect()
    }
}

/// How a settle wait ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettleOutcome {
    Settled,
    ChildExited,
    Timeout,
}

/// Session-host-level errors.
#[derive(Debug)]
pub enum SessionHostError {
    Spawn(String),
    Handshake(String),
}

impl std::fmt::Display for SessionHostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionHostError::Spawn(message) => write!(f, "session child failed to start: {message}"),
            SessionHostError::Handshake(message) => write!(f, "session handshake failed: {message}"),
        }
    }
}

impl std::error::Error for SessionHostError {}

fn spawn_session(
    id: &str,
    session_file: &Path,
    session_file_id: &str,
    cwd: &Path,
    config: &SessionSpawnConfig,
    composer_outbox: Arc<composer_outbox::ComposerOutbox>,
    running_signal: Arc<RunningSignal>,
    policy_gate: Arc<std::sync::RwLock<()>>,
    fence_checker: SessionFenceChecker,
) -> Result<Arc<Session>, SessionHostError> {
    let nonce = uuid::Uuid::new_v4().to_string();
    let session_dir = config
        .session_dir
        .clone()
        .unwrap_or_else(|| session_file.parent().map(Path::to_path_buf).unwrap_or_default());
    // The spawn shape mirrors the Next factory exactly (which flags a KIND
    // gets, which assets load, which env the child sees):
    //
    // - project: discovery ON (skills/context files/user extensions load);
    // - chat-only pin: everything off + the exact context-files prompt;
    // - chat: context files off (the chat preamble replaces pi's prompt),
    //   the chat policy asset, and — locked — the chat tool loadout plus
    //   the delegation tools excluded.
    let mut args: Vec<String> = vec![
        "--session".into(),
        session_file.to_string_lossy().into_owned(),
        "--session-dir".into(),
        session_dir.to_string_lossy().into_owned(),
    ];
    let mut env = EnvPolicy::inherit().set("PI_WEB_BRIDGE_NONCE", nonce.clone());
    match &config.shape {
        SessionSpawnShape::Project { tool_args } => {
            if let Some(entries) = tool_args {
                args.push("--tools".into());
                args.push(entries.join(","));
            }
        }
        SessionSpawnShape::ChatOnly { prompt_file } => {
            args.extend([
                "--no-tools".into(),
                "--no-extensions".into(),
                "--no-skills".into(),
                "--no-prompt-templates".into(),
                "--no-themes".into(),
                "--no-context-files".into(),
                "--system-prompt".into(),
                prompt_file.to_string_lossy().into_owned(),
            ]);
        }
        SessionSpawnShape::Chat { prompt_file, folder, unlocked, files_enabled } => {
            // Fail closed: a chat without its policy asset must never start.
            // The asset carries the before_agent_start / tool_call
            // enforcement that confines the chat's file tools to its folder
            // and withholds un-allowed extension tools — losing it while
            // keeping --tools would hand the model file tools with no path
            // limits (the Next factory threw when the asset was missing).
            let chat_asset = config.chat_asset.as_ref().ok_or_else(|| {
                SessionHostError::Spawn(
                    "the chat policy asset (pi-web-chat.mjs) is missing; a chat cannot start without it".to_string(),
                )
            })?;
            if !chat_asset.is_file() {
                return Err(SessionHostError::Spawn(format!(
                    "the chat policy asset is not readable: {}; a chat cannot start without it",
                    chat_asset.display()
                )));
            }
            // The integrity pin (Terra P1-1): the file must be BYTE-IDENTICAL
            // to the asset the host shipped. The handshake's marker check
            // proves a `pi-web:chat-policy` command registered from this
            // path — but a corrupted, truncated or swapped file can still
            // register the marker while missing the hooks that follow it in
            // the (correct) asset, and a registration that fails midway can
            // leave an already-registered command behind. The pin closes
            // that whole class: only the shipped content can pass BOTH
            // checks, and in the shipped content the marker registers LAST,
            // after every hook.
            let expected = config.chat_asset_sha256.as_deref().ok_or_else(|| {
                SessionHostError::Spawn(
                    "the chat policy asset has no pinned SHA-256; a chat cannot start without it".to_string(),
                )
            })?;
            let bytes = std::fs::read(chat_asset).map_err(|error| {
                SessionHostError::Spawn(format!(
                    "the chat policy asset could not be read for its integrity check ({}): {error}",
                    chat_asset.display()
                ))
            })?;
            let digest = sha256_hex(&bytes);
            if !digest.eq_ignore_ascii_case(expected) {
                return Err(SessionHostError::Spawn(format!(
                    "the chat policy asset does not match its pinned digest ({}: expected {expected}, found {digest}); \
                     a chat cannot start with a policy asset the host did not ship",
                    chat_asset.display()
                )));
            }
            args.push("--no-context-files".into());
            args.push("--system-prompt".into());
            args.push(prompt_file.to_string_lossy().into_owned());
            args.push("--extension".into());
            args.push(chat_asset.to_string_lossy().into_owned());
            if !unlocked {
                // Delegation tools hand work to agents that carry their own
                // tools — a chat's limits would not reach them.
                args.push("--exclude-tools".into());
                args.push("Agent,get_subagent_result,steer_subagent".into());
                // The chat loadout replaces the coding domain (folder chats
                // get the file tools, a legacy chat `read` alone).
                let loadout: &[&str] = if *folder {
                    &["read", "write", "edit", "grep", "find", "ls"]
                } else {
                    &["read"]
                };
                let default_tools = config
                    .agent_dir
                    .as_deref()
                    .and_then(|agent_dir| spawn_plan::resolved_default_tools(agent_dir, cwd, true));
                let selection: Vec<String> = loadout.iter().map(|name| name.to_string()).collect();
                let entries = spawn_plan::build_tool_entries(&selection, default_tools.as_ref());
                args.push("--tools".into());
                args.push(entries.join(","));
            }
            env = env.set(
                "PI_WEB_CHAT_MODE",
                if *unlocked {
                    "unlocked"
                } else if *folder {
                    "folder"
                } else {
                    "legacy"
                },
            );
            if *files_enabled {
                env = env.set("PI_WEB_CHAT_FILES", "1");
            }
        }
    }
    args.push("--extension".into());
    args.push(config.bridge_asset.to_string_lossy().into_owned());
    if let Some(artifacts) = &config.artifacts_asset {
        // The artifacts guide loads wherever the bridge loads (every kind).
        args.push("--extension".into());
        args.push(artifacts.to_string_lossy().into_owned());
    }
    if let Some(thinking) = &config.thinking_level {
        args.push("--thinking".into());
        args.push(thinking.clone());
    }
    args.extend(config.extra_args.iter().cloned());
    if let Some(agent_dir) = &config.agent_dir {
        env = env.set("PI_CODING_AGENT_DIR", agent_dir.to_string_lossy().into_owned());
    }

    let configured_system_prompt = match &config.shape {
        SessionSpawnShape::ChatOnly { prompt_file } | SessionSpawnShape::Chat { prompt_file, .. } =>
            std::fs::read_to_string(prompt_file).ok().map(|s| s.strip_prefix('\u{feff}').unwrap_or(&s).to_owned()),
        SessionSpawnShape::Project { .. } => None,
    };
    let client = PiRpcClient::spawn(
        &config.executable,
        SpawnOptions { args, cwd: Some(cwd.to_path_buf()), env, ui_attach_timeout: Some(Duration::from_secs(30)), ..SpawnOptions::default() },
    )
    .map_err(|error| SessionHostError::Spawn(error.to_string()))?;

    // Event fan-out thread: child records → subscribers. The thread OWNS the
    // client subscription (moved into the closure): dropping it at the end
    // of spawn_session — the bug this fixed — detached the listener at once,
    // the fan thread's recv failed immediately and the session received NO
    // events after the handshake (no state machine, no settle wakeups).
    // Ownership here keeps the subscription alive exactly as long as the
    // fan thread lives, which ends when the child's transport closes.
    let (events, subscription) = client.on_event();
    // The drain's delivery generation: whatever the outbox accepts NOW (a
    // resumed id inherits the queue an evicted child left behind — and the
    // generation its removal raised: the old child's drain is fenced).
    let composer_generation = composer_outbox.generation();
    let (ui_tx, ui_rx) = std::sync::mpsc::sync_channel(64);
    let state = Arc::new(Session {
        id: id.to_string(),
        session_file_id: session_file_id.to_string(),
        session_file: session_file.to_path_buf(),
        cwd: cwd.to_path_buf(),
        configured_system_prompt,
        client: Arc::clone(&client),
        bridge: Bridge::attach_with_ui_forward(Arc::clone(&client), session_file_id.to_string(), nonce, ui_tx.clone()),
        state: Mutex::new(SessionState {
            lease_until: Instant::now() + IDLE_TIMEOUT,
            started_at: Instant::now(),
            last_active: Instant::now(),
            subscribers: Vec::new(),
            ui: session_ui::SessionUi::default(),
        }),
        epoch: AtomicU64::new(1),
        machine: Mutex::new(crate::machine::SessionMachine::new(session_file_id)),
        composer_outbox,
        composer_generation,
        composer_delivering: Mutex::new(false),
        activity_gate: std::sync::RwLock::new(()),
        policy_gate,
        fence_checker,
        settle_cv: std::sync::Condvar::new(),
        running_signal,
    });
    {
        let guards: Vec<_> = ["select", "confirm", "input", "editor", "setStatus", "setWidget", "setTitle", "set_editor_text"]
            .iter().map(|method| client.on_ui_bounded(method, ui_tx.clone())).collect();
        drop(ui_tx);
        client.end_ui_attach_window();
        let weak = Arc::downgrade(&state);
        std::thread::Builder::new().name(format!("session-ui-{id}")).spawn(move || {
            let _guards = guards;
            loop {
                let Some(session) = weak.upgrade() else { break };
                if session.client.has_exited() { session.cancel_ui(); break }
                match ui_rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(request) => session.relay_ui(request.record),
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => session.expire_ui(),
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        }).map_err(|error| SessionHostError::Spawn(error.to_string()))?;
    }
    {
        let fan = Arc::clone(&state);
        std::thread::Builder::new()
            .name(format!("session-events-{id}"))
            .spawn(move || {
                // The subscription dies WITH this thread: dropping it at the
                // loop's end detaches the listener only once the child's
                // transport has closed (recv failed) — the session is over.
                let _subscription_guard = subscription;
                while let Ok(record) = events.recv() {
                    fan.fan_out(record);
                }
                // The child is gone: a running session left the running SET
                // with no further record to carry the news — record the
                // exit so a blocked relay still replays it.
                fan.running_signal.notify_transition(&fan.id, false);
                // And wake every settle waiter at once: `wait_for_settle`
                // re-checks `has_exited()` only when notified (its timeout
                // is the 600 s settle deadline), so without this wake a
                // prompt delivery in flight when the child died would hang
                // the full deadline before reporting the exit (found by the
                // static-UI acceptance's child-kill step).
                fan.settle_cv.notify_all();
            })
            .map_err(|error| SessionHostError::Spawn(error.to_string()))?;
    }

    // Handshake: session identity, commands, bridge attribution. Every
    // failure path SHUTS THE CHILD DOWN — the session is not in the registry
    // yet, so nobody else would reap it (an orphaned pi child would outlive
    // the host process that spawned it).
    let handshake = || -> Result<(), SessionHostError> {
        let child_state = state
            .get_state()
            .map_err(|error| SessionHostError::Handshake(error.to_string()))?;
        if child_state.get("sessionId").and_then(Value::as_str) != Some(session_file_id) {
            return Err(SessionHostError::Handshake(format!(
                "the child reported session {} instead of the file's {session_file_id}",
                child_state.get("sessionId").map(Value::to_string).unwrap_or_else(|| "?".into())
            )));
        }
        let commands = client
            .command("get_commands", json!({}), Some(Duration::from_secs(60)))
            .map_err(|error| SessionHostError::Handshake(error.to_string()))?;
        let bridge_commands = find_bridge_commands(&commands, &config.bridge_asset);
        if !bridge_commands.iter().any(|name| name == "pi-web:bridge") {
            return Err(SessionHostError::Handshake(
                "the shipped bridge asset did not register pi-web:bridge in the child".to_string(),
            ));
        }
        // The chat policy asset's readiness proof — for the CHAT shape only
        // (the asset rides every config as the shipped path, but only a
        // Chat child loads it): `is_file()` alone just proves a path
        // exists — a wrong, empty or corrupted-but-loadable module would
        // hand the chat its `--tools` loadout with NO before_agent_start /
        // tool_call enforcement (fail-open). The child must have registered
        // pi-web:chat-policy ATTRIBUTED to the expected asset path (the
        // sourceInfo attribution is pi's own, and find_bridge_commands
        // matches it against the shipped path).
        if let (Some(chat_asset), SessionSpawnShape::Chat { .. }) = (&config.chat_asset, &config.shape) {
            let chat_commands = find_bridge_commands(&commands, chat_asset);
            if !chat_commands.iter().any(|name| name == "pi-web:chat-policy") {
                return Err(SessionHostError::Handshake(format!(
                    "the chat policy asset did not register pi-web:chat-policy in the child; \
                     a chat cannot start without its policy (asset: {})",
                    chat_asset.display()
                )));
            }
        }
        Ok(())
    };
    if let Err(error) = handshake() {
        // stdin EOF then grace kill (the orderly path); the fan thread ends
        // with the transport; the bridge's threads end on the child's exit.
        state.shutdown(Duration::from_secs(5));
        return Err(error);
    }

    // The factory's restore step: run the model the session was left on (the
    // file's saved model, else the request's initial pick) unless the child
    // already does. A set_model failure leaves the child on its default —
    // it never fails the session (applyModel's contract).
    if let Some((provider, model_id)) = &config.initial_model {
        let current = state.get_state().ok().and_then(|child| {
            let model = child.get("model")?;
            Some((
                model.get("provider").and_then(Value::as_str).unwrap_or_default().to_string(),
                model.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            ))
        });
        if !state_matches(&current, provider, model_id) {
            let _ = state.command(
                "set_model",
                json!({ "provider": provider, "modelId": model_id }),
                Some(Duration::from_secs(60)),
            );
        }
    }

    // pi reads --system-prompt once at startup; the handshake's answer means
    // the child consumed its arguments, so the private prompt file can go.
    match &config.shape {
        SessionSpawnShape::ChatOnly { prompt_file } | SessionSpawnShape::Chat { prompt_file, .. } => {
            spawn_plan::remove_prompt_file(prompt_file);
        }
        SessionSpawnShape::Project { .. } => {}
    }
    Ok(state)
}

/// Does the child already run the wanted model? (provider AND id.)
fn state_matches(current: &Option<(String, String)>, provider: &str, model_id: &str) -> bool {
    match current {
        Some((child_provider, child_model)) => {
            child_provider == provider && child_model == model_id
        }
        None => false,
    }
}

// --- Tauri IPC dispatch (the closed operation table) ------------------------

/// Dispatch one typed operation (the `pi_ipc` Tauri command routes here).
/// Unknown operations are refused without touching any child.
///
/// `config` (with the agent dir) enables the RESUME flow: an op on a
/// session that is not running starts it from its on-disk file — the
/// `POST /api/agent/[id]` contract (startRpcSession on demand). Without a
/// config the answer is `not_found` (the host has no pi to spawn).
/// The RESUME contract: a session op on an on-disk session the host is not
/// running cold-starts its child (the `POST /api/agent/[id]` contract —
/// `startRpcSession` on demand). The plan callback owns everything the Next
/// factory computed per session kind (classification, persisted tool pin,
/// chat unlock marker, exact prompts, saved model, thinking level): the
/// crate cannot build those itself (prompts come from the management
/// instance), so the host passes the builder in.
pub struct ResumeContext<'a> {
    pub agent_dir: &'a Path,
    pub plan: &'a dyn Fn(&SessionSummary) -> Result<SessionSpawnConfig, String>,
}

pub fn dispatch_session_op(
    registry: &SessionRegistry,
    op: &str,
    args: &Value,
    resume: Option<&ResumeContext<'_>>,
) -> Result<Value, DispatchError> {
    let session_id = args.get("session").and_then(Value::as_str).unwrap_or_default();
    // The resume path: every session op may cold-start an on-disk session.
    let resolve_or_start = |registry: &SessionRegistry,
                            session_id: &str,
                            registry_op: &str|
     -> Result<std::sync::Arc<Session>, DispatchError> {
        if let Some(session) = registry.get(session_id) {
            return Ok(session);
        }
        let Some(resume) = resume else {
            return Err(DispatchError::not_found(session_id));
        };
        let Some(summary) = crate::history::find_session_by_id(resume.agent_dir, session_id) else {
            return Err(DispatchError::not_found(session_id));
        };
        registry
            .start_with_plan(
                session_id,
                &summary.file,
                &summary.id,
                Path::new(&summary.cwd),
                || (resume.plan)(&summary),
            )
            .map_err(|error| DispatchError::Spawn(error, registry_op.to_string()))
    };
    match op {
        // The history index (read-only scan of the agent dir's sessions).
        // The agent dir comes from the CALLER of this library function; the
        // IPC boundary (src-tauri) passes the host-resolved agent dir and
        // never forwards a client-supplied one.
        "sessions.list" => {
            let agent_dir = args
                .get("agentDir")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(default_agent_dir);
            let index = crate::history::scan_sessions(&agent_dir);
            Ok(crate::history::index_json(&index))
        }
        "sessions.runState" => {
            // The /api/agent/running contract: a not-running session answers
            // not-running (never an error, never a cold start).
            let Some(session) = registry.get(session_id) else {
                return Ok(json!({ "running": false }));
            };
            let state = session.get_state().unwrap_or(json!({}));
            let streaming = state.get("isStreaming").and_then(Value::as_bool).unwrap_or(false);
            let compacting = state.get("isCompacting").and_then(Value::as_bool).unwrap_or(false);
            Ok(json!({
                "running": streaming || compacting,
                "isStreaming": streaming,
                "isCompacting": compacting,
                "model": state.get("model").cloned().unwrap_or(Value::Null),
            }))
        }
        "agent.interrupt" => {
            let session = resolve_or_start(registry, session_id, "agent.interrupt")?;
            session
                .command("abort", json!({}), Some(Duration::from_secs(30)))
                .map_err(DispatchError::Transport)
        }
        "agent.setSessionName" => {
            let session = resolve_or_start(registry, session_id, "agent.setSessionName")?;
            let name = args.get("name").and_then(Value::as_str).unwrap_or_default();
            let result = session
                .command("set_session_name", json!({ "name": name }), Some(Duration::from_secs(30)))
                .map_err(DispatchError::Transport)?;
            // No event follows a rename (the child is its file's writer):
            // pull the snapshot now so the projected state is current.
            let _ = session.refresh_state_now();
            Ok(result)
        }
        // The typed agent command surface: a CLOSED command enum forwarded to
        // the session's child. The forwarded payload is rebuilt from the
        // validated fields ONLY (plan: Rust 使用封闭操作枚举) — the IPC
        // envelope's `session` and any unknown field never reach a child.
        "agent.command" => {
            let Some(command_type) = args.get("type").and_then(Value::as_str) else {
                return Err(DispatchError::invalid("the command has no type"));
            };
            // The composer outbox is HOST-owned (the wrapper's editable
            // queue): these three never reach the child.
            match command_type {
                "queue_composer" | "take_composer_message" | "send_composer_message" => {
                    let session = resolve_or_start(registry, session_id, "agent.command")?;
                    return match command_type {
                        "queue_composer" => {
                            let message = args
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            let images = args.get("images").filter(|images| !images.is_null()).cloned();
                            session
                                .composer_enqueue(message, images)
                                .map_err(|message| DispatchError::invalid(&message))
                        }
                        "take_composer_message" => {
                            let id = args.get("id").and_then(Value::as_str).unwrap_or_default();
                            Ok(session.composer_take(id))
                        }
                        "send_composer_message" => {
                            let id = args.get("id").and_then(Value::as_str).unwrap_or_default();
                            session.composer_send_now(id).map_err(|message| DispatchError::invalid(&message))
                        }
                        _ => unreachable!(),
                    };
                }
                _ => {}
            }
            let payload = build_agent_command(command_type, args)?;
            let session = resolve_or_start(registry, session_id, "agent.command")?;
            session
                .command(command_type, payload, Some(Duration::from_secs(120)))
                .map_err(DispatchError::Transport)
        }
        // The tool picker's surface (the wrapper's get_tools): the BRIDGE's
        // authoritative tools.list (the child's real registry — descriptions
        // the loadout hooks rewrote, exposure/source info) plus the active
        // set, projected onto the ToolEntry shape the UI consumes. Hidden
        // tools are withdrawn (pi ignores them when setting the active set).
        "agent.getTools" => {
            let session = resolve_or_start(registry, session_id, "agent.getTools")?;
            let result = session
                .bridge_request("tools.list", None, Some(Duration::from_secs(30)))
                .map_err(DispatchError::Bridge)?;
            let active: Vec<String> = result
                .get("active")
                .and_then(Value::as_array)
                .map(|names| {
                    names
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let tools = result
                .get("tools")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|tool| {
                    // A hidden tool is withdrawn: never listed, never settable.
                    tool.get("exposure").and_then(Value::as_str) != Some("hidden")
                })
                .map(|mut tool| {
                    let name = tool.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                    let is_active = active.iter().any(|active_name| *active_name == name);
                    if let Some(object) = tool.as_object_mut() {
                        object.insert("active".into(), json!(is_active));
                    }
                    tool
                })
                .collect::<Vec<_>>();
            // The wrapper's get_tools answered a plain ToolEntry[] (the UI's
            // sendAgentCommand<ToolEntry[]>), not an envelope.
            Ok(Value::Array(tools))
        }
        // Setting the active tools (the wrapper's setActiveToolSelection):
        // the bridge validates names and applies atomically; the pin travels
        // with tools.apply when the UI wants the selection persisted.
        "agent.setTools" => {
            let names = args
                .get("names")
                .and_then(Value::as_array)
                .map(|names| {
                    names
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<String>>()
                })
                .ok_or_else(|| DispatchError::invalid("setTools requires a names array"))?;
            let session = resolve_or_start(registry, session_id, "agent.setTools")?;
            let _guard = session.try_branch_activity().map_err(DispatchError::invalid)?;
            let result = session
                .bridge_request("tools.set", Some(json!({ "names": names })), Some(Duration::from_secs(30)))
                .map_err(DispatchError::Bridge)?;
            Ok(result)
        }
        // The projected run state (the message-level machine's view).
        "agent.runState" => {
            let session = resolve_or_start(registry, session_id, "agent.runState")?;
            Ok(run_state_json(&session.run_state()))
        }
        // A snapshot of the stream subscription (the Channel bridge in
        // src-tauri layers incremental events on top of this snapshot).
        "agent.eventsSnapshot" => {
            let session = resolve_or_start(registry, session_id, "agent.eventsSnapshot")?;
            Ok(json!({
                "epoch": session.epoch(),
                "settledEpoch": session.machine_settled_epoch(),
                "state": run_state_json(&session.run_state()),
            }))
        }
        _ => Err(DispatchError::unknown_op(op)),
    }
}

/// The default agent dir (the packaged layout resolves this through the
/// desktop's agent-dir contract; tests pass theirs explicitly).
fn default_agent_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".pi/agent")
}

/// Build the exact child payload for one agent command from the IPC args.
/// CLOSED on two axes: the command enum is the REAL pi child surface
/// (lib/pi-rpc/session.ts — commands the wrapper answers host-side, like
/// `fork`, `get_tools` enrichment or `navigate_tree`, are REFUSED here until
/// the Rust host implements their host-side semantics), and each payload is
/// rebuilt from the command's own fields — the envelope's `session`, `type`
/// and every unknown field are dropped, so nothing else ever reaches a
/// child.
pub fn build_agent_command(command_type: &str, args: &Value) -> Result<Value, DispatchError> {
    use serde_json::Map;
    let invalid = |message: &str| DispatchError::invalid(message);
    let str_field = |args: &Value, field: &str| -> Option<String> {
        args.get(field).and_then(Value::as_str).map(str::to_string)
    };
    let bool_field = |args: &Value, field: &str| -> Option<bool> {
        args.get(field).and_then(Value::as_bool)
    };
    // The `images` array shape (prompt/steer/follow_up): each item is
    // {type:"image", data, mimeType}; anything else is refused.
    let images_field = |args: &Value| -> Result<Option<Value>, DispatchError> {
        let Some(images) = args.get("images") else { return Ok(None) };
        if images.is_null() {
            return Ok(None);
        }
        let Value::Array(items) = images else {
            return Err(invalid("images must be an array"));
        };
        if items.is_empty() {
            return Ok(None);
        }
        let mut clean = Vec::with_capacity(items.len());
        for item in items {
            if item.get("type").and_then(Value::as_str) != Some("image") {
                return Err(invalid("images items must be type=image"));
            }
            let data = item.get("data").and_then(Value::as_str);
            let mime = item.get("mimeType").and_then(Value::as_str);
            let (Some(data), Some(mime)) = (data, mime) else {
                return Err(invalid("images items need data and mimeType"));
            };
            clean.push(json!({ "type": "image", "data": data, "mimeType": mime }));
        }
        Ok(Some(Value::Array(clean)))
    };
    let mut payload = Map::new();
    match command_type {
        // No-argument commands.
        "abort" | "abort_bash" | "abort_retry" | "clear_queue" | "get_state"
        | "get_available_thinking_levels" | "get_last_assistant_text" | "get_tree"
        | "get_entries" | "get_commands" | "get_session_stats" => {}
        "prompt" => {
            let Some(message) = str_field(args, "message") else {
                return Err(invalid("prompt requires a string message"));
            };
            payload.insert("message".into(), json!(message));
            if let Some(images) = images_field(args)? {
                payload.insert("images".into(), images);
            }
            // The wrapper's admission channel: steer vs followUp when a run
            // is active (lib/pi-rpc/session.ts prompt()).
            if let Some(behavior) = str_field(args, "streamingBehavior") {
                if behavior == "steer" || behavior == "followUp" {
                    payload.insert("streamingBehavior".into(), json!(behavior));
                }
            }
        }
        "steer" | "follow_up" => {
            let Some(message) = str_field(args, "message") else {
                return Err(invalid(&format!("{command_type} requires a string message")));
            };
            payload.insert("message".into(), json!(message));
            if let Some(images) = images_field(args)? {
                payload.insert("images".into(), images);
            }
        }
        "compact" => {
            // Optional custom instructions (string, possibly empty).
            if let Some(instructions) = str_field(args, "customInstructions") {
                payload.insert("customInstructions".into(), json!(instructions));
            }
        }
        "set_model" => {
            let (Some(provider), Some(model_id)) =
                (str_field(args, "provider"), str_field(args, "modelId"))
            else {
                return Err(invalid("set_model requires string provider and modelId"));
            };
            payload.insert("provider".into(), json!(provider));
            payload.insert("modelId".into(), json!(model_id));
        }
        "set_thinking_level" => {
            let Some(level) = str_field(args, "level") else {
                return Err(invalid("set_thinking_level requires a string level"));
            };
            payload.insert("level".into(), json!(level));
        }
        "set_steering_mode" | "set_follow_up_mode" => {
            let Some(mode) = str_field(args, "mode") else {
                return Err(invalid(&format!("{command_type} requires a string mode")));
            };
            if mode != "all" && mode != "one-at-a-time" {
                return Err(invalid(&format!("{command_type} mode must be all|one-at-a-time")));
            }
            payload.insert("mode".into(), json!(mode));
        }
        "set_session_name" => {
            let Some(name) = str_field(args, "name") else {
                return Err(invalid("set_session_name requires a string name"));
            };
            if name.trim().is_empty() {
                return Err(invalid("Session name cannot be empty"));
            }
            payload.insert("name".into(), json!(name));
        }
        "set_auto_compaction" | "set_auto_retry" => {
            let Some(enabled) = bool_field(args, "enabled") else {
                return Err(invalid(&format!("{command_type} requires a boolean enabled")));
            };
            payload.insert("enabled".into(), json!(enabled));
        }
        // Host-level commands the wrapper answers with file/registry work
        // (fork/fork_branch/clone write session files; get_tools filters and
        // enriches; navigate_tree needs the SDK branch pointer; get_state's
        // queued/context/prompt enrichment is host-side). They stay REFUSED
        // here until the Rust host implements them — a blind forward would
        // either fail opaquely in the child or answer a WRONG shape.
        "fork" | "fork_branch" | "clone" | "get_tools" | "navigate_tree" | "extension_ui_response"
        | "extension_ui_input" => {
            return Err(DispatchError::Unsupported(format!(
                "{command_type} needs host-side semantics the Rust host has not migrated yet"
            )));
        }
        other => {
            return Err(DispatchError::invalid(&format!("unknown agent command {other}")));
        }
    }
    Ok(Value::Object(payload))
}

/// Serialize the projected run state for IPC responses.
fn run_state_json(state: &crate::machine::SessionRunState) -> Value {
    json!({
        "sessionId": state.session_id,
        "sessionName": state.session_name,
        "isStreaming": state.is_streaming,
        "isIdle": state.is_idle,
        "isCompacting": state.is_compacting,
        "autoRetryEnabled": state.auto_retry_enabled,
        "retryAttempt": state.retry_attempt,
        "messageCount": state.message_count,
        "pendingMessageCount": state.pending_message_count,
        "steeringQueue": state.steering_queue,
        "followUpQueue": state.follow_up_queue,
        "model": state.model,
        "thinkingLevel": state.thinking_level,
        "pendingExtensionUiIds": state.pending_ui_request_ids,
        "running": state.is_running(),
    })
}

/// IPC-level dispatch errors (mirrors the protocol doc's codes).
#[derive(Debug)]
pub enum DispatchError {
    UnknownOp(String),
    NotFound(String),
    InvalidArgs(String),
    /// A host-level command whose Rust host semantics are not migrated yet.
    Unsupported(String),
    /// Starting the session child failed.
    Spawn(SessionHostError, String),
    Transport(pi_host::PiRpcError),
    /// A host-level operation the BRIDGE refused (tools.list, tools.set…).
    Bridge(pi_host::bridge::BridgeError),
}

impl DispatchError {
    fn unknown_op(op: &str) -> Self {
        DispatchError::UnknownOp(op.to_string())
    }

    fn not_found(session_id: &str) -> Self {
        DispatchError::NotFound(format!("no running session {session_id}"))
    }

    fn invalid(message: &str) -> Self {
        DispatchError::InvalidArgs(message.to_string())
    }

    /// The protocol error code for this dispatch failure.
    pub fn code(&self) -> &'static str {
        match self {
            DispatchError::UnknownOp(_) => "unknown_op",
            DispatchError::NotFound(_) => "not_found",
            DispatchError::InvalidArgs(_) => "invalid_args",
            DispatchError::Unsupported(_) => "not_supported",
            DispatchError::Spawn(error, _) => match error {
                SessionHostError::Spawn(_) => "agent_spawn_failed",
                SessionHostError::Handshake(_) => "agent_handshake_failed",
            },
            DispatchError::Transport(error) => match error.kind {
                pi_host::ErrorKind::Exit => "agent_child_exited",
                pi_host::ErrorKind::Timeout => "agent_child_timeout",
                pi_host::ErrorKind::Command => "agent_child_error",
                _ => "io",
            },
            DispatchError::Bridge(_) => "bridge_op",
        }
    }
}

impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DispatchError::UnknownOp(op) => write!(f, "unknown operation {op}"),
            DispatchError::NotFound(message) | DispatchError::InvalidArgs(message)
            | DispatchError::Unsupported(message) => write!(f, "{message}"),
            DispatchError::Spawn(error, op) => write!(f, "{op}: {error}"),
            DispatchError::Transport(error) => write!(f, "{error}"),
            DispatchError::Bridge(error) => write!(f, "{error}"),
        }
    }
}

// --- time helpers (header formats) -------------------------------------------

/// SHA-256 as lowercase hex (the chat policy asset's integrity pin).
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `20260131T093000`-style compact stamp for the file name.
fn iso_now_compact() -> String {
    let (year, month, day, hour, minute, second) = utc_now_parts();
    format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}")
}

/// ISO-8601 UTC with milliseconds for the header.
pub(crate) fn iso_now_iso() -> String {
    let (year, month, day, hour, minute, second) = utc_now_parts();
    let millis = sub_second_millis();
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn utc_now_parts() -> (i64, u32, u32, u32, u32, u32) {
    let since_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = since_epoch.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let rest = secs.rem_euclid(86_400) as u32;
    let (year, month, day) = civil_from_days(days);
    (year, month, day, rest / 3600, (rest % 3600) / 60, rest % 60)
}

fn sub_second_millis() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.subsec_millis())
        .unwrap_or(0)
}

/// Howard Hinnant's civil_from_days.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod running_signal_tests {
    use super::*;

    /// A dense replay cursor across wake-only bumps (Terra P2-1): the
    /// catalogue-version `notify()` bumps must not open holes in the
    /// transition sequence a consumer replays from.
    #[test]
    fn wake_only_bumps_do_not_consume_replay_sequence() {
        let signal = RunningSignal::default();
        signal.notify_transition("s1", true);
        let epoch_after_first = signal.epoch();
        signal.notify();
        signal.notify();
        signal.notify_transition("s1", false);
        assert_eq!(signal.last_seq(), 2);
        assert!(signal.epoch() > epoch_after_first, "the bumps moved the epoch");
        // A consumer that saw seq 1 gets exactly the settle — no gap, even
        // though the epoch jumped twice in between.
        let (transitions, gap) = signal.changes_since(1);
        assert!(!gap);
        assert_eq!(
            transitions,
            vec![RunningTransition { seq: 2, session: "s1".into(), running: false }]
        );
    }

    /// The replay unit is the transition pair, so a run that started AND
    /// settled while a consumer was blocked is fully reconstructable.
    #[test]
    fn both_transitions_of_a_short_run_replay_after_the_cursor() {
        let signal = RunningSignal::default();
        signal.notify_transition("s1", true);
        signal.notify_transition("s1", false);
        signal.notify_transition("s2", true);
        assert_eq!(signal.last_seq(), 3);
        let (transitions, gap) = signal.changes_since(0);
        assert!(!gap);
        assert_eq!(transitions.len(), 3);
        assert_eq!(transitions[0], RunningTransition { seq: 1, session: "s1".into(), running: true });
        assert_eq!(transitions[2], RunningTransition { seq: 3, session: "s2".into(), running: true });
        // A fully-caught-up consumer sees nothing new.
        let (caught_up, gap) = signal.changes_since(3);
        assert!(!gap);
        assert!(caught_up.is_empty());
    }

    /// Bounded memory: a burst longer than the ring keeps only the tail and
    /// answers a GAP for every cursor that lost entries — the consumer's
    /// fallback is one full re-derivation, never a partial replay.
    #[test]
    fn a_burst_longer_than_the_ring_answers_a_gap() {
        let signal = RunningSignal::default();
        for n in 0..600 {
            signal.notify_transition(&format!("s{n}"), true);
        }
        // The ring holds the last RUNNING_TRANSITION_RING entries.
        assert_eq!(signal.last_seq(), 600);
        let (transitions, gap) = signal.changes_since(600 - RUNNING_TRANSITION_RING as u64);
        assert!(!gap, "a cursor at the surviving head replays the whole tail");
        assert_eq!(transitions.len(), RUNNING_TRANSITION_RING);
        let (_, gap) = signal.changes_since(0);
        assert!(gap, "a cursor at the start lost the dropped head");
        let (_, gap) = signal.changes_since(600 - RUNNING_TRANSITION_RING as u64 - 1);
        assert!(gap, "a cursor one entry before the surviving head lost that entry");
    }

    /// Nothing recorded: no transitions, no gap, and a baseline cursor of 0.
    #[test]
    fn an_untouched_signal_has_nothing_to_replay() {
        let signal = RunningSignal::default();
        assert_eq!(signal.last_seq(), 0);
        let (transitions, gap) = signal.changes_since(0);
        assert!(!gap);
        assert!(transitions.is_empty());
        assert_eq!(signal.epoch(), 0);
    }
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;

    struct SessionRegistry;
    impl SessionRegistry {
        fn new() -> super::SessionRegistry {
            super::SessionRegistry::with_fence_checker(Arc::new(|_, _| Ok(())))
        }
    }

    #[test]
    fn snapshot_and_multi_writer_gates_refuse_busy_and_pending_without_waiting() {
        let registry = super::SessionRegistry::with_fence_checker(Arc::new(|id, _| {
            if id == "fenced" { Err("unknown".into()) } else { Ok(()) }
        }));
        let lock = registry.start_lock_for("held");
        let _guard = lock.lock().unwrap();
        assert!(matches!(registry.with_session_snapshot_gates(&["held".into()], || Ok::<_, ()>(())), Err(SessionWriterError::Busy(_))));
        assert!(matches!(registry.with_idle_session_writers(&["held".into()], |_| Ok::<_, ()>(())), Err(SessionWriterError::Busy(_))));
        assert!(matches!(registry.with_session_snapshot_gates(&["fenced".into()], || Ok::<_, ()>(())), Err(SessionWriterError::Busy(_))));
        assert!(registry.with_session_snapshot_gates(&["other".into()], || Ok::<_, ()>(())).is_ok());
    }

    #[test]
    fn session_fence_refuses_offline_writers_and_starts() {
        let checker: SessionFenceChecker = Arc::new(|id, _owner| {
            if id == "blocked" { Err("unknown writer outcome".into()) } else { Ok(()) }
        });
        let registry = super::SessionRegistry::with_fence_checker(checker);
        let result = registry.with_offline_session_writer("blocked", Duration::from_millis(1), || Ok::<_, ()>(()));
        assert!(matches!(result, Err(SessionWriterError::Busy(_))));
        let result = registry.start_with_plan("blocked", Path::new("/missing"), "blocked", Path::new("/"), || unreachable!());
        assert!(matches!(result, Err(SessionHostError::Spawn(message)) if message.contains("unknown writer outcome")));
        assert!(registry.with_idle_session_writer("other", |_| Ok::<_, ()>(())).is_ok());
    }

    #[test]
    fn idle_writer_rejects_unknown_queue_and_serializes_stale_start() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("session.jsonl");
        std::fs::write(&file, "fixture").unwrap();
        let registry = SessionRegistry::new();
        let outbox = registry.composer_outbox_for("s");
        let item = outbox.enqueue("pending", None).unwrap();
        outbox.take(&item.id);
        outbox.park_unknown(item.clone());
        let denied = registry.with_idle_session_writer("s", |_| Ok::<_, ()>(()));
        assert!(matches!(denied, Err(SessionWriterError::Busy(_))));
        outbox.take(&item.id);
        let config = SessionSpawnConfig {
            executable: "not-a-real-executable".into(), agent_dir: Some(dir.path().to_path_buf()),
            session_dir: Some(dir.path().to_path_buf()), bridge_asset: dir.path().join("bridge"),
            artifacts_asset: None, chat_asset: None, chat_asset_sha256: None,
            shape: SessionSpawnShape::Project { tool_args: None }, initial_model: None,
            thinking_level: None, extra_args: Vec::new(),
        };
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let writer_registry = &registry;
            let writer_file = &file;
            let writer = scope.spawn(move || writer_registry.with_idle_session_writer("s", |_| {
                held_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                std::fs::remove_file(writer_file).unwrap();
                Ok::<_, ()>(())
            }));
            held_rx.recv().unwrap();
            let start = scope.spawn(|| registry.start("s", &file, "s", dir.path(), &config));
            release_tx.send(()).unwrap();
            writer.join().unwrap().unwrap();
            assert!(start.join().unwrap().err().unwrap().to_string().contains("session file no longer exists"));
        });
    }

    #[test]
    fn idle_writer_admission_never_waits_on_an_in_progress_start() {
        let registry = SessionRegistry::new();
        let locked = registry.start_lock_for("b");
        let held = locked.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let single = registry.with_idle_session_writer("b", |_| Ok::<_, ()>(()));
                let multi = registry.with_idle_session_writers(&["a".into(), "b".into()], |_| Ok::<_, ()>(()));
                tx.send((matches!(single, Err(SessionWriterError::Busy(_))), matches!(multi, Err(SessionWriterError::Busy(_))))).unwrap();
            });
            let answer = rx.recv_timeout(Duration::from_secs(2));
            // Release before joining even on failure, so a regression cannot
            // strand the test thread on the very lock under test.
            drop(held);
            worker.join().unwrap();
            assert_eq!(answer.unwrap(), (true, true));
            assert!(registry.start_lock_for("a").try_lock().is_ok());
        });
    }

    #[test]
    fn ordered_writers_reject_any_session_with_a_pending_queue() {
        let registry = SessionRegistry::new();
        let ids = vec!["b".to_string(), "a".to_string(), "b".to_string()];
        let queued = registry.composer_outbox_for("b").enqueue("pending", None).unwrap();
        assert!(matches!(registry.with_idle_session_writers(&ids, |_| Ok::<_, ()>(())), Err(SessionWriterError::Busy(_))));
        registry.composer_outbox_for("b").take(&queued.id);
        assert_eq!(registry.with_idle_session_writers(&ids, |sessions| Ok::<_, ()>(sessions.len())).unwrap(), 2);
    }

    #[test]
    fn queued_start_derives_policy_after_offline_writer() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("session.jsonl");
        std::fs::write(&file, "old policy").unwrap();
        let registry = SessionRegistry::new();
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let writer_registry = &registry;
            let writer_file = &file;
            let writer = scope.spawn(move || writer_registry.with_offline_session_writer("s", Duration::from_secs(1), || {
                held_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                std::fs::write(writer_file, "new policy").unwrap();
                Ok::<_, ()>(())
            }));
            held_rx.recv().unwrap();
            let start = scope.spawn(|| registry.start_with_plan("s", &file, "s", dir.path(), || {
                assert_eq!(std::fs::read_to_string(&file).unwrap(), "new policy");
                Err("fixture did not spawn".into())
            }));
            release_tx.send(()).unwrap();
            writer.join().unwrap().unwrap();
            assert!(start.join().unwrap().err().unwrap().to_string().contains("fixture did not spawn"));
        });
    }

    #[test]
    fn a_stale_start_cannot_recreate_a_deleted_session_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deleted.jsonl");
        let config = SessionSpawnConfig {
            executable: "not-a-real-executable".into(), agent_dir: Some(dir.path().to_path_buf()),
            session_dir: Some(dir.path().to_path_buf()), bridge_asset: dir.path().join("bridge"),
            artifacts_asset: None, chat_asset: None, chat_asset_sha256: None,
            shape: SessionSpawnShape::Project { tool_args: None }, initial_model: None,
            thinking_level: None, extra_args: Vec::new(),
        };
        let error = SessionRegistry::new().start("deleted", &path, "deleted", dir.path(), &config).err().unwrap();
        assert!(error.to_string().contains("session file no longer exists"));
        assert!(!path.exists());
    }

    #[test]
    fn the_agent_command_enum_is_closed_and_shape_checked() {
        assert_eq!(build_agent_command("get_state", &json!({})).unwrap(), json!({}));
        let prompt = build_agent_command(
            "prompt",
            &json!({ "message": "hi", "images": [{ "type": "image", "data": "abc", "mimeType": "image/png" }] }),
        )
        .unwrap();
        assert_eq!(
            prompt,
            json!({ "message": "hi", "images": [{ "type": "image", "data": "abc", "mimeType": "image/png" }] })
        );
        // The envelope fields never leak into the child payload.
        let cleaned = build_agent_command(
            "prompt",
            &json!({ "session": "s", "type": "prompt", "message": "hi", "evil": "x" }),
        )
        .unwrap();
        assert_eq!(cleaned, json!({ "message": "hi" }));
        assert!(build_agent_command("set_model", &json!({ "provider": "p", "modelId": "m" })).is_ok());
        assert!(build_agent_command("set_auto_compaction", &json!({ "enabled": true })).is_ok());
        assert!(build_agent_command("set_steering_mode", &json!({ "mode": "all" })).is_ok());
        assert!(build_agent_command("compact", &json!({ "customInstructions": "tight" })).is_ok());
        assert!(build_agent_command("compact", &json!({})).is_ok());
        // Unknown commands and bad shapes never reach a child.
        assert!(build_agent_command("shell.exec", &json!({})).is_err());
        assert!(build_agent_command("prompt", &json!({})).is_err(), "message required");
        assert!(build_agent_command("prompt", &json!({ "message": "x", "images": "not-array" })).is_err());
        assert!(build_agent_command("set_model", &json!({ "provider": "p" })).is_err());
        assert!(build_agent_command("set_session_name", &json!({ "name": "  " })).is_err());
        // Host-level commands are refused (not blindly forwarded) until the
        // Rust host implements their semantics.
        for host_level in ["fork", "clone", "get_tools", "navigate_tree", "extension_ui_response"] {
            let error = build_agent_command(host_level, &json!({})).unwrap_err();
            assert_eq!(error.code(), "not_supported", "{host_level}: {error}");
        }
    }
}
