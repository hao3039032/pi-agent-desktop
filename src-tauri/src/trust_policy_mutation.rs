//! Trust writes are fenced until a fixed management task has actually finished.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use management_host::{ManagementInstance, TaskKind, TaskStatus};
use crate::pi_ipc::IpcHostState;

const WAIT: Duration = Duration::from_secs(60);
const MONITOR: Duration = Duration::from_secs(600);

fn within(root: &Path, candidate: &Path) -> bool {
    #[cfg(windows)]
    {
        let root = root.to_string_lossy().replace('\\', "/").to_lowercase();
        let root = root.trim_end_matches('/');
        let path = candidate.to_string_lossy().replace('\\', "/").to_lowercase();
        return path == root || path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'));
    }
    #[cfg(not(windows))]
    candidate.starts_with(root)
}

/// Called with policy write access, before creating the marker. A partial close
/// is safe but never authorizes the subsequent trust write.
pub(crate) fn close_affected_sessions(state: &IpcHostState, cwd: &Path) -> Result<(), String> {
    let root = std::fs::canonicalize(cwd).map_err(|_| "The project folder is no longer available".to_string())?;
    let mut ids = Vec::new();
    let sessions = state.registry.registered_sessions();
    for session in &sessions {
        let path = std::fs::canonicalize(&session.cwd).map_err(|_| "Cannot verify an open session's project folder".to_string())?;
        if within(&root, &path) { ids.push(session.id.clone()); }
    }
    let pending: Vec<_> = state.registry.pending_composer_session_ids().into_iter()
        .filter(|id| !sessions.iter().any(|session| &session.id == id)).collect();
    if pending.len() > 128 { return Err("Too many pending session queues to verify safely".into()); }
    if !pending.is_empty() {
        let index = session_host::history::scan_sessions(&state.agent_dir());
        if !index.skipped.is_empty() { return Err("Cannot verify all session headers for pending queues".into()); }
        let summaries: Vec<_> = index.projects.into_values().flatten().collect();
        for id in pending {
            let mut matches = summaries.iter().filter(|summary| summary.id == id);
            let summary = matches.next().ok_or("Cannot verify the project folder of a pending session queue")?;
            if matches.next().is_some() { return Err("Cannot verify a duplicated pending session id".into()); }
            let path = std::fs::canonicalize(&summary.cwd).map_err(|_| "Cannot verify the project folder of a pending session queue")?;
            if within(&root, &path) { return Err("An affected session has pending messages".into()); }
        }
    }
    ids.sort();
    if ids.len() > 128 { return Err("Too many affected sessions to verify safely".into()); }
    let deadline = Instant::now() + Duration::from_secs(20);
    state.registry.with_idle_session_writers(&ids, |sessions| {
        for session in sessions.iter().flatten() {
            let remaining = deadline.checked_duration_since(Instant::now()).ok_or("Session verification timed out")?;
            session.bridge_request("tree.assertIdle", None, Some(remaining.min(Duration::from_secs(5))))
                .map_err(|_| "Could not confirm that an affected session is idle".to_string())?;
        }
        Ok::<_, String>(())
    }).map_err(|error| match error {
        session_host::SessionWriterError::Busy(message) => message.to_string(),
        session_host::SessionWriterError::Operation(message) => message,
    })?;
    for id in ids {
        let remaining = deadline.checked_duration_since(Instant::now()).ok_or("Session shutdown timed out")?;
        state.registry.with_offline_session_writer(&id, remaining.min(Duration::from_secs(5)), || Ok::<_, String>(()))
            .map_err(|error| match error {
                session_host::SessionWriterError::Busy(message) => message.to_string(),
                session_host::SessionWriterError::Operation(message) => message,
            })?;
    }
    Ok(())
}

enum Resolution { Complete(Value), Pending(Value) }

