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
    /// The composer outbox (`lib/composer-queue.ts`'s host half): messages
    /// queued while a run was active, delivered once the session is idle.
    /// Arc-shared with the REGISTRY's session-id-keyed store — the queue
    /// must outlive this Session (idle eviction or a remove-then-resume
    /// must not drop queued messages; the Next registry survived wrapper
    /// eviction the same way).
    pub composer_outbox: Arc<composer_outbox::ComposerOutbox>,
    /// One drain at a time (the wrapper's `delivering` flag).
    composer_delivering: Mutex<bool>,
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
    /// detaches; [`Session::unsubscribe`] detaches by id (the IPC layer's
    /// explicit unsubscribe). Returns (subscriber id, receiver).
    pub fn subscribe(&self) -> (u64, std::sync::mpsc::Receiver<Value>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut state = self.state.lock().unwrap();
        let id = self.next_subscriber_id();
        state.subscribers.push((id, tx));
        (id, rx)
    }

    /// Detach the subscriber with this id (its relay thread's recv then
    /// fails and the thread exits). Unknown ids are ignored.
    pub fn unsubscribe(&self, subscriber_id: u64) {
        let mut state = self.state.lock().unwrap();
        state.subscribers.retain(|(id, _)| *id != subscriber_id);
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

/// The registry: one child per active session id, shared concurrent starts.
pub struct SessionRegistry {
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
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            start_locks: Mutex::new(HashMap::new()),
            composer_outboxes: Mutex::new(HashMap::new()),
        }
    }

    /// The session-id-keyed composer outbox (created on first use, kept
    /// across Session lifetimes — the queue outlives the child).
    pub fn composer_outbox_for(&self, id: &str) -> Arc<composer_outbox::ComposerOutbox> {
        let mut outboxes = self.composer_outboxes.lock().unwrap();
        Arc::clone(outboxes.entry(id.to_string()).or_insert_with(|| Arc::new(composer_outbox::ComposerOutbox::new())))
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
        // The composer outbox comes from the session-id store: a resumed
        // session inherits the queue an evicted child left behind.
        let composer_outbox = self.composer_outbox_for(id);
        let session = spawn_session(id, session_file, session_file_id, cwd, config, composer_outbox)?;
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
    composer_outbox: Arc<composer_outbox::ComposerOutbox>,
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

    let client = PiRpcClient::spawn(
        &config.executable,
        SpawnOptions { args, cwd: Some(cwd.to_path_buf()), env, ..SpawnOptions::default() },
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
        composer_outbox,
        composer_delivering: Mutex::new(false),
        settle_cv: std::sync::Condvar::new(),
    });
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
        let config = (resume.plan)(&summary)
            .map_err(|message| DispatchError::Spawn(SessionHostError::Spawn(message), registry_op.to_string()))?;
        registry
            .start(
                session_id,
                &summary.file,
                &summary.id,
                Path::new(&summary.cwd),
                &config,
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
mod dispatch_tests {
    use super::*;

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
