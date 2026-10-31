//! # management-host — on-demand management instances (M3 backbone)
//!
//! The plan's management service: restricted pi children (`--mode rpc
//! --no-session`, discovery off, explicit extensions only) that own the
//! SDK-dependent operations (config edits, enabledModels, credentials, MCP
//! management, plugins/skills, cron) with their fixed-version dependency
//! tree. This crate is the Rust host half:
//!
//! - [`ManagementHost::instance`]: get (or lazily start) the management
//!   child for a scope — `"global"` or a trusted project cwd; scopes never
//!   share a child (different resource scopes);
//! - leases hold a busy instance alive (login, install, MCP test); idle
//!   instances recycle after [`IDLE_RECYCLE`] (60 s);
//! - [`ManagementInstance::available_models`]: provider/model enumeration
//!   through the standard RPC (extension-registered providers included —
//!   the M0-verified path);
//! - [`ManagementInstance::extension_prompt`]: invoke a registered
//!   management-extension command (consumed by the extension runtime, no
//!   run starts, the tokens never become model input);
//! - a management child is spawned `--no-session`: it must never create
//!   user session files.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pi_host::client::PiRpcClient;
use pi_host::{EnvPolicy, SpawnOptions};
use serde_json::{json, Value};

/// Idle management instances recycle after this long without a lease
/// (plan §五 管理实例: 空闲 60 秒回收).
pub const IDLE_RECYCLE: Duration = Duration::from_secs(60);

/// How to spawn management children.
#[derive(Clone)]
pub struct ManagementSpawnConfig {
    /// Absolute pi executable.
    pub executable: String,
    /// Overrides ~/.pi/agent for settings (tests pass a sandbox).
    pub agent_dir: Option<PathBuf>,
    /// The explicit management extensions to load (vendored module trees;
    /// discovery stays off, so these are the ONLY extensions).
    pub extensions: Vec<PathBuf>,
    /// Extra environment for the child (credential env references etc.).
    pub env: Vec<(String, String)>,
}

/// One running management child.
#[derive(Clone)]
pub struct ManagementInstance {
    pub scope: String,
    client: Arc<PiRpcClient>,
    state: Arc<Mutex<InstanceState>>,
    /// The management protocol nonce this child was spawned with. The HOST
    /// generates it at spawn (never accepted from the caller): a caller-
    /// supplied nonce — or worse, an empty one — would let a forged envelope
    /// from anywhere in the child bind to the management protocol.
    nonce: String,
    pending: Arc<Mutex<HashMap<String, PendingTask>>>,
    _notify_subscription: Arc<pi_host::client::UiSubscription>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskKind { ReadOnly, Mutation }

/// Host-internal snapshot. Operations must return frontend-safe results and
/// progress: this generic transport cannot infer which arbitrary values are secrets.
#[derive(Clone, Debug)]
pub struct TaskSnapshot {
    pub status: TaskStatus,
    pub progress: Option<Value>,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub cancel_requested: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskStatus { Running, Unknown, Succeeded, Failed, Cancelled }

struct TaskRecord {
    snapshot: TaskSnapshot,
    finished_at: Option<Instant>,
}

struct PendingTask {
    tx: std::sync::mpsc::Sender<Value>,
    task: Arc<Mutex<TaskRecord>>,
    nonce: String,
}

struct InstanceState {
    lease_until: Instant,
    last_used: Instant,
    active: usize,
    closing: bool,
    tasks: HashMap<String, Arc<Mutex<TaskRecord>>>,
}

struct Activity(Arc<Mutex<InstanceState>>);

impl Drop for Activity {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap();
        state.active -= 1;
        state.last_used = Instant::now();
        state.lease_until = state.last_used + IDLE_RECYCLE;
    }
}

impl ManagementInstance {
    /// Call one management op through the extension protocol and wait for
    /// its nonce-bound envelope (the synchronous bridge the scheduler and
    /// config ops use; UI progress flows get the async variant later).
    pub fn management_call_sync(&self, op: &str, args: Value) -> Result<Value, String> {
        self.management_call(op, args, Duration::from_secs(60))
    }

