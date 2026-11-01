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

pub mod ledger;
pub mod target_key;
#[cfg(all(test, target_os = "linux"))]
mod ledger_tests;

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
    instance_id: uuid::Uuid,
    client: Arc<PiRpcClient>,
    state: Arc<Mutex<InstanceState>>,
    /// The management protocol nonce this child was spawned with. The HOST
    /// generates it at spawn (never accepted from the caller): a caller-
    /// supplied nonce — or worse, an empty one — would let a forged envelope
    /// from anywhere in the child bind to the management protocol.
    nonce: String,
    pending: Arc<Mutex<HashMap<String, PendingTask>>>,
    agent_dir: PathBuf,
    session_file_writer: bool,
    agent_dir_check: Option<Arc<dyn Fn(&std::path::Path) -> Result<(), String> + Send + Sync>>,
    admission: Arc<Mutex<ManagementAdmission>>,
    _notify_subscription: Arc<pi_host::client::UiSubscription>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskKind { ReadOnly, Mutation }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OperationPolicy { ReadOnly, Ephemeral, PersistentMutation, SessionWriter }

fn operation_policy(op: &str, session_writer: bool) -> Result<OperationPolicy, String> {
    use OperationPolicy::*;
    if session_writer {
        return if matches!(op, "session.setOfflineChatUnlock" | "session.continueChat" | "session.forkStaged") { Ok(SessionWriter) } else { Err("unclassified session writer operation".into()) };
    }
    if ledger::target_for(op).is_some() { return Ok(PersistentMutation); }
    match op {
        "sys.capabilities" | "cron.preview" | "cron.previousRuns" | "cron.countSlots" |
        "session.readHeader" | "session.readEntries" | "session.readContext" | "session.readView" |
        "session.projectSnapshot" | "session.isFileReferenced" | "session.reference" | "session.search" |
        "session.readThinking" | "session.recordedSystemPrompt" | "session.authorizeBashOutput" |
        "chat.systemPrompt" | "session.chatOnlyPrompt" | "models.list" | "models.enabledGet" |
        "modelsConfig.get" | "models.nonchat" | "skills.list" | "plugins.list" |
        "auth.providers" | "auth.loginPoll" | "mcp.configGet" | "mcp.credentialTarget" | "mcp.probeTarget" | "trust.projectListing" | "trust.projectStatus" |
        "terminal.settingsGet" | "terminal.resolveShell" | "distro.status" | "docx.extractText" | "docx.renderHtml" |
        "tasks.validateCreate" | "tasks.validateUpdate" | "tasks.nextRun" | "tasks.decideSlot" | "tasks.previewCron" => Ok(ReadOnly),
        // These can call a network service or write an explicitly temporary
        // projection. They are not pure reads and are never auto-retried.
        "modelsConfig.catalog" | "modelsConfig.discover" | "modelsConfig.test" |
        "models.providerUsage" | "skills.search" | "skills.check" | "plugins.check" |
        "session.export" | "session.extractToolResultImage" | "auth.loginCancel" => Ok(Ephemeral),
        _ => Err(format!("unclassified management operation: {op}")),
    }
}

fn mutation_scope(op: &str, args: &Value) -> Result<ledger::OperationScope, String> {
    if op == "trust.setFenced" || (matches!(op, "plugins.install" | "plugins.remove" | "plugins.update" | "skills.install" | "skills.update" | "mcp.configAction" | "mcp.signInStart" | "mcp.signOutCooperative" | "mcp.test")
        && args.get("scope").and_then(Value::as_str) == Some("project")) {
        let cwd = args.get("cwd").and_then(Value::as_str).ok_or("project mutation lacks a physical scope")?;
        let canonical = std::fs::canonicalize(cwd).map_err(|e| format!("cannot identify project mutation scope: {e}"))?;
        let path = canonical.to_str().ok_or("project mutation scope is not UTF-8")?.to_string();
        return Ok(ledger::OperationScope::Project { path });
    }
    Ok(ledger::OperationScope::Global)
}

fn confirmed_success(op: &str, value: &Value) -> bool {
    fn contains_failure(value: &Value) -> bool {
        match value {
            Value::Array(items) => items.iter().any(contains_failure),
            Value::Object(fields) => fields.iter().any(|(key, value)| {
                ((key == "error" || key == "mcpRefusal") && !value.is_null()) || contains_failure(value)
            }),
            _ => false,
        }
    }
    if value.get("mcpRefusal").is_some() { return false; }
    match op {
        "plugins.setEnabled" | "skills.setDisabled" => !contains_failure(value),
        "models.refreshCatalog" => value.get("completed").and_then(Value::as_bool) == Some(true),
        // Probe uses bounded Promise.race/close waits: an answered probe does
        // not prove an in-flight credential refresh can no longer write.
        "mcp.test" => false,
        "mcp.signOutCooperative" => value.get("schema").and_then(Value::as_u64) == Some(1) && value.get("result").is_some() && value.get("revocation").is_some(),
        // These asynchronous flows encode failure/cancellation in successful
        // envelopes, so only their explicitly successful terminal phase counts.
        "mcp.signInStart" => value.get("phase").and_then(Value::as_str) == Some("done"),
        "auth.loginStart" => value.get("success").and_then(Value::as_bool) == Some(true),
        "trust.setFenced" | "mcp.trustFolderAdd" => value.get("result").is_some_and(|result| result.get("mcpRefusal").is_none()),
        _ => true,
    }
}

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

/// Instance-local evidence only: never authority to clear a restarted
/// operation or to assert that unrelated children have stopped.
/// Host-only preflight. Canonical/config values may be sensitive: this type
/// intentionally has no Debug/Serialize implementation or public fields.
pub struct McpCredentialAdmission {
    instance_id: uuid::Uuid,
    payload: Value,
    canonical_key: String,
    legacy_key: String,
    config_key: String,
    generation: u64,
    target: ledger::McpCredentialTarget,
    config_fingerprint: String,
}

impl McpCredentialAdmission {
    pub fn target(&self) -> &ledger::McpCredentialTarget { &self.target }
}

pub struct McpProbeAdmission {
    instance_id: uuid::Uuid,
    payload: Value,
    kind: &'static str,
    config_key: String,
    credential: Option<McpCredentialAdmission>,
}

pub struct VerifiedMcpRevocation {
    instance_id: uuid::Uuid,
    target_fingerprint: String,
    legacy_fingerprint: String,
    config_fingerprint: String,
    generation: u64,
}
impl VerifiedMcpRevocation {
    pub fn generation(&self) -> u64 { self.generation }
}

struct McpGuardAdmission {
    target: ledger::McpCredentialTarget,
    generation: u64,
    config_fingerprint: String,
}