fn reconcile(instance: &ManagementInstance, agent: &Path, cwd: &Path, operation: &str, result: Value) -> Result<Resolution, String> {
    let Some(attempted) = result.get("trustWriteAttempted").and_then(Value::as_bool) else { return Err("Invalid trust writer response; recovery is required".into()) };
    let result = result.get("result").cloned().ok_or("Invalid trust writer response; recovery is required")?;
    if !attempted {
        if result.get("mcpRefusal").is_some() || (operation == "trust.setFenced" && result.get("requiresTrust").is_some()) {
            return Ok(Resolution::Complete(result));
        }
        return Err("Invalid pre-write response; recovery is required".into());
    }
    if result.get("mcpRefusal").is_some() {
        let mut refusal = result;
        refusal["mcpRefusal"]["details"]["trustPolicyPending"] = json!(true);
        let message = refusal["mcpRefusal"]["message"].as_str().unwrap_or("Trust write failed");
        refusal["mcpRefusal"]["message"] = json!(format!("{message}; trust policy outcome is unresolved and recovery is required"));
        return Ok(Resolution::Pending(refusal));
    }
    if (operation == "mcp.trustFolderAdd" && result.get("trustedFolder").and_then(Value::as_bool) != Some(true))
        || (operation == "trust.setFenced" && result.get("decision").and_then(Value::as_bool) != Some(true)) {
        return Err("Trust write may have changed the trust file; recovery is required".into());
    }
    // The SDK reads its trust store under the same lock the writer uses.
    let status = instance.management_call_kind("trust.projectStatus", json!({"agentDir":agent, "cwd":cwd}), Duration::from_secs(30), TaskKind::ReadOnly)
        .map_err(|_| "Could not verify the completed trust write; recovery is required".to_string())?;
    if status.get("decision").and_then(Value::as_bool) != Some(true) {
        return Err("Trust decision does not match the completed write; recovery is required".into());
    }
    // The SDK writes trust.json in place. Flush it before durably removing the
    // fence so a successful response is not followed by a lost trust write.
    std::fs::File::open(agent.join("trust.json")).and_then(|file| file.sync_all())
        .and_then(|_| std::fs::File::open(agent).and_then(|dir| dir.sync_all()))
        .map_err(|_| "Could not durably verify the trust file; recovery is required".to_string())?;
    Ok(Resolution::Complete(result))
}

fn finish(instance: &ManagementInstance, agent: &Path, cwd: &Path, operation: &str, operation_id: &str, result: Value) -> Result<Value, String> {
    match reconcile(instance, agent, cwd, operation, result)? {
        Resolution::Pending(value) => Ok(value),
        Resolution::Complete(value) => {
            crate::trust_policy_fence::complete(agent, operation_id).map_err(|_| "Could not durably clear the trust policy fence; recovery may be required".to_string())?;
            Ok(value)
        }
    }
}

/// Caller holds the exclusive policy gate and has already closed affected
/// sessions. A timed-out task keeps its durable marker; a bounded monitor may
/// clear it only on the same task's confirmed result and SDK-locked recheck.
pub(crate) fn run(state: &IpcHostState, cwd: &Path, operation: &str, args: Value) -> Result<Value, String> {
    run_with_wait(state, cwd, operation, args, WAIT)
}

