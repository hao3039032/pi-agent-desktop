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
pub struct ManagementInstance {
    pub scope: String,
    client: Arc<PiRpcClient>,
    state: Mutex<InstanceState>,
    /// The management protocol nonce this child was spawned with. The HOST
    /// generates it at spawn (never accepted from the caller): a caller-
    /// supplied nonce — or worse, an empty one — would let a forged envelope
    /// from anywhere in the child bind to the management protocol.
    nonce: String,
    pending: Arc<Mutex<HashMap<String, std::sync::mpsc::Sender<Value>>>>,
    _notify_subscription: pi_host::client::UiSubscription,
}

struct InstanceState {
    lease_until: Instant,
    last_used: Instant,
    active: usize,
    closing: bool,
}

struct Activity<'a>(&'a ManagementInstance);

impl Drop for Activity<'_> {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
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
        use std::sync::mpsc;
        let _activity = self.admit()?;
        let nonce = self.nonce.clone();
        let request_id = format!("call-{}", uuid::Uuid::new_v4());
        let payload = json!({ "op": op, "args": args, "nonce": nonce });
        let token = base64_url_no_pad(&payload.to_string());

        let (envelope_tx, envelope_rx) = mpsc::channel::<Value>();
        self.pending.lock().unwrap().insert(request_id.clone(), envelope_tx);

        let result = (|| -> Result<Value, String> {
            let ack = self
                .client
                .command("prompt", json!({ "message": format!("/pi-web:mgmt {request_id} {token}") }), Some(timeout + Duration::from_secs(10)))
                .map_err(|error| format!("management prompt failed: {error}"))?;
            if ack.get("disposition").and_then(Value::as_str) != Some("handled") {
                return Err("the management command was not handled (extension missing?)".to_string());
            }
            match envelope_rx.recv_timeout(timeout) {
                Ok(envelope) => {
                    if envelope.get("nonce").and_then(Value::as_str) != Some(nonce.as_str()) {
                        return Err("the management envelope carried the wrong nonce".to_string());
                    }
                    if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
                        Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        let code = envelope.get("code").and_then(Value::as_str).unwrap_or("op_failed");
                        let error = envelope.get("error").and_then(Value::as_str).unwrap_or("unknown error");
                        Err(format!("[{code}] {error}"))
                    }
                }
                Err(_) => Err(format!("management op {op} timed out")),
            }
        })();
        self.pending.lock().unwrap().remove(&request_id);
        self.touch();
        result
    }

    fn admit(&self) -> Result<Activity<'_>, String> {
        let mut state = self.state.lock().unwrap();
        if state.closing || self.client.has_exited() {
            return Err("management instance is closing".into());
        }
        state.active += 1;
        Ok(Activity(self))
    }

    fn retire_if_expired(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        if self.client.has_exited() || (!state.closing && state.active == 0 && state.lease_until <= Instant::now()) {
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
        self.client.has_exited() || state.closing || (state.active == 0 && state.lease_until <= Instant::now())
    }

    /// Provider/model enumeration: the child's own registry, which includes
    /// extension-registered providers (M0-verified semantics).
    pub fn available_models(
        &self,
    ) -> Result<Value, pi_host::PiRpcError> {
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
        let result = self.client.command("prompt", json!({ "message": message }), Some(timeout))?;
        self.touch();
        Ok(result)
    }

    /// Orderly shutdown.
    pub fn shutdown(&self, grace: Duration) -> Option<i32> {
        self.state.lock().unwrap().closing = true;
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
            for instance in instances.values() { instance.state.lock().unwrap().closing = true; }
            instances.drain().map(|(_, value)| value).collect()
        };
        for instance in instances {
            instance.shutdown(grace);
        }
    }
}

fn route_envelope(
    pending: &Mutex<HashMap<String, std::sync::mpsc::Sender<Value>>>,
    record: &Value,
) {
    let Some(body) = record.get("message").and_then(Value::as_str)
        .and_then(|message| message.strip_prefix("PI_WEB_MGMT_V1 ")) else { return };
    let Ok(envelope) = serde_json::from_str::<Value>(body) else { return };
    let Some(rid) = envelope.get("rid").and_then(Value::as_str) else { return };
    if let Some(sender) = pending.lock().unwrap().get(rid) {
        let _ = sender.send(envelope.clone());
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
    let (notify_tx, notify_rx) = std::sync::mpsc::channel::<pi_host::client::UiRequest>();
    let notify_subscription = client.on_ui("notify", notify_tx, None);
    let router_pending = Arc::clone(&pending);
    std::thread::Builder::new()
        .name("mgmt-notify-router".into())
        .spawn(move || {
            while let Ok(request) = notify_rx.recv() {
                route_envelope(&router_pending, &request.record);
            }
        })
        .map_err(|error| format!("envelope router failed: {error}"))?;
    Ok(Arc::new(ManagementInstance {
        scope: scope.to_string(),
        nonce,
        client,
        pending,
        _notify_subscription: notify_subscription,
        state: Mutex::new(InstanceState {
            lease_until: Instant::now() + IDLE_RECYCLE,
            last_used: Instant::now(),
            active: 0,
            closing: false,
        }),
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
        pending.lock().unwrap().insert("a".to_string(), a_tx);
        pending.lock().unwrap().insert("b".to_string(), b_tx);
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

