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
}

struct InstanceState {
    lease_until: Instant,
    last_used: Instant,
}

impl ManagementInstance {
    /// Take the lease (a login/install/test is running).
    pub fn lease(&self) {
        let mut state = self.state.lock().unwrap();
        state.lease_until = Instant::now() + IDLE_RECYCLE;
    }

    /// Whether this instance should be recycled now.
    pub fn is_expired(&self) -> bool {
        self.state.lock().unwrap().lease_until <= Instant::now() || self.client.has_exited()
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
}

impl Default for ManagementHost {
    fn default() -> Self {
        Self::new()
    }
}

impl ManagementHost {
    pub fn new() -> Self {
        Self { instances: Mutex::new(HashMap::new()) }
    }

    /// The instance for a scope (`"global"` or a project cwd), started on
    /// demand. Concurrent acquisition is serialized per scope by the map
    /// lock; the spawn happens outside it.
    pub fn instance(
        &self,
        scope: &str,
        config: &ManagementSpawnConfig,
    ) -> Result<Arc<ManagementInstance>, String> {
        {
            let instances = self.instances.lock().unwrap();
            if let Some(existing) = instances.get(scope) {
                if !existing.is_expired() {
                    return Ok(Arc::clone(existing));
                }
            }
        }
        let instance = spawn_management(scope, config)?;
        self.instances
            .lock()
            .unwrap()
            .insert(scope.to_string(), Arc::clone(&instance));
        Ok(instance)
    }

    /// Recycle expired instances; returns the recycled scopes.
    pub fn recycle_expired(&self) -> Vec<String> {
        let expired: Vec<String> = {
            let instances = self.instances.lock().unwrap();
            instances
                .iter()
                .filter(|(_, instance)| instance.is_expired())
                .map(|(scope, _)| scope.clone())
                .collect()
        };
        for scope in &expired {
            if let Some(instance) = self.instances.lock().unwrap().remove(scope) {
                instance.shutdown(Duration::from_secs(5));
            }
        }
        expired
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
    let mut env = EnvPolicy::inherit();
    if let Some(agent_dir) = &config.agent_dir {
        env = env.set("PI_CODING_AGENT_DIR", agent_dir.to_string_lossy().into_owned());
    }
    for (key, value) in &config.env {
        env = env.set(key, value.clone());
    }
    let client = PiRpcClient::spawn(
        &config.executable,
        SpawnOptions { args, cwd: None, env, ..SpawnOptions::default() },
    )
    .map_err(|error| format!("management instance failed to start: {error}"))?;
    Ok(Arc::new(ManagementInstance {
        scope: scope.to_string(),
        client,
        state: Mutex::new(InstanceState {
            lease_until: Instant::now() + IDLE_RECYCLE,
            last_used: Instant::now(),
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
        let instances: Vec<Arc<ManagementInstance>> =
            self.instances.lock().unwrap().drain().map(|(_, value)| value).collect();
        for instance in instances {
            instance.shutdown(Duration::from_secs(5));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

        // Recycle: expire the project instance; global holds via lease.
        project.expire_for_tests();
        global.lease();
        let recycled = host.recycle_expired();
        assert_eq!(recycled, vec!["/tmp/some-project".to_string()]);
        assert_eq!(host.scopes(), vec!["global".to_string()]);
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

