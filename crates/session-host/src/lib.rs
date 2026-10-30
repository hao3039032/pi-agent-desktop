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

pub mod machine;
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
pub struct Session {
    /// The registry key (the URL-facing session id).
    pub id: String,
    /// The session file's own header id (the child's sessionId).
    pub session_file_id: String,
    pub session_file: PathBuf,
    pub cwd: PathBuf,
    pub(crate) client: Arc<PiRpcClient>,
    pub(crate) bridge: Arc<Bridge>,
    state: Mutex<SessionState>,
    /// Epoch for event subscribers (bumped if the session is ever reset).
    epoch: AtomicU64,
    /// The message-level state machine (fed before fan-out).
    machine: Mutex<crate::machine::SessionMachine>,
    /// Notified when a run settles (prompt waits) or the child exits.
    settle_cv: std::sync::Condvar,
}

struct SessionState {
    lease_until: Instant,
    started_at: Instant,
    last_active: Instant,
    subscribers: Vec<(u64, std::sync::mpsc::Sender<Value>)>,
}

impl Session {
    /// Send one RPC command to the child.
    pub fn command(
        &self,
        command: &str,
        data: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, pi_host::PiRpcError> {
        let result = self.client.command(command, data, timeout);
        self.touch();
        result
    }

    /// One bridge request (nonce/session-verified by pi-host).
    pub fn bridge_request(
        &self,
        op: &str,
        args: Option<Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, pi_host::bridge::BridgeError> {
        self.bridge.request(op, args, timeout)
    }

    /// The current get_state snapshot from the child.
    pub fn get_state(&self) -> Result<Value, pi_host::PiRpcError> {
        self.command("get_state", json!({}), Some(Duration::from_secs(30)))
    }

    /// Subscribe to the child's session events. Dropping the receiver
    /// detaches. Returns (receiver, detach guard... none needed: dropping
    /// the Receiver detaches on next send).
    pub fn subscribe(&self) -> std::sync::mpsc::Receiver<Value> {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut state = self.state.lock().unwrap();
        state.subscribers.push((self.next_subscriber_id(), tx));
        rx
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

    fn fan_out(self: &Arc<Self>, record: Value) {
        // 1. The state machine eats first (it may request follow-ups).
        let follow_up = {
            let mut machine = self.machine.lock().unwrap();
            let follow_up = machine.apply_event(&record);
            if matches!(follow_up, crate::machine::FollowUp::RefreshAfterSettle { .. }) {
                self.settle_cv.notify_all();
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
        self.machine.lock().unwrap().apply_state_snapshot(&snapshot, captured_epoch);
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
        self.machine.lock().unwrap().state.clone()
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

    /// Orderly shutdown: stdin EOF then grace kill (pi-host close).
    pub fn shutdown(&self, grace: Duration) -> Option<i32> {
        self.client.close(grace)
    }

    /// Test seam: shorten the lease to force the idle path deterministically.
    pub fn state_for_tests_set_lease(&self, remaining: Duration) {
        self.state.lock().unwrap().lease_until = Instant::now() + remaining;
    }

    /// Test seam: whether the child process exited.
    pub fn client_has_exited_for_tests(&self) -> bool {
        self.client.has_exited()
    }
}

static SUBSCRIBER_COUNTER: AtomicU64 = AtomicU64::new(0);

/// How to spawn session children.
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
    /// Extra args after the standard set.
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

/// The registry: one child per active session id, shared concurrent starts.
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// One in-flight spawn per id (rpc-manager's `__piStartLocks`): the
    /// first caller spawns, the rest wait on the mutex and read the result
    /// from the session map — a failed spawn is retried by the next caller,
    /// never cached as a poison state.
    start_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()), start_locks: Mutex::new(HashMap::new()) }
    }

    fn start_lock_for(&self, id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.start_locks.lock().unwrap();
        Arc::clone(locks.entry(id.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))))
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
        if let Some(existing) = self.get(id) {
            if !existing.is_idle_expired() {
                return Ok(existing);
            }
        }
        let lock = self.start_lock_for(id);
        let _guard = lock.lock().unwrap();
        // Won the lock: re-check (another caller may have finished spawning).
        if let Some(existing) = self.get(id) {
            if !existing.is_idle_expired() {
                return Ok(existing);
            }
        }
        let session = spawn_session(id, session_file, session_file_id, cwd, config)?;
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

    /// Detach and shut a session down; returns its exit code.
    pub fn remove(&self, id: &str, grace: Duration) -> Option<Option<i32>> {
        let session = self.sessions.lock().unwrap().remove(id)?;
        Some(session.shutdown(grace))
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
) -> Result<Arc<Session>, SessionHostError> {
    let nonce = uuid::Uuid::new_v4().to_string();
    let session_dir = config
        .session_dir
        .clone()
        .unwrap_or_else(|| session_file.parent().map(Path::to_path_buf).unwrap_or_default());
    let mut args: Vec<String> = vec![
        "--session".into(),
        session_file.to_string_lossy().into_owned(),
        "--session-dir".into(),
        session_dir.to_string_lossy().into_owned(),
        // Discovery stays off: only the explicit bridge asset loads.
        "--no-extensions".into(),
        "--no-skills".into(),
        "--no-prompt-templates".into(),
        "--no-themes".into(),
        "--no-context-files".into(),
        "--extension".into(),
        config.bridge_asset.to_string_lossy().into_owned(),
    ];
    args.extend(config.extra_args.iter().cloned());
    let mut env = EnvPolicy::inherit().set("PI_WEB_BRIDGE_NONCE", nonce.clone());
    if let Some(agent_dir) = &config.agent_dir {
        env = env.set("PI_CODING_AGENT_DIR", agent_dir.to_string_lossy().into_owned());
    }

    let client = PiRpcClient::spawn(
        &config.executable,
        SpawnOptions { args, cwd: Some(cwd.to_path_buf()), env, ..SpawnOptions::default() },
    )
    .map_err(|error| SessionHostError::Spawn(error.to_string()))?;

    // Event fan-out thread: child records → subscribers.
    let (events, _subscription) = client.on_event();
    let state = Arc::new(Session {
        id: id.to_string(),
        session_file_id: session_file_id.to_string(),
        session_file: session_file.to_path_buf(),
        cwd: cwd.to_path_buf(),
        client: Arc::clone(&client),
        bridge: Bridge::attach(Arc::clone(&client), session_file_id.to_string(), nonce),
        state: Mutex::new(SessionState {
            lease_until: Instant::now() + IDLE_TIMEOUT,
            started_at: Instant::now(),
            last_active: Instant::now(),
            subscribers: Vec::new(),
        }),
        epoch: AtomicU64::new(1),
        machine: Mutex::new(crate::machine::SessionMachine::new(session_file_id)),
        settle_cv: std::sync::Condvar::new(),
    });
    {
        let fan = Arc::clone(&state);
        std::thread::Builder::new()
            .name(format!("session-events-{id}"))
            .spawn(move || {
                while let Ok(record) = events.recv() {
                    fan.fan_out(record);
                }
            })
            .map_err(|error| SessionHostError::Spawn(error.to_string()))?;
    }

    // Handshake: session identity, commands, bridge attribution.
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
    Ok(state)
}

// --- Tauri IPC dispatch (the closed operation table) ------------------------

/// Dispatch one typed operation (the `pi_ipc` Tauri command routes here).
/// Unknown operations are refused without touching any child.
pub fn dispatch_session_op(
    registry: &SessionRegistry,
    op: &str,
    args: &Value,
) -> Result<Value, DispatchError> {
    let session_id = args.get("session").and_then(Value::as_str).unwrap_or_default();
    match op {
        "sessions.runState" => {
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
            let session = registry.get(session_id).ok_or(DispatchError::not_found(session_id))?;
            session
                .command("abort", json!({}), Some(Duration::from_secs(30)))
                .map_err(DispatchError::Transport)
        }
        "agent.setSessionName" => {
            let session = registry.get(session_id).ok_or(DispatchError::not_found(session_id))?;
            let name = args.get("name").and_then(Value::as_str).unwrap_or_default();
            let result = session
                .command("set_session_name", json!({ "name": name }), Some(Duration::from_secs(30)))
                .map_err(DispatchError::Transport)?;
            // No event follows a rename (the child is its file's writer):
            // pull the snapshot now so the projected state is current.
            let _ = session.refresh_state_now();
            Ok(result)
        }
        // The projected run state (the message-level machine's view).
        "agent.runState" => {
            let session = registry.get(session_id).ok_or(DispatchError::not_found(session_id))?;
            Ok(run_state_json(&session.run_state()))
        }
        // A snapshot of the stream subscription (the Channel bridge in
        // src-tauri layers incremental events on top of this snapshot).
        "agent.eventsSnapshot" => {
            let session = registry.get(session_id).ok_or(DispatchError::not_found(session_id))?;
            Ok(json!({
                "epoch": session.epoch(),
                "settledEpoch": session.machine_settled_epoch(),
                "state": run_state_json(&session.run_state()),
            }))
        }
        _ => Err(DispatchError::unknown_op(op)),
    }
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
        "running": state.is_running(),
    })
}