    /// The general form: send `/pi-web:mgmt <rid> <b64url>` and await the
    /// PI_WEB_MGMT_V1 envelope with matching rid and the spawning nonce.
    pub fn management_call(&self, op: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        let handle = self.start_task(op, args, Duration::from_secs(600), TaskKind::Mutation)?;
        let until = Instant::now() + timeout;
        loop {
            let snapshot = self.task_snapshot(&handle)?;
            match snapshot.status {
                TaskStatus::Succeeded => return Ok(snapshot.result.unwrap_or(Value::Null)),
                TaskStatus::Failed | TaskStatus::Cancelled => return Err(snapshot.error.unwrap_or_else(|| "management operation failed".into())),
                TaskStatus::Unknown => return Err(snapshot.error.unwrap_or_else(|| "management op outcome unknown".into())),
                TaskStatus::Running => {}
            }
            if Instant::now() >= until {
                if let Some(task) = self.state.lock().unwrap().tasks.get(&handle) {
                    let mut task = task.lock().unwrap();
                    if task.snapshot.status == TaskStatus::Running { task.snapshot.status = TaskStatus::Unknown; }
                }
                return Err(format!("management op timed out; outcome unknown (task {handle})"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn management_call_wait(&self, op: &str, args: Value, request_id: &str, task: Arc<Mutex<TaskRecord>>) -> Result<Value, String> {
        use std::sync::mpsc;
        let nonce = self.nonce.clone();
        let payload = json!({ "op": op, "args": args, "nonce": nonce });
        let token = base64_url_no_pad(&payload.to_string());

        let (envelope_tx, envelope_rx) = mpsc::channel::<Value>();
        self.pending.lock().unwrap().insert(request_id.to_string(), PendingTask { tx: envelope_tx, task: Arc::clone(&task), nonce: nonce.clone() });

        let result = (|| -> Result<Value, String> {
            let ack = self
                .client
                .command("prompt", json!({ "message": format!("/pi-web:mgmt {request_id} {token}") }), None)
                .map_err(|error| format!("management prompt failed: {error}"))?;
            if ack.get("disposition").and_then(Value::as_str) != Some("handled") {
                return Err("the management command was not handled (extension missing?)".to_string());
            }
            if task.lock().unwrap().snapshot.cancel_requested { let _ = self.send_cancel(request_id); }
            loop {
              match envelope_rx.recv_timeout(Duration::from_millis(250)) {
                Ok(envelope) => {
                    if envelope.get("nonce").and_then(Value::as_str) != Some(nonce.as_str()) {
                        return Err("the management envelope carried the wrong nonce".to_string());
                    }
                    if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
                        return Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        let code = envelope.get("code").and_then(Value::as_str).unwrap_or("op_failed");
                        let error = envelope.get("error").and_then(Value::as_str).unwrap_or("unknown error");
                        return Err(format!("[{code}] {error}"))
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) if !self.client.has_exited() => continue,
                Err(_) => return Err(format!("management op {op} outcome unknown: child exited")),
              }
            }
        })();
        self.pending.lock().unwrap().remove(request_id);
        self.touch();
        result
    }

    /// Start a task. `kind` and `deadline` are trusted host policy, never frontend input.
    /// Operations must redact secrets before reporting a result or progress.
    pub fn start_task(&self, op: &str, args: Value, deadline: Duration, kind: TaskKind) -> Result<String, String> {
        if deadline.is_zero() || deadline > Duration::from_secs(600) { return Err("invalid management task deadline".into()); }
        if kind == TaskKind::ReadOnly && !matches!(op,
            "sys.capabilities" | "cron.preview" | "cron.previousRuns" | "cron.countSlots" |
            "session.readHeader" | "session.readEntries" | "session.readContext" | "session.readView" |
            "session.projectSnapshot" | "chat.systemPrompt" | "session.chatOnlyPrompt" |
            "models.list" | "models.enabledGet" | "modelsConfig.get" | "skills.search" | "skills.list" | "plugins.list") {
            return Err("operation is not approved as read-only".into());
        }
        let handle = format!("task-{}", uuid::Uuid::new_v4());
        let task = Arc::new(Mutex::new(TaskRecord { snapshot: TaskSnapshot {
            status: TaskStatus::Running, progress: None, result: None, error: None, cancel_requested: false,
        }, finished_at: None }));
        let activity = {
            let mut state = self.state.lock().unwrap();
            state.tasks.retain(|_, task| task.lock().unwrap().finished_at.map_or(true, |at| at.elapsed() < Duration::from_secs(600)));
            if state.closing || self.client.has_exited() { return Err("management instance is closing".into()); }
            if state.tasks.len() >= 128 { return Err("management task capacity reached".into()); }
            if kind == TaskKind::Mutation && state.tasks.values().any(|task| task.lock().unwrap().snapshot.status == TaskStatus::Unknown) {
                return Err("management scope has an unknown outcome".into());
            }
            state.active += 1;
            state.tasks.insert(handle.clone(), Arc::clone(&task));
            Activity(Arc::clone(&self.state))
        };
        let instance = self.clone();
        let id = handle.clone();
        let operation = op.to_string();
        let worker_task = Arc::clone(&task);
        if let Err(error) = std::thread::Builder::new().name("mgmt-task".into()).spawn(move || {
            let result = instance.management_call_wait(&operation, args, &id, Arc::clone(&worker_task));
            let mut record = worker_task.lock().unwrap();
            match result {
                Ok(value) => { record.snapshot.status = TaskStatus::Succeeded; record.snapshot.result = Some(value); record.finished_at = Some(Instant::now()); }
                Err(error) if error.starts_with('[') => {
                    record.snapshot.status = if error.starts_with("[cancelled]") { TaskStatus::Cancelled } else { TaskStatus::Failed };
                    record.snapshot.error = Some(error); record.finished_at = Some(Instant::now());
                }
                Err(error) => { record.snapshot.status = TaskStatus::Unknown; record.snapshot.error = Some(error); }
            }
            drop(record);
            drop(activity);
        }) {
            self.state.lock().unwrap().tasks.remove(&handle);
            return Err(format!("management task failed to start: {error}"));
        }
        let instance = self.clone();
        let id = handle.clone();
        let deadline_task = Arc::clone(&task);
        if std::thread::Builder::new().name("mgmt-deadline".into()).spawn(move || {
            let task = deadline_task;
            let until = Instant::now() + deadline;
            loop {
                if task.lock().unwrap().finished_at.is_some() { return; }
                let Some(left) = until.checked_duration_since(Instant::now()) else { break };
                std::thread::sleep(left.min(Duration::from_millis(100)));
            }
            let should_cancel = {
                let mut record = task.lock().unwrap();
                if record.finished_at.is_some() { false } else { record.snapshot.status = TaskStatus::Unknown; true }
            };
            if should_cancel { let _ = instance.cancel_task(&id); }
        }).is_err() {
            let mut record = task.lock().unwrap();
            if record.finished_at.is_none() {
                record.snapshot.status = TaskStatus::Unknown;
                record.snapshot.error = Some("management deadline monitor failed".into());
            }
            drop(record);
            let _ = self.cancel_task(&handle);
        }
        Ok(handle)
    }

    pub fn task_snapshot(&self, handle: &str) -> Result<TaskSnapshot, String> {
        let state = self.state.lock().unwrap();
        let task = state.tasks.get(handle).ok_or("management task not found")?;
        let snapshot = task.lock().unwrap().snapshot.clone();
        Ok(snapshot)
    }

    pub fn cancel_task(&self, handle: &str) -> Result<(), String> {
        {
            let state = self.state.lock().unwrap();
            let task = state.tasks.get(handle).ok_or("management task not found")?;
            let mut task = task.lock().unwrap();
            if task.finished_at.is_some() { return Err("management task is terminal".into()); }
            if task.snapshot.cancel_requested { return Ok(()); }
            task.snapshot.cancel_requested = true;
        }
        self.send_cancel(handle)
    }

    fn send_cancel(&self, handle: &str) -> Result<(), String> {
        let client = Arc::clone(&self.client);
        let token = base64_url_no_pad(&json!({"op": "__cancel", "args": {"rid": handle}, "nonce": self.nonce}).to_string());
        let request_id = format!("cancel-{}", uuid::Uuid::new_v4());
        std::thread::Builder::new().name("mgmt-cancel".into()).spawn(move || {
            let _ = client.command("prompt", json!({"message": format!("/pi-web:mgmt {request_id} {token}")}), Some(Duration::from_secs(10)));
        }).map(|_| ()).map_err(|error| format!("management cancel request could not start: {error}"))
    }

    fn admit(&self) -> Result<Activity, String> {
        let mut state = self.state.lock().unwrap();
        if state.closing || self.client.has_exited() {
            return Err("management instance is closing".into());
        }
        if state.active >= 128 {
            return Err("management instance has too many active operations".into());
        }
        state.active += 1;
        Ok(Activity(Arc::clone(&self.state)))
    }

    fn retire_if_expired(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        state.tasks.retain(|_, task| task.lock().unwrap().finished_at.map_or(true, |at| at.elapsed() < Duration::from_secs(600)));
        if state.tasks.is_empty() && (self.client.has_exited() || (!state.closing && state.active == 0 && state.lease_until <= Instant::now())) {
            state.closing = true;
            true
        } else {
            false
        }
    }

    /// Take the lease (a login/install/test is running).
    pub fn lease(&self) {
        let mut state = self.state.lock().unwrap();
        state.lease_until = Instant::now() + IDLE_RECYCLE;
    }

    /// Whether this instance should be recycled now.
    pub fn is_expired(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.tasks.is_empty() && (self.client.has_exited() || state.closing || (state.active == 0 && state.lease_until <= Instant::now()))
    }

    /// Provider/model enumeration: the child's own registry, which includes
    /// extension-registered providers (M0-verified semantics).
    pub fn available_models(
        &self,
    ) -> Result<Value, pi_host::PiRpcError> {
        let _activity = self.admit().map_err(|error| pi_host::PiRpcError::new(pi_host::ErrorKind::Closing, error))?;
        let result = self.client.command(
            "get_available_models",
            json!({}),
            Some(Duration::from_secs(60)),
        )?;
        self.touch();
        Ok(result)
    }

    /// Invoke one management-extension command by prompt (the extension
    /// runtime consumes it; no run starts). Returns the disposition.
    pub fn extension_prompt(
        &self,
        message: &str,
        timeout: Duration,
    ) -> Result<Value, pi_host::PiRpcError> {
        let _activity = self.admit().map_err(|error| pi_host::PiRpcError::new(pi_host::ErrorKind::Closing, error))?;
        let result = self.client.command("prompt", json!({ "message": message }), Some(timeout))?;
        self.touch();
        Ok(result)
    }

    /// Orderly shutdown.
    pub fn shutdown(&self, grace: Duration) -> Option<i32> {
        {
            let mut state = self.state.lock().unwrap();
            state.closing = true;
            for task in state.tasks.values() {
                let mut task = task.lock().unwrap();
                if task.finished_at.is_none() { task.snapshot.status = TaskStatus::Unknown; }
            }
        }
        self.client.close(grace)
    }

    fn touch(&self) {
        let mut state = self.state.lock().unwrap();
        state.last_used = Instant::now();
        state.lease_until = Instant::now() + IDLE_RECYCLE;
    }

    /// The child's pid (diagnostics).
    pub fn client_pid(&self) -> u32 {
        self.client.pid()
    }

    /// Whether the child exited.
    pub fn client_has_exited(&self) -> bool {
        self.client.has_exited()
    }
}

/// The registry of management instances, partitioned by scope.
pub struct ManagementHost {
    instances: Mutex<HashMap<String, Arc<ManagementInstance>>>,
    /// One in-flight spawn per scope (the session registry's pattern):
    /// without it, two concurrent `instance()` calls for one scope both
    /// spawn a child and one becomes an orphan that is never recycled.
    start_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    shutting_down: std::sync::atomic::AtomicBool,
}

impl Default for ManagementHost {
    fn default() -> Self {
        Self::new()
    }
}

impl ManagementHost {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            start_locks: Mutex::new(HashMap::new()),
            shutting_down: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// The instance for a scope (`"global"` or a project cwd), started on
    /// demand. Concurrent calls for the same scope share ONE spawn.
    pub fn instance(
        &self,
        scope: &str,
        config: &ManagementSpawnConfig,
    ) -> Result<Arc<ManagementInstance>, String> {
        let scope = canonical_scope(scope);
        if self.shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("management host is shutting down".into());
        }
        if let Some(existing) = self.live_instance(&scope) {
            return Ok(existing);
        }
        let lock = {
            let mut locks = self.start_locks.lock().unwrap();
            Arc::clone(locks.entry(scope.clone()).or_insert_with(|| Arc::new(Mutex::new(()))))
        };
        let _guard = lock.lock().unwrap();
        // Won the lock: another caller may have finished spawning meanwhile.
        if let Some(existing) = self.live_instance(&scope) {
            return Ok(existing);
        }
        let instance = spawn_management(&scope, config)?;
        let mut instances = self.instances.lock().unwrap();
        if self.shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
            drop(instances);
            instance.shutdown(Duration::from_secs(5));
            return Err("management host is shutting down".into());
        }
        if let Some(old) = instances.insert(scope.clone(), Arc::clone(&instance)) {
            drop(instances);
            old.shutdown(Duration::from_secs(5));
        }
        Ok(instance)
    }

    fn live_instance(&self, scope: &str) -> Option<Arc<ManagementInstance>> {
        let mut instances = self.instances.lock().unwrap();
        if self.shutting_down.load(std::sync::atomic::Ordering::SeqCst) { return None; }
        if let Some(instance) = instances.get(scope) {
            if !instance.retire_if_expired() { return Some(Arc::clone(instance)); }
        }
        if let Some(old) = instances.remove(scope) {
            drop(instances);
            old.shutdown(Duration::from_secs(5));
        }
        None
    }

    /// Recycle expired instances; returns the recycled scopes.
    pub fn recycle_expired(&self) -> Vec<String> {
        let removed = {
            let mut instances = self.instances.lock().unwrap();
            let scopes: Vec<_> = instances.iter().filter(|(_, instance)| instance.retire_if_expired())
                .map(|(scope, _)| scope.clone()).collect();
            scopes.into_iter().filter_map(|scope| instances.remove(&scope).map(|instance| (scope, instance))).collect::<Vec<_>>()
        };
        for (_, instance) in &removed { instance.shutdown(Duration::from_secs(5)); }
        removed.into_iter().map(|(scope, _)| scope).collect()
    }

    /// Live scopes (diagnostics/tests).
    pub fn scopes(&self) -> Vec<String> {
        self.instances
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, instance)| !instance.client_has_exited())
            .map(|(scope, _)| scope.clone())
            .collect()
    }

    /// Shut every live instance down (stdin EOF then a grace kill) and drop
    /// the registry entries. Host shutdown path (the acceptance harness's
    /// graceful stop): without it an idle instance outlives the decision to
    /// exit only until its 60 s recycle timer — and nothing recycles when the
    /// process is about to die.
    pub fn shutdown_all(&self, grace: Duration) {
        let instances: Vec<Arc<ManagementInstance>> = {
            let mut instances = self.instances.lock().unwrap();
            self.shutting_down.store(true, std::sync::atomic::Ordering::SeqCst);
            for instance in instances.values() {
                let mut state = instance.state.lock().unwrap();
                state.closing = true;
                for task in state.tasks.values() {
                    let mut task = task.lock().unwrap();
                    if task.finished_at.is_none() { task.snapshot.status = TaskStatus::Unknown; }
                }
            }
            instances.drain().map(|(_, value)| value).collect()
        };
        for instance in instances {
            instance.shutdown(grace);
        }
    }
}

fn route_envelope(
    pending: &Mutex<HashMap<String, PendingTask>>,
    record: &Value,
) {
    let Some(message) = record.get("message").and_then(Value::as_str) else { return };
    let (progress, body) = if let Some(body) = message.strip_prefix("PI_WEB_MGMT_PROGRESS_V1 ") {
        (true, body)
    } else if let Some(body) = message.strip_prefix("PI_WEB_MGMT_V1 ") {
        (false, body)
    } else { return };
    if progress && body.len() > 4096 { return; }
    let Ok(envelope) = serde_json::from_str::<Value>(body) else { return };
    let Some(rid) = envelope.get("rid").and_then(Value::as_str) else { return };
    let mut pending = pending.lock().unwrap();
    if progress {
        if let Some(entry) = pending.get(rid) {
            if envelope.get("nonce").and_then(Value::as_str) == Some(entry.nonce.as_str()) {
                entry.task.lock().unwrap().snapshot.progress = envelope.get("progress").cloned();
            }
        }
    } else if let Some(entry) = pending.remove(rid) {
        let _ = entry.tx.send(envelope.clone());
    }
}

/// base64url without padding (RFC 4648 §5).
fn base64_url_no_pad(data: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let bytes = data.as_bytes();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], chunk.get(1).copied().unwrap_or(0), chunk.get(2).copied().unwrap_or(0)];
        out.push(ALPHABET[(b[0] >> 2) as usize] as char);
        out.push(ALPHABET[(((b[0] & 0x03) << 4) | (b[1] >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(((b[1] & 0x0f) << 2) | (b[2] >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(b[2] & 0x3f) as usize] as char);
        }
    }
    out
}

/// Normalize a scope key: `global` stays; a project cwd is canonicalized
/// (symlinks resolved) so `/a/b`, `/a/b/` and a symlinked spelling of the
/// same project share ONE child.
fn canonical_scope(scope: &str) -> String {
    if scope == "global" {
        return scope.to_string();
    }
    match std::fs::canonicalize(std::path::Path::new(scope)) {
        Ok(resolved) => resolved.to_string_lossy().into_owned(),
        Err(_) => scope.trim_end_matches('/').to_string(),
    }
}

fn spawn_management(
    scope: &str,
    config: &ManagementSpawnConfig,
) -> Result<Arc<ManagementInstance>, String> {
    let mut args: Vec<String> = vec![
        // The management shape: no session files, no discovery — only the
        // explicit extensions load.
        "--no-session".into(),
        "--no-extensions".into(),
        "--no-skills".into(),
        "--no-prompt-templates".into(),
        "--no-themes".into(),
        "--no-context-files".into(),
    ];
    for extension in &config.extensions {
        args.push("--extension".into());
        args.push(extension.to_string_lossy().into_owned());
    }
    // The HOST owns the nonce: generated per spawn, never read back from the
    // caller's env (a caller-supplied or empty nonce would bind forged
    // envelopes from anywhere in the child to the management protocol).
    // Applied AFTER the caller's env so nothing can override it.
    let nonce = format!("mgmt-{}", uuid::Uuid::new_v4());
    let mut env = EnvPolicy::inherit();
    if let Some(agent_dir) = &config.agent_dir {
        env = env.set("PI_CODING_AGENT_DIR", agent_dir.to_string_lossy().into_owned());
    }
    for (key, value) in &config.env {
        env = env.set(key, value.clone());
    }
    env = env.set("PI_WEB_MGMT_NONCE", nonce.clone());
    let client = PiRpcClient::spawn(
        &config.executable,
        SpawnOptions { args, cwd: None, env, ..SpawnOptions::default() },
    )
    .map_err(|error| format!("management instance failed to start: {error}"))?;
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let router_pending = Arc::clone(&pending);
    let notify_subscription = client.on_notify_inline(Arc::new(move |record| route_envelope(&router_pending, record)));
    Ok(Arc::new(ManagementInstance {
        scope: scope.to_string(),
        nonce,
        client,
        pending,
        _notify_subscription: Arc::new(notify_subscription),
        state: Arc::new(Mutex::new(InstanceState {
            lease_until: Instant::now() + IDLE_RECYCLE,
            last_used: Instant::now(),
            active: 0,
            closing: false,
            tasks: HashMap::new(),
        })),
    }))
}

#[cfg(test)]
impl ManagementInstance {
    fn expire_for_tests(&self) {
        self.state.lock().unwrap().lease_until = Instant::now();
    }
}

#[cfg(test)]
impl ManagementHost {
    fn recycle_expired_all_for_tests(&self) {
        self.shutdown_all(Duration::from_secs(5));
    }
}

/// A CronOracle backed by the management extension's vendored croner
/// (plan §三: cron math stays with the fixed-version croner inside the
/// management instance; the Rust scheduler only consumes slots).
///
/// Each query is one management-protocol call: `/pi-web:mgmt` with
/// cron.previousRuns (bounded) — the most recent slot is computed from the
/// run history rather than a second, drifting implementation.
pub struct ManagementCronOracle<'a> {
    instance: &'a ManagementInstance,
}

impl<'a> ManagementCronOracle<'a> {
    pub fn new(instance: &'a ManagementInstance) -> Self {
        Self { instance }
    }