fn run_with_wait(state: &IpcHostState, cwd: &Path, operation: &str, args: Value, wait: Duration) -> Result<Value, String> {
    if !matches!(operation, "trust.setFenced" | "mcp.trustFolderAdd") { return Err("Unsupported trust writer".into()); }
    let agent = state.agent_dir();
    let config = state.management_config.lock().unwrap().clone().ok_or("Management instance is not configured")?;
    let instance = state.management.instance("global", &config).map_err(|_| "Management instance is unavailable")?;
    let operation_id = crate::scheduled_runner::new_run_id()?;
    crate::trust_policy_fence::begin(&agent, &operation_id, cwd).map_err(|error| format!("Could not establish the trust policy fence: {error}"))?;
    let handle = match instance.start_task(operation, args, MONITOR, TaskKind::Mutation) {
        Ok(handle) => handle,
        Err(error) => {
            crate::trust_policy_fence::complete(&agent, &operation_id).map_err(|_| "Could not clear an unstarted trust policy fence")?;
            return Err(error);
        }
    };
    let deadline = Instant::now() + wait;
    loop {
        let snapshot = instance.task_snapshot(&handle).map_err(|_| "Trust writer outcome is unknown; recovery is required")?;
        match snapshot.status {
            TaskStatus::Succeeded => return finish(&instance, &agent, cwd, operation, &operation_id, snapshot.result.unwrap_or(Value::Null)),
            TaskStatus::Failed | TaskStatus::Cancelled => return Err("Trust writer failed; its outcome is unresolved and recovery is required".into()),
            TaskStatus::Running | TaskStatus::Unknown => {}
        }
        if Instant::now() >= deadline {
            monitor(instance, state.policy_gate.clone(), agent, cwd.to_path_buf(), operation.to_string(), operation_id, handle);
            return Err("Trust writer outcome is unknown; session admission is blocked until reconciliation or recovery".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn monitor(instance: Arc<ManagementInstance>, gate: Arc<std::sync::RwLock<()>>, agent: PathBuf, cwd: PathBuf, operation: String, operation_id: String, handle: String) {
    let _ = std::thread::Builder::new().name("trust-policy-reconcile".into()).spawn(move || {
        let deadline = Instant::now() + MONITOR;
        while Instant::now() < deadline {
            let Ok(snapshot) = instance.task_snapshot(&handle) else { return };
            match snapshot.status {
                TaskStatus::Succeeded => {
                    if let Ok(_policy) = gate.try_write() {
                        let _ = finish(&instance, &agent, &cwd, &operation, &operation_id, snapshot.result.unwrap_or(Value::Null));
                        return;
                    }
                }
                TaskStatus::Failed | TaskStatus::Cancelled => return,
                TaskStatus::Running | TaskStatus::Unknown => {}
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::pi_ipc::{create_session, dispatch_with_resume};

    #[test]
    fn timed_out_writer_stays_fenced_until_confirmed_and_partial_failure_stays_fenced() {
        let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|s| !s.is_empty()) else { return };
        let root = tempfile::tempdir().unwrap();
        let agent = root.path().join("agent");
        let cwd = root.path().join("project");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let state = IpcHostState::new();
        *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
        *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
            executable, agent_dir: Some(agent.clone()),
            extensions: vec![Path::new("../scripts/migration/trust-policy-fault-fixture.mjs").canonicalize().unwrap()],
            env: vec![("HOME".into(), root.path().display().to_string())],
        });
        let policy = state.policy_gate.try_write().unwrap();
        let result = run_with_wait(&state, &cwd, "trust.setFenced", json!({"agentDir":agent,"cwd":cwd}), Duration::from_millis(100));
        assert!(result.unwrap_err().contains("unknown"));
        assert!(crate::trust_policy_fence::is_pending(&agent));
        drop(policy);
        let restarted = IpcHostState::new();
        *restarted.task_agent_dir.lock().unwrap() = Some(agent.clone());
        assert_eq!(create_session(&restarted, &json!({"cwd":cwd,"type":"ensure_session"})).unwrap_err().0, "busy");
        assert_eq!(dispatch_with_resume(&restarted, "agent.command", &json!({"session":"old","type":"prompt","message":"no"})).unwrap_err().0, "busy");
        let until = Instant::now() + Duration::from_secs(8);
        while crate::trust_policy_fence::is_pending(&agent) && Instant::now() < until { std::thread::sleep(Duration::from_millis(25)); }
        assert!(!crate::trust_policy_fence::is_pending(&agent), "only the confirmed same task may release the fence");
        let policy = state.policy_gate.try_write().unwrap();
        let result = run_with_wait(&state, &cwd, "trust.setFenced", json!({"agentDir":agent,"cwd":cwd,"fail":true}), Duration::from_millis(100));
        assert!(result.unwrap_err().contains("unknown"));
        drop(policy);
        std::thread::sleep(Duration::from_secs(1));
        assert_eq!(std::fs::read_to_string(agent.join("trust.json")).unwrap(), "{partial");
        assert!(crate::trust_policy_fence::is_pending(&agent), "partial failed write must remain fenced");
        let after_failure = IpcHostState::new();
        *after_failure.task_agent_dir.lock().unwrap() = Some(agent.clone());
        assert_eq!(create_session(&after_failure, &json!({"cwd":cwd,"type":"ensure_session"})).unwrap_err().0, "busy");
        state.management.shutdown_all(Duration::from_secs(5));

        let agent2 = root.path().join("other-agent");
        std::fs::create_dir_all(&agent2).unwrap();
        let second = IpcHostState::new();
        *second.task_agent_dir.lock().unwrap() = Some(agent2.clone());
        let mut config = state.management_config.lock().unwrap().clone().unwrap();
        config.agent_dir = Some(agent2.clone());
        *second.management_config.lock().unwrap() = Some(config);
        let policy = second.policy_gate.try_write().unwrap();
        let refused = run_with_wait(&second, &cwd, "trust.setFenced", json!({"agentDir":agent2,"cwd":cwd,"fail":"refusal"}), Duration::from_secs(3)).unwrap();
        assert_eq!(refused["mcpRefusal"]["reason"], "trust-unreadable");
        assert_eq!(refused["mcpRefusal"]["details"]["name"], "fixture");
        assert_eq!(refused["mcpRefusal"]["details"]["trustPolicyPending"], true);
        assert!(crate::trust_policy_fence::is_pending(&agent2));
        drop(policy);
        second.management.shutdown_all(Duration::from_secs(5));

        let agent3 = root.path().join("mismatched-agent");
        std::fs::create_dir_all(&agent3).unwrap();
        let third = IpcHostState::new();
        *third.task_agent_dir.lock().unwrap() = Some(agent3.clone());
        let mut config = state.management_config.lock().unwrap().clone().unwrap();
        config.agent_dir = Some(agent3.clone());
        *third.management_config.lock().unwrap() = Some(config);
        let policy = third.policy_gate.try_write().unwrap();
        let error = run_with_wait(&third, &cwd, "trust.setFenced", json!({"agentDir":agent3,"cwd":cwd,"mismatch":true}), Duration::from_secs(3)).unwrap_err();
        assert!(error.contains("does not match"), "{error}");
        assert!(crate::trust_policy_fence::is_pending(&agent3), "a mismatched recheck must stay fenced");
        drop(policy);
        third.management.shutdown_all(Duration::from_secs(5));
    }
}