struct TaskRecord {
    snapshot: TaskSnapshot,
    finished_at: Option<Instant>,
    serial_scope: bool,
    blocks_mutations: bool,
    exclusive: bool,
    operation: String,
    ledger_operation_id: Option<String>,
    mcp_target: Option<ledger::McpCredentialTarget>,
    mcp_guard: Option<McpGuardAdmission>,
    revoked: bool,
    runner: Option<Arc<ManagementInstance>>,
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

#[derive(Default)]
struct ManagementAdmission {
    starting_instances: usize,
    reservation: Option<uuid::Uuid>,
}

/// A host-local reservation, not maintenance or recovery authority. Dropping
/// it releases only in-memory exclusion and never alters pending evidence.
pub struct McpCooperativeReservation {
    admission: Arc<Mutex<ManagementAdmission>>,
    reservation_id: uuid::Uuid,
    instance_id: uuid::Uuid,
    target: ledger::McpCredentialTarget,
    config_fingerprint: String,
    previous_generation: u64,
    state: Arc<Mutex<InstanceState>>,
    client: Arc<PiRpcClient>,
    agent_dir: PathBuf,
    agent_dir_check: Option<Arc<dyn Fn(&std::path::Path) -> Result<(), String> + Send + Sync>>,
    blockers: Vec<String>,
    known_pending: Vec<String>,
    #[cfg(test)]
    fail_after: Option<usize>,
}
impl McpCooperativeReservation {
    /// Checks a routed ACK against this live reservation; never clears a ledger.
    pub fn matches_revocation(&self, proof: &VerifiedMcpRevocation) -> bool {
        let Ok(admission) = self.admission.try_lock() else { return false };
        let Ok(state) = self.state.try_lock() else { return false };
        if state.closing || self.client.has_exited() || self.agent_dir_check.as_ref().is_some_and(|check| check(&self.agent_dir).is_err()) { return false; }
        admission.reservation == Some(self.reservation_id) && self.instance_id == proof.instance_id
            && self.target.primary_digest() == proof.target_fingerprint
            && self.target.legacy_digest() == proof.legacy_fingerprint
            && self.config_fingerprint == proof.config_fingerprint && proof.generation > self.previous_generation
    }

    /// Persist only revocation of the exact local writers proven by this ACK.
    /// Any interrupted/partial transaction leaves remaining records pending.
    pub fn persist_revocation(&self, proof: &VerifiedMcpRevocation) -> Result<(), String> {
        if !self.matches_revocation(proof) { return Err("MCP revocation is not confirmed".into()); }
        {
            let admission = self.admission.try_lock().map_err(|_| "management admission busy")?;
            if admission.reservation != Some(self.reservation_id) { return Err("MCP reservation ended".into()); }
            let state = self.state.try_lock().map_err(|_| "management instance busy")?;
            if state.closing || self.client.has_exited() || self.agent_dir_check.as_ref().is_some_and(|check| check(&self.agent_dir).is_err()) { return Err("management instance changed".into()); }
            let pending = ledger::OperationLedger::inspect(&self.agent_dir)?;
            if self.blockers.iter().any(|id| !pending.iter().any(|record| &record.operation_id == id && record.mcp_target.as_ref() == Some(&self.target)))
                || pending.iter().any(|record| !self.known_pending.contains(&record.operation_id)) {
                return Err("management pending evidence changed".into());
            }
            let mut tasks = Vec::new();
            for id in &self.blockers {
                let task = state.tasks.values().find(|task| task.try_lock().ok().is_some_and(|record| record.ledger_operation_id.as_deref() == Some(id))).ok_or("MCP writer identity changed")?;
                let record = task.try_lock().map_err(|_| "MCP writer busy")?;
                let guard = record.mcp_guard.as_ref().ok_or("MCP guard evidence is missing")?;
                if record.revoked || record.finished_at.is_some() || guard.target != self.target
                    || guard.config_fingerprint != self.config_fingerprint || guard.generation >= proof.generation {
                    return Err("MCP writer evidence changed".into());
                }
                drop(record);
                tasks.push(Arc::clone(task));
            }
            // Monotonic in memory before any disk transition: late callbacks
            // cannot overwrite an already authorized revocation.
            for task in tasks { task.lock().map_err(|_| "MCP writer unavailable")?.revoked = true; }
        }
        let ledger = ledger::OperationLedger::open(&self.agent_dir)?;
        for (index, id) in self.blockers.iter().enumerate() {
            #[cfg(test)]
            if self.fail_after == Some(index) { return Err("injected ledger write failure".into()); }
            #[cfg(not(test))]
            let _ = index;
            if !self.matches_revocation(proof) { return Err("MCP reservation or instance changed".into()); }
            ledger.mark_revoked(id, &self.target, proof.generation)?;
        }
        Ok(())
    }
}
impl Drop for McpCooperativeReservation {
    fn drop(&mut self) {
        if let Ok(mut admission) = self.admission.lock() {
            if admission.reservation == Some(self.reservation_id) { admission.reservation = None; }
        }
    }
}

struct StartingInstance(Arc<Mutex<ManagementAdmission>>);
impl Drop for StartingInstance {
    fn drop(&mut self) {
        if let Ok(mut admission) = self.0.lock() { admission.starting_instances -= 1; }
    }
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
        self.management_call_kind(op, args, timeout, TaskKind::Mutation)
    }