    fn call(&self, op: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
        // The result arrives as a nonce-bound PI_WEB_MGMT_V1 envelope
        // (management_call correlates the rid and checks the nonce).
        self.instance.management_call_sync(op, args)
    }
}

impl task_scheduler::CronOracle for ManagementCronOracle<'_> {
    fn previous_run(&self, expr: &str, timezone: &str, now_ms: i64) -> Option<i64> {
        let args = serde_json::json!({
            "expr": expr,
            "timezone": timezone,
            "fromISO": iso_from_ms(now_ms),
            "count": 1,
        });
        let result = self.call("cron.previousRuns", args).ok()?;
        let runs = result.get("runs").and_then(|runs| runs.as_array())?;
        let first = runs.first()?.as_str()?;
        iso_to_ms(first)
    }

    fn count_slots_between(&self, expr: &str, timezone: &str, since_ms: i64, until_ms: i64) -> u32 {
        // The skipped-slot count needs the SAME croner the fire decision
        // used — a local reimplementation would drift across DST/ranges.
        // A failed count answers 0 (the scheduler only uses it for the
        // skipped annotation, never for the fire/drop decision).
        let args = serde_json::json!({
            "expr": expr,
            "timezone": timezone,
            "sinceISO": iso_from_ms(since_ms),
            "untilISO": iso_from_ms(until_ms),
        });
        match self.call("cron.countSlots", args) {
            Ok(result) => result
                .get("count")
                .and_then(|count| count.as_u64())
                .map(|count| count.min(u32::MAX as u64) as u32)
                .unwrap_or(0),
            Err(_) => 0,
        }
    }
}