/// IPC-level dispatch errors (mirrors the protocol doc's codes).
#[derive(Debug)]
pub enum DispatchError {
    UnknownOp(String),
    NotFound(String),
    Transport(pi_host::PiRpcError),
}

impl DispatchError {
    fn unknown_op(op: &str) -> Self {
        DispatchError::UnknownOp(op.to_string())
    }

    fn not_found(session_id: &str) -> Self {
        DispatchError::NotFound(format!("no running session {session_id}"))
    }

    /// The protocol error code for this dispatch failure.
    pub fn code(&self) -> &'static str {
        match self {
            DispatchError::UnknownOp(_) => "unknown_op",
            DispatchError::NotFound(_) => "not_found",
            DispatchError::Transport(_) => "io",
        }
    }
}

impl std::fmt::Display for DispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DispatchError::UnknownOp(op) => write!(f, "unknown operation {op}"),
            DispatchError::NotFound(message) => write!(f, "{message}"),
            DispatchError::Transport(error) => write!(f, "{error}"),
        }
    }
}

// --- time helpers (header formats) -------------------------------------------

/// `20260131T093000`-style compact stamp for the file name.
fn iso_now_compact() -> String {
    let (year, month, day, hour, minute, second) = utc_now_parts();
    format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}")
}

/// ISO-8601 UTC with milliseconds for the header.
fn iso_now_iso() -> String {
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