    pub fn management_call_kind(&self, op: &str, args: Value, timeout: Duration, kind: TaskKind) -> Result<Value, String> {
        let handle = self.start_task(op, args, Duration::from_secs(600), kind)?;
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

    /// Resolve a private credential identity from the fixed management child.
    /// The returned admission stays bound to this instance and input payload.
    pub fn resolve_mcp_admission(&self, payload: Value) -> Result<McpCredentialAdmission, String> {
        let agent = self.agent_dir.to_str().ok_or("agent directory is not UTF-8")?;
        if payload.get("agentDir").and_then(Value::as_str) != Some(agent) || !payload.get("allowedRoots").is_some_and(Value::is_array)
            || payload.get("credentialAdmission").is_some() { return Err("invalid trusted MCP context".into()); }
        let response = self.management_call_kind("mcp.credentialTarget", payload.clone(), Duration::from_secs(30), TaskKind::ReadOnly)?;
        if response.get("schema").and_then(Value::as_u64) != Some(1) || response.get("admissionSchema").and_then(Value::as_u64) != Some(1) {
            return Err("MCP credential admission capability unavailable".into());
        }
        let canonical = response.get("canonicalKey").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("invalid MCP credential admission")?;
        let legacy = response.get("legacyKey").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("MCP legacy credential identity unavailable")?;
        let config = response.get("configKey").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("invalid MCP credential admission")?;
        let generation = response.get("generation").and_then(Value::as_u64).filter(|n| *n <= 9_007_199_254_740_991).ok_or("invalid MCP credential admission")?;
        let key = target_key::ManagementTargetKey::load_or_create(&self.agent_dir)?;
        let target = ledger::McpCredentialTarget::new(key.fingerprint(canonical)?, key.fingerprint_legacy(legacy)?)?;
        let config_fingerprint = key.fingerprint(&format!("config:{config}"))?;
        Ok(McpCredentialAdmission { instance_id: self.instance_id, payload, canonical_key: canonical.into(), legacy_key: legacy.into(), config_key: config.into(), generation, target, config_fingerprint })
    }

    /// Resolve a no-I/O probe classification from the fixed management child.
    pub fn resolve_mcp_probe(&self, payload: Value) -> Result<McpProbeAdmission, String> {
        let agent = self.agent_dir.to_str().ok_or("agent directory is not UTF-8")?;
        if payload.get("agentDir").and_then(Value::as_str) != Some(agent) || !payload.get("allowedRoots").is_some_and(Value::is_array)
            || payload.get("probeAdmission").is_some() { return Err("invalid trusted MCP context".into()); }
        let response = self.management_call_kind("mcp.probeTarget", payload.clone(), Duration::from_secs(30), TaskKind::ReadOnly)?;
        if response.get("schema").and_then(Value::as_u64) != Some(1) || response.get("probeAdmissionSchema").and_then(Value::as_u64) != Some(1) { return Err("MCP probe admission capability unavailable".into()); }
        let config = response.get("configKey").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("invalid MCP probe admission")?.to_string();
        let kind = match response.get("kind").and_then(Value::as_str) {
            Some("mcp-oauth") => "mcp-oauth", Some("http-no-mcp-oauth") => "http-no-mcp-oauth",
            Some("broad") => return Err("MCP probe has a broad unverified side-effect scope".into()),
            _ => return Err("invalid MCP probe admission".into()),
        };
        let credential = if kind == "mcp-oauth" {
            let canonical = response.get("canonicalKey").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("invalid MCP probe identity")?;
            let legacy = response.get("legacyKey").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("invalid MCP probe identity")?;
            let generation = response.get("generation").and_then(Value::as_u64).filter(|n| *n <= 9_007_199_254_740_991).ok_or("invalid MCP probe identity")?;
            let key = target_key::ManagementTargetKey::load_or_create(&self.agent_dir)?;
            Some(McpCredentialAdmission { instance_id: self.instance_id, payload: payload.clone(), canonical_key: canonical.into(), legacy_key: legacy.into(), config_key: config.clone(), generation,
                target: ledger::McpCredentialTarget::new(key.fingerprint(canonical)?, key.fingerprint_legacy(legacy)?)?, config_fingerprint: key.fingerprint(&format!("config:{config}"))? })
        } else { None };
        Ok(McpProbeAdmission { instance_id: self.instance_id, payload, kind, config_key: config, credential })
    }

    pub fn start_mcp_probe(&self, mut admission: McpProbeAdmission, deadline: Duration) -> Result<String, String> {
        if admission.instance_id != self.instance_id { return Err("MCP probe admission instance mismatch".into()); }
        let mut contract = json!({"schema":1,"kind":admission.kind,"configKey":admission.config_key});
        let guard = if let Some(credential) = admission.credential {
            contract["canonicalKey"] = json!(credential.canonical_key);
            contract["legacyKey"] = json!(credential.legacy_key);
            contract["generation"] = json!(credential.generation);
            Some(McpGuardAdmission { target: credential.target, generation: credential.generation, config_fingerprint: credential.config_fingerprint })
        } else { None };
        admission.payload["probeAdmission"] = contract;
        let expected = Some((admission.config_key, admission.kind == "http-no-mcp-oauth"));
        self.start_task_inner("mcp.test", admission.payload, deadline, TaskKind::Mutation, false, None, None, guard, None, expected).map(|(handle, _)| handle)
    }

    /// Dispatch the same authorized context with the private guard contract.
    pub fn start_admitted_mcp(&self, op: &str, mut admission: McpCredentialAdmission, deadline: Duration) -> Result<(String, bool), String> {
        if admission.instance_id != self.instance_id || !matches!(op, "mcp.signInStart" | "mcp.test") { return Err("MCP admission instance mismatch".into()); }
        admission.payload["credentialAdmission"] = json!({"schema":1,"canonicalKey":admission.canonical_key,"legacyKey":admission.legacy_key,"configKey":admission.config_key,"generation":admission.generation});
        let guard = McpGuardAdmission { target: admission.target, generation: admission.generation, config_fingerprint: admission.config_fingerprint };
        self.start_task_inner(op, admission.payload, deadline, TaskKind::Mutation, false, None, None, Some(guard), None, None)
    }

    /// Cooperative sign-out under an already acquired local reservation.
    /// The preflight is repeated with the reservation held before dispatch;
    /// only a routed ACK can transition the old local writers to revoked.
    pub fn cooperative_mcp_sign_out(&self, first: McpCredentialAdmission, reservation: &McpCooperativeReservation, deadline: Duration) -> Result<Value, String> {
        if first.instance_id != self.instance_id || first.target != reservation.target || reservation.instance_id != self.instance_id {
            return Err("MCP cooperative identity mismatch".into());
        }
        let second = self.resolve_mcp_admission(first.payload.clone())?;
        if second.instance_id != first.instance_id || second.target != first.target || second.config_fingerprint != first.config_fingerprint
            || second.generation != first.generation || second.canonical_key != first.canonical_key || second.legacy_key != first.legacy_key {
            return Err("MCP credential configuration changed".into());
        }
        let mut payload = first.payload;
        payload["expectedCanonicalKey"] = json!(first.canonical_key);
        payload["expectedLegacyKey"] = json!(first.legacy_key);
        payload["expectedConfigKey"] = json!(first.config_key);
        let (handle, _) = self.start_task_inner("mcp.signOutCooperative", payload, deadline, TaskKind::Mutation, false, None, None, None, Some(reservation), None)?;
        let until = Instant::now() + deadline;
        let result = loop {
            let snapshot = self.task_snapshot(&handle)?;
            match snapshot.status {
                TaskStatus::Succeeded => break snapshot.result.ok_or("MCP cooperative result missing")?,
                TaskStatus::Unknown | TaskStatus::Failed | TaskStatus::Cancelled => return Err("MCP cooperative outcome unknown".into()),
                TaskStatus::Running => {},
            }
            if Instant::now() >= until { return Err("MCP cooperative outcome unknown".into()); }
            std::thread::sleep(Duration::from_millis(10));
        };
        let config = result.get("revocation").and_then(|r| r.get("configKey")).and_then(Value::as_str).ok_or("MCP cooperative acknowledgement missing")?;
        let proof = self.verified_mcp_revocation(&handle, reservation.target.primary_digest(), config)?;
        if !reservation.matches_revocation(&proof) { return Err("MCP cooperative acknowledgement mismatch".into()); }
        let operation_id = {
            let state = self.state.lock().map_err(|_| "management state unavailable")?;
            let task = state.tasks.get(&handle).ok_or("MCP cooperative task missing")?.lock().map_err(|_| "management task unavailable")?;
            task.ledger_operation_id.clone().ok_or("MCP cooperative evidence missing")?
        };
        ledger::OperationLedger::open(&self.agent_dir)?.finish(&operation_id)?;
        reservation.persist_revocation(&proof)?;
        let public_result = result.get("result").cloned().ok_or("MCP cooperative result missing")?;
        // Do not retain the private key-bearing reply in a task snapshot.
        if let Some(task) = self.state.lock().unwrap().tasks.get(&handle) { task.lock().unwrap().snapshot.result = None; }
        Ok(public_result)
    }

    /// Start a task. `kind` and `deadline` are trusted host policy, never frontend input.
    /// Operations must redact secrets before reporting a result or progress.
    pub fn start_task(&self, op: &str, args: Value, deadline: Duration, kind: TaskKind) -> Result<String, String> {
        self.start_task_inner(op, args, deadline, kind, false, None, None, None, None, None).map(|(handle, _)| handle)
    }

    /// Reserve the same scope task capacity and unknown isolation used by ordinary tasks.
    pub fn start_serial_task(&self, op: &str, args: Value, deadline: Duration) -> Result<String, String> {
        self.start_task_inner(op, args, deadline, TaskKind::Mutation, true, None, None, None, None, None).map(|(handle, _)| handle)
    }

    /// Reserve this scope while executing in an existing cwd-scoped child.
    pub fn start_serial_task_on(&self, runner: Arc<ManagementInstance>, op: &str, args: Value, deadline: Duration) -> Result<String, String> {
        self.start_task_inner(op, args, deadline, TaskKind::Mutation, true, None, Some(runner), None, None, None).map(|(handle, _)| handle)
    }

    /// A killable child owned by one task; never reuse it for reads or other mutations.
    pub fn start_exclusive_task(&self, op: &str, args: Value, deadline: Duration, config: ManagementSpawnConfig) -> Result<String, String> {
        if self.scope != "global" || !matches!(op, "plugins.install" | "plugins.remove" | "plugins.update" | "skills.install" | "skills.update") {
            return Err("operation is not approved for exclusive management".into());
        }
        #[cfg(windows)]
        { let _ = (op, args, deadline, config); return Err("exclusive management mutations are unsupported on Windows".into()); }
        #[cfg(unix)]
        self.start_task_inner(op, args, deadline, TaskKind::Mutation, true, Some(config), None, None, None, None).map(|(handle, _)| handle)
    }

    fn start_task_inner(&self, op: &str, args: Value, deadline: Duration, kind: TaskKind, serial_scope: bool, exclusive_config: Option<ManagementSpawnConfig>, shared_runner: Option<Arc<ManagementInstance>>, admitted_mcp: Option<McpGuardAdmission>, cooperation: Option<&McpCooperativeReservation>, probe_expected: Option<(String, bool)>) -> Result<(String, bool), String> {
        if deadline.is_zero() || deadline > Duration::from_secs(600) { return Err("invalid management task deadline".into()); }
        if let Some(check) = &self.agent_dir_check { check(&self.agent_dir)?; }
        if shared_runner.as_ref().is_some_and(|runner| runner.agent_dir != self.agent_dir || !Arc::ptr_eq(&runner.admission, &self.admission))
            || exclusive_config.as_ref().is_some_and(|config| config.agent_dir.as_ref() != Some(&self.agent_dir)) {
            return Err("management runner does not share the pinned host identity".into());
        }
        if (op == "mcp.signOutCooperative") != cooperation.is_some() { return Err("MCP cooperative reservation is required".into()); }
        let mut policy = operation_policy(op, self.session_file_writer)?;
        if op == "mcp.test" && probe_expected.as_ref().is_some_and(|(_, no_oauth)| *no_oauth) { policy = OperationPolicy::Ephemeral; }
        if kind == TaskKind::ReadOnly && policy != OperationPolicy::ReadOnly {
            return Err("operation is not approved as read-only".into());
        }
        let kind = if matches!(policy, OperationPolicy::ReadOnly | OperationPolicy::Ephemeral) { TaskKind::ReadOnly } else { TaskKind::Mutation };
        // Short critical section only: never retain this mutex across child
        // RPC or task callbacks. Reservations block before any side effect.
        let _admission = if kind == TaskKind::Mutation {
            let admission = self.admission.try_lock().map_err(|_| "management admission busy")?;
            if let Some(reservation) = cooperation {
                if !Arc::ptr_eq(&reservation.admission, &self.admission) || reservation.instance_id != self.instance_id || admission.reservation != Some(reservation.reservation_id) {
                    return Err("MCP cooperative reservation is not active".into());
                }
            } else if admission.reservation.is_some() { return Err("management cooperative reservation is active".into()); }
            Some(admission)
        } else { None };
        let handle = format!("task-{}", uuid::Uuid::new_v4());
        let task = Arc::new(Mutex::new(TaskRecord { snapshot: TaskSnapshot {
            status: TaskStatus::Running, progress: None, result: None, error: None, cancel_requested: false,
        }, finished_at: None, serial_scope, blocks_mutations: kind == TaskKind::Mutation, exclusive: exclusive_config.is_some(), operation: op.to_string(), ledger_operation_id: None, mcp_target: None, mcp_guard: None, revoked: false, runner: None }));
        let (activity, evidence) = {
            let mut state = self.state.lock().unwrap();
            state.tasks.retain(|_, task| task.lock().unwrap().finished_at.map_or(true, |at| at.elapsed() < Duration::from_secs(600)));
            if state.closing || self.client.has_exited() { return Err("management instance is closing".into()); }
            if state.tasks.len() >= 128 { return Err("management task capacity reached".into()); }
            if op.starts_with("plugins.") || op.starts_with("skills.") {
                if kind == TaskKind::Mutation && !serial_scope { return Err("configuration mutation requires the physical scope slot".into()); }
            }
            if serial_scope && state.tasks.values().any(|task| { let task = task.lock().unwrap(); task.serial_scope && task.finished_at.is_none() }) {
                return Err("management configuration scope is busy".into());
            }
            if kind == TaskKind::Mutation && admitted_mcp.is_none() && cooperation.is_none() && state.tasks.values().any(|task| { let task = task.lock().unwrap(); task.blocks_mutations && !task.revoked && task.snapshot.status == TaskStatus::Unknown }) {
                return Err("management scope has an unknown outcome".into());
            }
            let evidence = if policy == OperationPolicy::PersistentMutation {
                // Establish the HMAC key before creating any ledger directory;
                // missing key beside existing evidence can never be regenerated.
                let _key = target_key::ManagementTargetKey::load_or_create(&self.agent_dir)?;
                let ledger = ledger::OperationLedger::open(&self.agent_dir)?;
                let mut descriptor = ledger::MutationDescriptor::new(op, mutation_scope(op, &args)?)?;
                let mut allowed = Vec::new();
                if let Some(reservation) = cooperation {
                    descriptor = descriptor.with_mcp_target(reservation.target.clone())?;
                    allowed = reservation.known_pending.clone();
                }
                if let Some(guard) = &admitted_mcp {
                    descriptor = descriptor.with_mcp_target(guard.target.clone())?;
                    for pending in ledger.list_pending()? {
                        let previous_target = pending.mcp_target.as_ref().ok_or("unidentified management outcome is unresolved")?;
                        let (existing_handle, existing) = state.tasks.iter().find_map(|(handle, task)| {
                            let task = task.try_lock().ok()?;
                            if task.ledger_operation_id.as_deref() != Some(pending.operation_id.as_str()) || task.revoked || task.finished_at.is_some() { return None; }
                            let existing = task.mcp_guard.as_ref()?;
                            if task.mcp_target.as_ref() != Some(previous_target) || existing.target != *previous_target { return None; }
                            Some((handle.clone(), (task.operation.clone(), task.snapshot.status, task.snapshot.cancel_requested, existing.config_fingerprint.clone(), existing.generation)))
                        }).ok_or("management writer is not owned by this instance")?;
                        if guard.target.conflicts(previous_target) {
                            if op == "mcp.signInStart" && pending.operation == op && guard.target == *previous_target
                                && existing.0 == op && existing.1 == TaskStatus::Running && !existing.2
                                && existing.3 == guard.config_fingerprint && existing.4 == guard.generation {
                                return Ok((existing_handle, true));
                            }
                            return Err("MCP credential target is busy".into());
                        }
                        if !matches!(pending.operation.as_str(), "mcp.signInStart" | "mcp.test") { return Err("unrelated management outcome is unresolved".into()); }
                        allowed.push(pending.operation_id);
                    }
                }
                let id = ledger.begin_allowing(&descriptor, &allowed)?;
                {
                    let mut record = task.lock().unwrap();
                    record.ledger_operation_id = Some(id.clone());
                    record.mcp_target = descriptor.mcp_target().cloned();
                    record.mcp_guard = admitted_mcp;
                }
                Some((ledger, id))
            } else { None };
            state.active += 1;
            state.tasks.insert(handle.clone(), Arc::clone(&task));
            (Activity(Arc::clone(&self.state)), evidence)
        };
        drop(_admission);
        let instance = self.clone();
        let id = handle.clone();
        let is_cooperative = cooperation.is_some();
        let operation = op.to_string();
        let worker_task = Arc::clone(&task);
        if let Err(error) = std::thread::Builder::new().name("mgmt-task".into()).spawn(move || {
            let mut exclusive_clean_exit = false;
            let result = if let Some(mut config) = exclusive_config {
                config.env.push(("PI_WEB_EXCLUSIVE_MUTATION".into(), "1".into()));
                match spawn_management(&instance.scope, &config, instance.agent_dir_check.clone(), Arc::clone(&instance.admission)) {
                    Ok(runner) => {
                        let cancelled = {
                            let mut record = worker_task.lock().unwrap();
                            record.runner = Some(Arc::clone(&runner));
                            record.snapshot.cancel_requested
                        };
                        let result = if cancelled { Err("management operation outcome unknown".into()) } else {
                            runner.management_call_wait(&operation, args, &id, Arc::clone(&worker_task))
                        };
                        if cancelled { let _ = runner.force_stop(Duration::from_secs(5)); }
                        else { exclusive_clean_exit = runner.close_session_file_writer(Duration::from_secs(5)); }
                        result
                    }
                    Err(error) => Err(format!("[op_failed] {error}")),
                }
            } else if let Some(runner) = shared_runner {
                worker_task.lock().unwrap().runner = Some(Arc::clone(&runner));
                match runner.admit() {
                    Ok(_activity) => runner.management_call_wait(&operation, args, &id, Arc::clone(&worker_task)),
                    Err(error) => Err(format!("[op_failed] {error}")),
                }
            } else {
                instance.management_call_wait(&operation, args, &id, Arc::clone(&worker_task))
            };
            let mut record = worker_task.lock().unwrap();
            record.runner = None;
            if record.revoked {
                record.snapshot.status = TaskStatus::Unknown;
                record.snapshot.error = Some("local credential writes were revoked; task outcome remains unknown".into());
                record.finished_at = Some(Instant::now());
                drop(record); drop(activity); return;
            }
            if record.exclusive && record.snapshot.status == TaskStatus::Unknown {
                drop(record);
                drop(activity);
                return;
            }
            match result {
                Ok(mut value) => {
                    let mut probe_confirmed = false;
                    if operation == "mcp.test" {
                        let receipt = value.as_object_mut().and_then(|object| object.remove("_probeReceipt"));
                        let valid = probe_expected.as_ref().is_some_and(|(config, _)| value.get("configKey").and_then(Value::as_str) == Some(config.as_str()));
                        let safe = valid && receipt.as_ref().is_some_and(|r| r.get("schema").and_then(Value::as_u64) == Some(1)
                            && r.get("localWritesClosed").and_then(Value::as_bool) == Some(true)
                            && r.get("pastLocal").and_then(Value::as_str) == Some("settled")
                            && r.get("remoteToken").and_then(Value::as_str) == Some("none-observed"));
                        if !safe || record.snapshot.status == TaskStatus::Unknown {
                            record.snapshot.status = TaskStatus::Unknown;
                            record.snapshot.error = Some("MCP probe credential outcome requires reconciliation".into());
                            if valid { record.snapshot.result = Some(value); }
                            drop(record); drop(activity); return;
                        }
                        probe_confirmed = true;
                    }
                    // A deadline/response-loss/forced stop remains unknown even
                    // if a late envelope subsequently arrives. Exclusive writers
                    // must also have completed an orderly, unforced leader exit.
                    if let Some((ledger, id)) = evidence {
                        if record.snapshot.status == TaskStatus::Unknown || (record.exclusive && !exclusive_clean_exit) || !(probe_confirmed || confirmed_success(&operation, &value)) {
                            record.snapshot.status = TaskStatus::Unknown;
                            record.snapshot.error = Some("management outcome requires reconciliation".into());
                            if operation == "mcp.test" { record.snapshot.result = Some(value); }
                            drop(record); drop(activity); return;
                        }
                        if !is_cooperative {
                            if let Err(error) = ledger.finish(&id) {
                                record.snapshot.status = TaskStatus::Unknown;
                                record.snapshot.error = Some(format!("management completion could not be persisted: {error}"));
                                drop(record); drop(activity); return;
                            }
                        }
                    }
                    record.snapshot.status = TaskStatus::Succeeded; record.snapshot.result = Some(value); record.finished_at = Some(Instant::now());
                }
                Err(error) if evidence.is_some() => {
                    record.snapshot.status = TaskStatus::Unknown;
                    record.snapshot.error = Some(error);
                }
                Err(error) if error.starts_with("[outcome_unknown]") => {
                    record.snapshot.status = TaskStatus::Unknown;
                    record.snapshot.error = Some(error);
                }
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
        Ok((handle, false))
    }

    pub fn exclusive_task_snapshot(&self, handle: &str, domain: &str) -> Result<TaskSnapshot, String> {
        let state = self.state.lock().unwrap();
        let task = state.tasks.get(handle).ok_or("management task not found")?.lock().unwrap();
        if !task.exclusive || !matches!((domain, task.operation.as_str()), ("plugins", "plugins.install" | "plugins.remove" | "plugins.update") | ("skills", "skills.install" | "skills.update")) { return Err("management task not found".into()); }
        Ok(task.snapshot.clone())
    }

    pub fn cancel_exclusive_task(&self, handle: &str, domain: &str) -> Result<(), String> {
        self.exclusive_task_snapshot(handle, domain)?;
        self.cancel_task(handle)
    }

    /// Reserve a cooperative sign-out only while every unresolved writer is
    /// a known task of this exact live instance and credential identity.
    /// No RPC is performed and the admission mutex is released before return.
    pub fn reserve_mcp_cooperation(&self, target: &ledger::McpCredentialTarget) -> Result<McpCooperativeReservation, String> {
        if let Some(check) = &self.agent_dir_check { check(&self.agent_dir)?; }
        let mut admission = self.admission.try_lock().map_err(|_| "management admission busy")?;
        if admission.reservation.is_some() || admission.starting_instances != 0 { return Err("management admission busy".into()); }
        let state = self.state.try_lock().map_err(|_| "management instance busy")?;
        if state.closing || self.client.has_exited() { return Err("management instance is closing".into()); }
        if !target_key::ManagementTargetKey::inspect(&self.agent_dir)? { return Err("management target key is missing".into()); }
        let pending = ledger::OperationLedger::inspect(&self.agent_dir)?;
        if pending.is_empty() { return Err("no MCP operation requires cooperation".into()); }
        let mut guard_context: Option<(String, u64)> = None;
        let mut blockers = Vec::new();
        for record in &pending {
            if !matches!(record.operation.as_str(), "mcp.signInStart" | "mcp.test") || record.mcp_target.is_none() {
                return Err("unrelated or unidentified management outcome is unresolved".into());
            }
            let record_target = record.mcp_target.as_ref().expect("checked");
            let guard = state.tasks.values().find_map(|task| {
                let task = task.try_lock().ok()?;
                if task.ledger_operation_id.as_deref() != Some(record.operation_id.as_str())
                    || task.operation != record.operation || task.mcp_target.as_ref() != Some(record_target)
                    || task.finished_at.is_some() || !matches!(task.snapshot.status, TaskStatus::Running | TaskStatus::Unknown) { return None; }
                let guard = task.mcp_guard.as_ref()?;
                if guard.target != *record_target || guard.config_fingerprint.is_empty() || guard.generation > 9_007_199_254_740_991 { return None; }
                Some((guard.config_fingerprint.clone(), guard.generation))
            }).ok_or("MCP writer is not owned by this management instance")?;
            if !target.conflicts(record_target) { continue; }
            if target != record_target { return Err("MCP legacy credential alias is unresolved".into()); }
            blockers.push(record.operation_id.clone());
            match &mut guard_context {
                Some((config, generation)) if *config == guard.0 => *generation = (*generation).max(guard.1),
                Some(_) => return Err("MCP writer configuration changed".into()),
                None => guard_context = Some(guard),
            }
        }
        let (config_fingerprint, previous_generation) = guard_context.ok_or("MCP guard evidence is missing")?;
        let reservation_id = uuid::Uuid::new_v4();
        admission.reservation = Some(reservation_id);
        Ok(McpCooperativeReservation { admission: Arc::clone(&self.admission), reservation_id, instance_id: self.instance_id, target: target.clone(), config_fingerprint, previous_generation,
            state: Arc::clone(&self.state), client: Arc::clone(&self.client), agent_dir: self.agent_dir.clone(), agent_dir_check: self.agent_dir_check.clone(),
            blockers, known_pending: pending.into_iter().map(|record| record.operation_id).collect(),
            #[cfg(test)]
            fail_after: None })
    }

    /// Interpret only a nonce-routed terminal response for the named private
    /// cooperative operation. Config and canonical keys are compared in
    /// memory and are never included in the returned evidence or errors.
    pub fn verified_mcp_revocation(&self, handle: &str, expected_fingerprint: &str, expected_config_key: &str) -> Result<VerifiedMcpRevocation, String> {
        let state = self.state.lock().map_err(|_| "management state unavailable")?;
        let task = state.tasks.get(handle).ok_or("management task not found")?.lock().map_err(|_| "management task unavailable")?;
        if task.operation != "mcp.signOutCooperative" || task.snapshot.status != TaskStatus::Succeeded { return Err("MCP revocation is not confirmed".into()); }
        let result = task.snapshot.result.as_ref().ok_or("MCP revocation is not confirmed")?;
        let revocation = result.get("revocation").ok_or("MCP revocation is not confirmed")?;
        let canonical = revocation.get("canonicalKey").and_then(Value::as_str).ok_or("MCP revocation is not confirmed")?;
        let legacy = revocation.get("legacyKey").and_then(Value::as_str).ok_or("MCP revocation is not confirmed")?;
        let generation = revocation.get("generation").and_then(Value::as_u64).filter(|n| *n <= 9_007_199_254_740_991).ok_or("MCP revocation is not confirmed")?;
        if result.get("schema").and_then(Value::as_u64) != Some(1)
            || revocation.get("configKey").and_then(Value::as_str) != Some(expected_config_key)
            || target_key::ManagementTargetKey::load_or_create(&self.agent_dir)?.fingerprint(canonical)? != expected_fingerprint {
            return Err("MCP revocation identity mismatch".into());
        }
        let key = target_key::ManagementTargetKey::load_or_create(&self.agent_dir)?;
        let config_fingerprint = key.fingerprint(&format!("config:{expected_config_key}"))?;
        let legacy_fingerprint = key.fingerprint_legacy(legacy)?;
        Ok(VerifiedMcpRevocation { instance_id: self.instance_id, target_fingerprint: expected_fingerprint.to_string(), legacy_fingerprint, config_fingerprint, generation })
    }

    pub fn revocation_matches(&self, proof: &VerifiedMcpRevocation, target_fingerprint: &str) -> bool {
        proof.instance_id == self.instance_id && proof.target_fingerprint == target_fingerprint
    }

    pub fn task_writes_revoked(&self, handle: &str) -> bool {
        self.state.lock().ok().and_then(|state| state.tasks.get(handle).and_then(|task| task.lock().ok().map(|record| record.revoked))).unwrap_or(false)
    }

    pub fn task_snapshot(&self, handle: &str) -> Result<TaskSnapshot, String> {
        let state = self.state.lock().unwrap();
        let task = state.tasks.get(handle).ok_or("management task not found")?;
        let snapshot = task.lock().unwrap().snapshot.clone();
        Ok(snapshot)
    }

    pub fn cancel_task(&self, handle: &str) -> Result<(), String> {
        let (exclusive, runner) = {
            let state = self.state.lock().unwrap();
            let task = state.tasks.get(handle).ok_or("management task not found")?;
            let mut task = task.lock().unwrap();
            if task.finished_at.is_some() { return Err("management task is terminal".into()); }
            if task.snapshot.cancel_requested { return Ok(()); }
            task.snapshot.cancel_requested = true;
            if task.exclusive {
                task.snapshot.status = TaskStatus::Unknown;
                task.snapshot.error = Some("operation cancelled; outcome unknown".into());
            }
            (task.exclusive, task.runner.clone())
        };
        if exclusive {
            if let Some(runner) = runner { let _ = runner.force_stop(Duration::from_secs(5)); }
            Ok(())
        } else if let Some(runner) = runner { runner.send_cancel(handle) } else { self.send_cancel(handle) }
    }

    /// Deliver task-associated control input (e.g. OAuth code submission or
    /// interactive selection) directly to a running task. Verifies that the task
    /// belongs to this instance and is actively running. Rejects input if the target
    /// is missing, terminal, unknown, or has cancel requested, preventing arbitrary
    /// writes from bypassing unknown-outcome scope isolation. Input data is bounded
    /// to 4096 bytes.
    pub fn submit_task_input(&self, handle: &str, data: Value) -> Result<Value, String> {
        let task = {
            let state = self.state.lock().unwrap();
            if state.closing || self.client.has_exited() {
                return Err("management instance is closing".into());
            }
            let task = state.tasks.get(handle).ok_or("management task not found")?;
            let t = task.lock().unwrap();
            if t.finished_at.is_some() {
                return Err("management task is terminal".into());
            }
            if t.snapshot.status != TaskStatus::Running {
                return Err(format!("management task is not running: {:?}", t.snapshot.status));
            }
            if t.snapshot.cancel_requested {
                return Err("management task has cancel requested".into());
            }
            Arc::clone(task)
        };

        let data_bytes = serde_json::to_vec(&data).map_err(|e| format!("invalid task input payload: {e}"))?;
        if data_bytes.is_empty() || data_bytes.len() > 4096 {
            return Err("management task input must be non-empty and bounded to 4096 bytes".into());
        }

        let request_id = format!("input-{}", uuid::Uuid::new_v4());
        let (tx, rx) = std::sync::mpsc::channel();
        self.pending.lock().unwrap().insert(
            request_id.clone(),
            PendingTask {
                tx,
                task,
                nonce: self.nonce.clone(),
            },
        );

        let token = base64_url_no_pad(
            &json!({
                "op": "__input",
                "args": { "rid": handle, "data": data },
                "nonce": self.nonce
            })
            .to_string(),
        );

        let result = (|| -> Result<Value, String> {
            let ack = self
                .client
                .command(
                    "prompt",
                    json!({ "message": format!("/pi-web:mgmt {request_id} {token}") }),
                    Some(Duration::from_secs(10)),
                )
                .map_err(|e| format!("management input prompt failed: {e}"))?;
            if ack.get("disposition").and_then(Value::as_str) != Some("handled") {
                return Err("the management input command was not handled".to_string());
            }
            let until = Instant::now() + Duration::from_secs(10);
            loop {
                if Instant::now() >= until { return Err("management input outcome unknown: timed out".into()); }
                match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(envelope) => {
                        if envelope.get("nonce").and_then(Value::as_str) != Some(self.nonce.as_str()) {
                            return Err("the management envelope carried the wrong nonce".to_string());
                        }
                        if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
                            return Ok(envelope.get("result").cloned().unwrap_or(Value::Null));
                        } else {
                            let code = envelope.get("code").and_then(Value::as_str).unwrap_or("op_failed");
                            let error = envelope.get("error").and_then(Value::as_str).unwrap_or("unknown error");
                            return Err(format!("[{code}] {error}"));
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) if !self.client.has_exited() => continue,
                    Err(_) => return Err("management input outcome unknown: child exited".to_string()),
                }
            }
        })();

        self.pending.lock().unwrap().remove(&request_id);
        self.touch();
        result
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

    /// Stop a host-owned exclusive instance. A successful wait confirms only
    /// the leader's exit, not descendant cleanup or a mutation's outcome.
    #[cfg(unix)]
    pub fn force_stop(&self, limit: Duration) -> Result<(), String> {
        {
            let mut state = self.state.lock().unwrap();
            state.closing = true;
            for task in state.tasks.values() {
                let mut task = task.lock().unwrap();
                if task.finished_at.is_none() { task.snapshot.status = TaskStatus::Unknown; }
            }
        }
        if !self.client.force_kill() {
            return Err("management leader was already reaped; descendant state is unknown".into());
        }
        if self.client.wait_exit(Some(limit)) { Ok(()) } else { Err("management leader did not exit".into()) }
    }

    /// Windows requires a Job object to guarantee descendant cleanup.
    #[cfg(windows)]
    pub fn force_stop(&self, _limit: Duration) -> Result<(), String> {
        Err("exclusive management mutations are unsupported on Windows".into())
    }

    /// Session-file writers must prove an orderly exit, not a forced kill.
    fn close_session_file_writer(&self, grace: Duration) -> bool {
        self.client.close_without_kill(grace)
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
    agent_dir: Mutex<Option<PathBuf>>,
    agent_dir_check: Option<Arc<dyn Fn(&std::path::Path) -> Result<(), String> + Send + Sync>>,
    admission: Arc<Mutex<ManagementAdmission>>,
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
            agent_dir: Mutex::new(None),
            agent_dir_check: None,
            admission: Arc::new(Mutex::new(ManagementAdmission::default())),
        }
    }

    /// Bind management admission to the host's independently pinned agent directory.
    pub fn with_agent_dir_check(check: Arc<dyn Fn(&std::path::Path) -> Result<(), String> + Send + Sync>) -> Self {
        Self { agent_dir_check: Some(check), ..Self::new() }
    }

    /// The instance for a scope (`"global"` or a project cwd), started on
    /// demand. Concurrent calls for the same scope share ONE spawn.
    pub fn instance(
        &self,
        scope: &str,
        config: &ManagementSpawnConfig,
    ) -> Result<Arc<ManagementInstance>, String> {
        let agent_dir = config.agent_dir.as_ref().ok_or("management agent directory is not pinned")?;
        if let Some(check) = &self.agent_dir_check { check(agent_dir)?; }
        {
            let mut pinned = self.agent_dir.lock().map_err(|_| "management agent directory lock poisoned")?;
            if pinned.as_ref().is_some_and(|previous| previous != agent_dir) { return Err("management agent directory changed after admission".into()); }
            *pinned = Some(agent_dir.clone());
        }
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
        let starting = {
            let mut admission = self.admission.try_lock().map_err(|_| "management admission busy")?;
            if admission.reservation.is_some() { return Err("management cooperative reservation is active".into()); }
            admission.starting_instances += 1;
            StartingInstance(Arc::clone(&self.admission))
        };
        let instance = spawn_management(&scope, config, self.agent_dir_check.clone(), Arc::clone(&self.admission))?;
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
        drop(starting);
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
    } else if pending.get(rid).is_some_and(|entry| envelope.get("nonce").and_then(Value::as_str) == Some(entry.nonce.as_str())) {
        if let Some(entry) = pending.remove(rid) {
            let _ = entry.tx.send(envelope);
        }
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
    check: Option<Arc<dyn Fn(&std::path::Path) -> Result<(), String> + Send + Sync>>,
    admission: Arc<Mutex<ManagementAdmission>>,
) -> Result<Arc<ManagementInstance>, String> {
    spawn_management_with_environment(scope, config, false, check, admission)
}

/// Dedicated host-owned process for the synchronous session-file operations.
/// Caller must pin the management asset and module tree and hold the session gate.
/// These operation graphs must never spawn commands or detached children.
pub struct SessionFileWriter(Arc<ManagementInstance>);

impl SessionFileWriter {
    pub fn call(&self, op: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        if !matches!(op, "session.setOfflineChatUnlock" | "session.continueChat" | "session.forkStaged") {
            return Err("operation is not a session-file writer operation".into());
        }
        self.0.management_call(op, args, timeout)
    }
    pub fn pid(&self) -> u32 { self.0.client_pid() }
    pub fn close(&self, grace: Duration) -> bool { self.0.close_session_file_writer(grace) }
    pub fn force_stop(&self, grace: Duration) -> Result<(), String> { self.0.force_stop(grace) }
}

pub fn spawn_session_file_writer(config: &ManagementSpawnConfig) -> Result<SessionFileWriter, String> {
    if config.extensions.len() != 1 || config.agent_dir.is_none()
        || config.env.len() != 1 || config.env[0].0 != "PI_WEB_MANAGED_MODULES" {
        return Err("invalid session writer configuration".into());
    }
    spawn_management_with_environment("session-file-writer", config, true, None, Arc::new(Mutex::new(ManagementAdmission::default()))).map(SessionFileWriter)
}

fn spawn_management_with_environment(
    scope: &str,
    config: &ManagementSpawnConfig,
    restricted: bool,
    check: Option<Arc<dyn Fn(&std::path::Path) -> Result<(), String> + Send + Sync>>,
    admission: Arc<Mutex<ManagementAdmission>>,
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
    let mut env = if restricted {
        let mut env = EnvPolicy::empty();
        for key in ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "TEMP", "TMP"] {
            if let Ok(value) = std::env::var(key) { env = env.set(key, value); }
        }
        env
    } else { EnvPolicy::inherit() };
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
        instance_id: uuid::Uuid::new_v4(),
        agent_dir: config.agent_dir.clone().ok_or("management agent directory is not pinned")?,
        session_file_writer: restricted,
        agent_dir_check: check,
        admission,
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
        let task = || Arc::new(Mutex::new(TaskRecord { snapshot: TaskSnapshot { status: TaskStatus::Running, progress: None, result: None, error: None, cancel_requested: false }, finished_at: None, serial_scope: false, blocks_mutations: true, exclusive: false, operation: String::new(), ledger_operation_id: None, mcp_target: None, mcp_guard: None, revoked: false, runner: None }));
        let task_a = task();
        pending.lock().unwrap().insert("a".to_string(), PendingTask { tx: a_tx, task: Arc::clone(&task_a), nonce: "good".into() });
        pending.lock().unwrap().insert("b".to_string(), PendingTask { tx: b_tx, task: task(), nonce: "good".into() });
        for i in 0..1000 {
            route_envelope(&pending, &json!({"message": format!("PI_WEB_MGMT_PROGRESS_V1 {{\"rid\":\"a\",\"nonce\":\"good\",\"progress\":{i}}}")}));
        }
        route_envelope(&pending, &json!({"message": "PI_WEB_MGMT_PROGRESS_V1 {\"rid\":\"a\",\"nonce\":\"bad\",\"progress\":0}"}));
        assert_eq!(task_a.lock().unwrap().snapshot.progress, Some(json!(999)));
        route_envelope(&pending, &json!({"message": "PI_WEB_MGMT_V1 {\"rid\":\"b\",\"nonce\":\"bad\"}"}));
        assert!(b_rx.try_recv().is_err(), "wrong nonce must not consume the pending task");
        route_envelope(&pending, &json!({"message": "PI_WEB_MGMT_V1 {\"rid\":\"b\",\"nonce\":\"good\"}"}));
        route_envelope(&pending, &json!({"message": "PI_WEB_MGMT_V1 {\"rid\":\"a\",\"nonce\":\"good\"}"}));
        assert_eq!(a_rx.try_recv().unwrap()["nonce"], "good");
        assert_eq!(b_rx.try_recv().unwrap()["nonce"], "good");
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