fn iso_from_ms(ms: i64) -> String {
    // Only minute precision is needed for cron boundaries.
    let seconds = ms.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        y, m, d,
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

fn iso_to_ms(iso: &str) -> Option<i64> {
    let bytes = iso.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let y: i64 = iso.get(0..4)?.parse().ok()?;
    let m: i64 = iso.get(5..7)?.parse().ok()?;
    let d: i64 = iso.get(8..10)?.parse().ok()?;
    let hh: i64 = iso.get(11..13)?.parse().ok()?;
    let mm: i64 = iso.get(14..16)?.parse().ok()?;
    let ss: i64 = iso.get(17..19)?.parse().ok()?;
    let days = civil_days_from(y, m, d);
    Some((days * 86_400 + hh * 3_600 + mm * 60 + ss) * 1000)
}

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

fn civil_days_from(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use task_scheduler::CronOracle as _;

    #[test]
    fn notify_router_correlates_concurrent_replies() {
        let pending = Mutex::new(HashMap::new());
        let (a_tx, a_rx) = std::sync::mpsc::channel();
        let (b_tx, b_rx) = std::sync::mpsc::channel();
        let task = || Arc::new(Mutex::new(TaskRecord { snapshot: TaskSnapshot { status: TaskStatus::Running, progress: None, result: None, error: None, cancel_requested: false }, finished_at: None }));
        let task_a = task();
        pending.lock().unwrap().insert("a".to_string(), PendingTask { tx: a_tx, task: Arc::clone(&task_a), nonce: "good".into() });
        pending.lock().unwrap().insert("b".to_string(), PendingTask { tx: b_tx, task: task(), nonce: "good".into() });
        for i in 0..1000 {
            route_envelope(&pending, &json!({"message": format!("PI_WEB_MGMT_PROGRESS_V1 {{\"rid\":\"a\",\"nonce\":\"good\",\"progress\":{i}}}")}));
        }
        route_envelope(&pending, &json!({"message": "PI_WEB_MGMT_PROGRESS_V1 {\"rid\":\"a\",\"nonce\":\"bad\",\"progress\":0}"}));
        assert_eq!(task_a.lock().unwrap().snapshot.progress, Some(json!(999)));
        route_envelope(&pending, &json!({"message": "PI_WEB_MGMT_V1 {\"rid\":\"b\",\"nonce\":\"bad\"}"}));
        route_envelope(&pending, &json!({"message": "PI_WEB_MGMT_V1 {\"rid\":\"a\",\"nonce\":\"good\"}"}));
        assert_eq!(a_rx.try_recv().unwrap()["nonce"], "good");
        assert_eq!(b_rx.try_recv().unwrap()["nonce"], "bad");
        pending.lock().unwrap().remove("a");
        route_envelope(&pending, &json!({"message": "PI_WEB_MGMT_V1 {\"rid\":\"a\"}"}));
        assert!(a_rx.try_recv().is_err());
    }

    fn pi_bin() -> Option<String> {
        match std::env::var("PI_CLI_BIN") {
            Ok(value) if !value.is_empty() && std::path::Path::new(&value).exists() => Some(value),
            Ok(value) if !value.is_empty() => panic!("PI_CLI_BIN points at a missing file: {value}"),
            _ => None,
        }
    }

    /// A fixture management extension: registers a provider (the shape real
    /// custom-provider extensions have) AND a management command.
    const FIXTURE: &str = r#"
export default function managementFixture(pi) {
  pi.registerProvider("mgmt-fixture", {
    name: "Management Fixture",
    baseUrl: "http://127.0.0.1:9",
    apiKey: "$POC_UNUSED_KEY",
    api: "openai-chat",
    models: [{
      id: "mgmt-fixture-model",
      name: "Management Fixture Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    }],
  });
  pi.registerCommand("mgmt:ping", {
    description: "management probe",
    handler: async () => "mgmt-pong",
  });
}
"#;

    #[test]
    fn real_pi_management_instance_enumerates_and_recycles() {
        let Some(executable) = pi_bin() else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent");
        let fixture = dir.path().join("mgmt-fixture.mjs");
        std::fs::write(&fixture, FIXTURE).expect("fixture");

        let config = ManagementSpawnConfig {
            executable,
            agent_dir: Some(agent_dir.clone()),
            extensions: vec![fixture],
            env: vec![("POC_UNUSED_KEY".to_string(), "x".to_string())],
        };
        let host = ManagementHost::new();

        // Scoped acquisition: global and a project cwd never share a child.
        let global = host.instance("global", &config).expect("global instance");
        let project = host.instance("/tmp/some-project", &config).expect("project instance");
        assert_ne!(global.client_pid(), project.client_pid());
        assert_eq!(host.scopes().len(), 2);

        // Provider enumeration includes the extension-registered provider.
        let models = global.available_models().expect("models");
        let list = models["models"].as_array().expect("models array");
        assert!(
            list.iter().any(|model| model["provider"] == "mgmt-fixture"),
            "extension provider enumerated"
        );

        // A management-extension command runs without starting a run.
        let ack = global
            .extension_prompt("/mgmt:ping", Duration::from_secs(30))
            .expect("extension command ack");
        assert_eq!(ack["disposition"], "handled", "consumed by the extension runtime");

        // --no-session: no session files were created in the agent dir.
        let sessions = agent_dir.join("sessions");
        assert!(
            !sessions.exists() || std::fs::read_dir(&sessions).map(|d| d.count()).unwrap_or(0) == 0,
            "management instances write no session files"
        );

        // An admitted operation excludes recycle even past the idle deadline.
        let activity = project.admit().unwrap();
        project.expire_for_tests();
        assert!(host.recycle_expired().is_empty());
        drop(activity);
        project.expire_for_tests();
        // Recycle: expire the project instance; global holds via lease.
        global.lease();
        let recycled = host.recycle_expired();
        assert_eq!(recycled, vec!["/tmp/some-project".to_string()]);
        assert_eq!(host.scopes(), vec!["global".to_string()]);
        assert!(project.admit().is_err(), "retired handles cannot admit work");
        host.recycle_expired_all_for_tests();
        assert!(global.admit().is_err());
        assert!(host.instance("global", &config).is_err());
    }

    #[test]
    fn real_pi_management_calls_and_cron_oracle_over_the_extension() {
        let Some(executable) = pi_bin() else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent");

        // The vendored tree: croner only (the cron ops need no SDK graph).
        let managed = dir.path().join("managed/node_modules");
        std::fs::create_dir_all(&managed).expect("managed");
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
            std::fs::create_dir_all(to).expect("target dir");
            for entry in std::fs::read_dir(from).expect("read dir").flatten() {
                let target = to.join(entry.file_name());
                let meta = entry.metadata().expect("metadata");
                if meta.is_dir() {
                    std::fs::create_dir_all(&target).expect("mkdir");
                    copy_tree(&entry.path(), &target);
                } else if meta.is_file() {
                    std::fs::copy(entry.path(), &target).expect("copy");
                }
                // Symlinks and specials are skipped: the croner tree has
                // none, and a vendored tree must be plain files.
            }
        }
        copy_tree(&repo_root.join("node_modules/croner"), &managed.join("croner"));

        let config = ManagementSpawnConfig {
            executable,
            agent_dir: Some(agent_dir),
            extensions: vec![
                repo_root.join("lib/pi-rpc/assets/pi-web-management.mjs"),
            ],
            env: vec![
                ("PI_WEB_MANAGED_MODULES".to_string(), managed.to_string_lossy().into_owned()),
                // NOTE: no PI_WEB_MGMT_NONCE — the HOST generates it per
                // spawn; a caller-supplied nonce must never bind.
            ],
        };
        let host = ManagementHost::new();
        let instance = host.instance("global", &config).expect("instance");

        // The capability table through the typed bridge.
        let capabilities = instance
            .management_call_sync("sys.capabilities", serde_json::json!({}))
            .expect("capabilities");
        assert_eq!(capabilities["version"], 1);
        assert!(capabilities["ops"].as_array().unwrap().iter().any(|op| op == "cron.preview"));

        // The CronOracle bridge: previous_run on a fixed UTC expression.
        let oracle = crate::ManagementCronOracle::new(&instance);
        // 2026-03-01T12:30:45Z with "17 5 * * *" → the 05:17 slot that day.
        let now_ms = 1_772_368_245_000;
        let previous = oracle.previous_run("17 5 * * *", "UTC", now_ms).expect("slot");
        assert_eq!(previous, 1_772_342_220_000, "2026-03-01T05:17:00Z");

        // The skipped-slot count uses the SAME croner (every 10 minutes for
        // one hour → 6 slots in (since, until]).
        let since = 1_772_362_800_000; // 2026-03-01T11:00:00Z
        let until = 1_772_366_400_000; // 2026-03-01T12:00:00Z
        let count = oracle.count_slots_between("*/10 * * * *", "UTC", since, until);
        assert_eq!(count, 6, "11:10, 11:20, 11:30, 11:40, 11:50, 12:00");
        // An empty window counts nothing.
        assert_eq!(oracle.count_slots_between("*/10 * * * *", "UTC", until, until), 0);

        // A failed op reports the extension's code.
        let error = instance
            .management_call_sync("cron.preview", serde_json::json!({ "expr": "bad" }))
            .expect_err("invalid cron refuses");
        assert!(error.contains("invalid_cron"), "{error}");

        host.recycle_expired_all_for_tests();
    }

    #[cfg(unix)]
    #[test]
    fn fake_process_routes_reversed_replies_and_wrong_nonce() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("fake-pi");
        std::fs::write(&executable, r##"#!/usr/bin/env node
const readline = require('node:readline');
const pending = [];
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const command = JSON.parse(line);
  if (command.type !== 'prompt') return;
  const [, rid, token] = command.message.split(' ');
  const payload = JSON.parse(Buffer.from(token, 'base64url'));
  emit({type:'response', id:command.id, command:'prompt', success:true, data:{disposition:'handled'}});
  pending.push([rid, payload.op]);
  if (pending.length === 2) {
    for (const [id, op] of pending.reverse()) {
      const body = {rid:id, nonce:op === 'bad' ? 'wrong' : process.env.PI_WEB_MGMT_NONCE, ok:true, result:op};
      emit({type:'extension_ui_request', id, method:'notify', message:'PI_WEB_MGMT_V1 ' + JSON.stringify(body)});
    }
    pending.length = 0;
  }
});
"##).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = ManagementSpawnConfig { executable: executable.to_string_lossy().into_owned(), agent_dir: Some(dir.path().join("agent")), extensions: vec![], env: vec![] };
        let host = ManagementHost::new();
        let instance = host.instance("global", &config).unwrap();
        let a = instance.start_task("good", json!({}), Duration::from_secs(5), TaskKind::Mutation).unwrap();
        let b = instance.start_task("bad", json!({}), Duration::from_secs(5), TaskKind::Mutation).unwrap();
        let until = Instant::now() + Duration::from_secs(5);
        while (instance.task_snapshot(&a).unwrap().status == TaskStatus::Running || instance.task_snapshot(&b).unwrap().status == TaskStatus::Running) && Instant::now() < until { std::thread::sleep(Duration::from_millis(5)); }
        assert_eq!(instance.task_snapshot(&a).unwrap().result, Some(json!("good")));
        let bad = instance.task_snapshot(&b).unwrap();
        assert_eq!(bad.status, TaskStatus::Unknown);
        assert!(bad.error.unwrap().contains("wrong nonce"));
        host.shutdown_all(Duration::from_secs(1));
    }

    #[test]
    fn real_pi_tasks_progress_cancel_and_unknown_are_isolated() {
        let Some(executable) = pi_bin() else { return };
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let fixture = dir.path().join("fixture.mjs");
        std::fs::write(&fixture, r#"
export default function(pi) {
 const tasks = new Map();
 pi.registerCommand('pi-web:mgmt', { handler: async (args, ctx) => {
   const [rid, token] = args.split(' ');
   const payload = JSON.parse(Buffer.from(token, 'base64url').toString());
   const nonce = process.env.PI_WEB_MGMT_NONCE;
   if (payload.op === '__cancel') { tasks.get(payload.args.rid)?.abort(); return; }
   const controller = new AbortController(); tasks.set(rid, controller);
   void (async () => {
     for (let i=0; i<1000 && payload.op === 'slow'; i++) ctx.ui.notify('PI_WEB_MGMT_PROGRESS_V1 ' + JSON.stringify({rid, nonce, progress: {i}}), 'info');
     if (payload.op !== 'sys.capabilities') await new Promise(resolve => setTimeout(resolve, 500));
     const cancelled = controller.signal.aborted && payload.op !== 'ignore';
     ctx.ui.notify('PI_WEB_MGMT_V1 ' + JSON.stringify({rid, nonce, ok: !cancelled, ...(cancelled ? {code:'cancelled', error:'cancelled'} : {result: payload.op})}), 'info');
     tasks.delete(rid);
   })();
 }});
}
"#).unwrap();
        let config = ManagementSpawnConfig { executable, agent_dir: Some(agent_dir), extensions: vec![fixture], env: vec![] };
        let host = ManagementHost::new();
        let instance = host.instance("global", &config).unwrap();
        let a = instance.start_task("slow", json!({}), Duration::from_secs(5), TaskKind::Mutation).unwrap();
        let b = instance.start_task("slow", json!({}), Duration::from_secs(5), TaskKind::Mutation).unwrap();
        let read = instance.start_task("sys.capabilities", json!({}), Duration::from_secs(5), TaskKind::ReadOnly).unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        while instance.task_snapshot(&a).unwrap().progress.is_none() && Instant::now() < until { std::thread::sleep(Duration::from_millis(5)); }
        assert!(instance.task_snapshot(&a).unwrap().progress.is_some());
        instance.cancel_task(&a).unwrap();
        while [ &a, &b, &read ].iter().any(|id| instance.task_snapshot(id).unwrap().status == TaskStatus::Running) && Instant::now() < until { std::thread::sleep(Duration::from_millis(5)); }
        assert_eq!(instance.task_snapshot(&a).unwrap().status, TaskStatus::Cancelled);
        assert_eq!(instance.task_snapshot(&b).unwrap().status, TaskStatus::Succeeded);
        assert_eq!(instance.task_snapshot(&read).unwrap().status, TaskStatus::Succeeded);
        let unknown = instance.start_task("ignore", json!({}), Duration::from_millis(30), TaskKind::Mutation).unwrap();
        while instance.task_snapshot(&unknown).unwrap().status == TaskStatus::Running && Instant::now() < until { std::thread::sleep(Duration::from_millis(5)); }
        assert_eq!(instance.task_snapshot(&unknown).unwrap().status, TaskStatus::Unknown);
        while !instance.task_snapshot(&unknown).unwrap().cancel_requested && Instant::now() < until { std::thread::sleep(Duration::from_millis(5)); }
        assert!(instance.task_snapshot(&unknown).unwrap().cancel_requested);
        assert!(instance.start_task("slow", json!({}), Duration::from_secs(1), TaskKind::Mutation).is_err());
        assert!(instance.start_task("slow", json!({}), Duration::from_secs(1), TaskKind::ReadOnly).is_err());
        instance.expire_for_tests();
        assert!(host.recycle_expired().is_empty());
        while instance.task_snapshot(&unknown).unwrap().status == TaskStatus::Unknown && Instant::now() < until { std::thread::sleep(Duration::from_millis(5)); }
        assert_eq!(instance.task_snapshot(&unknown).unwrap().status, TaskStatus::Succeeded);
        let exited = instance.start_task("ignore", json!({}), Duration::from_secs(5), TaskKind::Mutation).unwrap();
        instance.client.kill();
        while instance.task_snapshot(&exited).unwrap().status == TaskStatus::Running && Instant::now() < until { std::thread::sleep(Duration::from_millis(5)); }
        assert_eq!(instance.task_snapshot(&exited).unwrap().status, TaskStatus::Unknown);
        assert!(host.recycle_expired().is_empty());
        assert!(Arc::ptr_eq(&instance, &host.instance("global", &config).unwrap()));
        host.shutdown_all(Duration::from_secs(1));
        let host = ManagementHost::new();
        let instance = host.instance("global", &config).unwrap();
        let running = instance.start_task("ignore", json!({}), Duration::from_secs(5), TaskKind::Mutation).unwrap();
        host.shutdown_all(Duration::from_millis(100));
        assert_eq!(instance.task_snapshot(&running).unwrap().status, TaskStatus::Unknown);
        assert!(instance.start_task("sys.capabilities", json!({}), Duration::from_secs(1), TaskKind::ReadOnly).is_err());
        assert!(host.instance("global", &config).is_err());
    }

    #[test]
    fn timed_out_call_keeps_activity_until_terminal() {
        let Some(executable) = pi_bin() else { return };
        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        let fixture = dir.path().join("fixture.mjs");
        std::fs::write(&fixture, r#"
export default function(pi) {
  pi.registerCommand('pi-web:mgmt', { handler: async (args, ctx) => {
    const [rid] = args.split(' ');
    await new Promise(resolve => setTimeout(resolve, 300));
    ctx.ui.notify('PI_WEB_MGMT_V1 ' + JSON.stringify({rid, nonce: process.env.PI_WEB_MGMT_NONCE, ok: true, result: 1}), 'info');
  }});
}
"#).unwrap();
        let config = ManagementSpawnConfig { executable, agent_dir: Some(agent_dir), extensions: vec![fixture], env: vec![] };
        let host = ManagementHost::new();
        let instance = host.instance("global", &config).unwrap();
        let error = instance.management_call("test", json!({}), Duration::from_millis(20)).unwrap_err();
        assert!(error.contains("outcome unknown"));
        instance.expire_for_tests();
        assert!(host.recycle_expired().is_empty());
        let deadline = Instant::now() + Duration::from_secs(10);
        while instance.state.lock().unwrap().active != 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(instance.state.lock().unwrap().active, 0);
        for task in instance.state.lock().unwrap().tasks.values() {
            task.lock().unwrap().finished_at = Some(Instant::now() - Duration::from_secs(601));
        }
        instance.expire_for_tests();
        assert_eq!(host.recycle_expired(), vec!["global"]);
        host.shutdown_all(Duration::from_secs(1));
    }

    #[test]
    fn same_scope_reuses_the_instance() {
        let Some(executable) = pi_bin() else {
            eprintln!("skipping: PI_CLI_BIN not set");
            return;
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent");
        let config = ManagementSpawnConfig {
            executable,
            agent_dir: Some(agent_dir),
            extensions: vec![],
            env: vec![],
        };
        let host = ManagementHost::new();
        let first = host.instance("global", &config).expect("instance");
        let second = host.instance("global", &config).expect("instance");
        assert!(Arc::ptr_eq(&first, &second), "one child per scope while alive");
        host.recycle_expired_all_for_tests();
    }
}

