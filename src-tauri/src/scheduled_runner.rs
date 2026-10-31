//! One scheduled run on an already-started registry session. The caller owns
//! the durable run record and supplies its session-link transaction.
use serde_json::{json, Value};
use session_host::Session;
use std::time::{Duration, Instant};
use task_scheduler::task_repository::TaskRepository;
use crate::pi_ipc::{create_session, IpcHostState};

#[derive(Debug)]
pub struct RunOutcome {
    pub status: &'static str,
    pub error: Option<String>,
    pub error_code: Option<&'static str>,
    pub counts_as_failure: bool,
}

fn now_iso() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
    task_scheduler::store::ms_to_iso(ms)
}

fn new_run_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

fn failure(error: impl Into<String>) -> RunOutcome {
    RunOutcome { status: "failed", error: Some(error.into()), error_code: None, counts_as_failure: true }
}

/// Admit one manual run and return once its session is durably linked, or its
/// early failure is recorded. Never retries a prompt whose outcome is unknown.
pub fn run_now(state: &IpcHostState, task_id: &str) -> Result<Value, String> {
    let agent = state.agent_dir();
    let repo = TaskRepository::new(&agent);
    let task = repo.list()?.into_iter().find(|task| task["id"] == task_id).ok_or("Task not found")?;
    let run_id = new_run_id()?;
    let record = json!({ "runId": run_id, "taskId": task_id, "trigger": "manual", "startedAt": now_iso(), "status": "running", "pid": std::process::id() });
    repo.mutate_runs(task_id, |runs| {
        if runs.iter().any(|run| run["status"] == "running") { return Err("This task is already running".into()); }
        runs.push(record.clone());
        Ok(())
    })?;
    let names = match task["toolPreset"].as_str().unwrap_or("read-only") {
        "none" => vec![],
        "read-only" => vec!["read", "grep", "find", "ls"],
        "default" => vec!["read", "bash", "edit", "write"],
        "full" => vec!["bash", "read", "edit", "write", "grep", "find", "ls"],
        _ => { finish_run(&agent, task_id, &run_id, failure("Invalid task tool preset"))?; return Err("Invalid task tool preset".into()); }
    };
    let mut args = json!({ "cwd": task["cwd"], "type": "ensure_session", "toolNames": names });
    if task["model"].is_object() { args["provider"] = task["model"]["provider"].clone(); args["modelId"] = task["model"]["modelId"].clone(); }
    if task["thinkingLevel"].is_string() { args["thinkingLevel"] = task["thinkingLevel"].clone(); }
    let created = match create_session(state, &args) {
        Ok(value) => value,
        Err((_, message, _)) => { let outcome = failure(message); return finish_run(&agent, task_id, &run_id, outcome); }
    };
    let Some(session_id) = created["sessionId"].as_str() else {
        return finish_run(&agent, task_id, &run_id, failure("Session creation omitted id"));
    };
    let Some(session) = state.registry.get(session_id) else {
        return finish_run(&agent, task_id, &run_id, failure("Created session disappeared"));
    };
    let task_id = task_id.to_string();
    let prompt = task["prompt"].as_str().unwrap_or("").to_string();
    let duration = task["maxDurationMin"].as_u64().unwrap_or(30).clamp(1, 1440);
    let marker = json!({ "version": 1, "taskId": task_id, "runId": run_id, "taskName": task["name"], "trigger": "manual" });
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let thread_agent = agent.clone();
    let thread_task = task_id.clone();
    let thread_run = run_id.clone();
    let spawned = std::thread::Builder::new().name(format!("scheduled-run-{run_id}")).spawn(move || {
        let link_tx = ready_tx.clone();
        let outcome = run_session(&session, marker, &prompt, Duration::from_secs(duration * 60), |session_id| {
            let linked = TaskRepository::new(&thread_agent).mutate_runs(&thread_task, |runs| {
                let run = runs.iter_mut().find(|run| run["runId"] == thread_run).ok_or("Run not found")?;
                run["sessionId"] = json!(session_id);
                Ok(run.clone())
            })?;
            let _ = link_tx.send(Ok(linked));
            Ok(())
        });
        let finished = finish_run(&thread_agent, &thread_task, &thread_run, outcome);
        let _ = ready_tx.try_send(finished);
    });
    if let Err(error) = spawned {
        state.registry.remove(session_id, Duration::from_secs(5));
        return finish_run(&agent, &task_id, &run_id, failure(format!("failed to start scheduled runner: {error}")));
    }
    ready_rx.recv_timeout(Duration::from_secs(60)).map_err(|_| "scheduled run readiness timed out; its outcome may be unknown".to_string())?
}

fn finish_run(agent: &std::path::Path, task_id: &str, run_id: &str, outcome: RunOutcome) -> Result<Value, String> {
    let repo = TaskRepository::new(agent);
    let finished = repo.mutate_runs(task_id, |runs| {
        let run = runs.iter_mut().find(|run| run["runId"] == run_id).ok_or("Run not found")?;
        run["status"] = json!(outcome.status);
        run["endedAt"] = json!(now_iso());
        if let Some(error) = &outcome.error { run["error"] = json!(error); }
        if let Some(code) = outcome.error_code { run["errorCode"] = json!(code); }
        Ok(run.clone())
    })?;
    repo.mutate(|tasks| {
        if let Some(task) = tasks.iter_mut().find(|task| task["id"] == task_id) {
            if outcome.status == "succeeded" { task["consecutiveFailures"] = json!(0); }
            else if outcome.counts_as_failure {
                let failures = task["consecutiveFailures"].as_u64().unwrap_or(0) + 1;
                task["consecutiveFailures"] = json!(failures);
                if failures >= 5 && task["enabled"] == true {
                    task["enabled"] = json!(false);
                    task["autoPausedReason"] = json!(outcome.error.as_deref().unwrap_or("unknown error"));
                }
            }
        }
        Ok(())
    })?;
    Ok(finished)
}

/// The marker acknowledgement and durable session link are both required
/// before the first prompt. A failed link must never send an untracked run.
pub fn run_session(
    session: &Session,
    marker: Value,
    prompt: &str,
    limit: Duration,
    link_session: impl FnOnce(&str) -> Result<(), String>,
) -> RunOutcome {
    let name = marker["taskName"].as_str().unwrap_or("").to_string();
    let confirmed = match session.bridge_request("meta.scheduled-run", Some(marker), Some(Duration::from_secs(30))) {
        Ok(value) => value,
        Err(error) => return failure(format!("tagging the session as a scheduled run failed: {error}")),
    };
    if confirmed["entry"] != "scheduled-run" {
        return failure("the scheduled-run marker was not confirmed");
    }
    let (_, month, day, hour, minute, _) = crate::session_view::local_now_parts_pub();
    let title = format!("{name} · {month:02}-{day:02} {hour:02}:{minute:02}");
    let _ = session.command("set_session_name", json!({ "name": title }), Some(Duration::from_secs(10)));
    if let Err(error) = link_session(&session.id) { return failure(format!("recording the scheduled session failed: {error}")); }
    let (subscriber, events) = session.subscribe();
    let result = (|| {
        match session.command("prompt", json!({ "message": prompt }), Some(Duration::from_secs(120))) {
            Err(error) => {
                // A lost acknowledgement does not prove the prompt was rejected.
                // Abort rather than leaving a possibly running child behind.
                let _ = session.command("abort", json!({}), Some(Duration::from_secs(5)));
                return failure(error.to_string());
            }
            Ok(response) if matches!(response["disposition"].as_str(), Some("handled" | "queued")) => {
                return failure("scheduled prompt did not start a new run");
            }
            Ok(_) => {}
        }
        let deadline = Instant::now() + limit;
        let mut last_assistant = Value::Null;
        let mut timed_out = false;
        let mut end = deadline;
        loop {
            let now = Instant::now();
            if now >= end {
                if timed_out {
                    session.shutdown(Duration::from_secs(5));
                    return RunOutcome { status: "aborted", error: Some("Stopped after reaching the time limit".into()), error_code: Some("time-limit"), counts_as_failure: true };
                }
                timed_out = true;
                let _ = session.command("abort", json!({}), Some(Duration::from_secs(5)));
                end = Instant::now() + Duration::from_secs(30);
                continue;
            }
            match events.recv_timeout((end - now).min(Duration::from_secs(1))) {
                Ok(event) => {
                    match event["type"].as_str() {
                    Some("message_end") if event["message"]["role"] == "assistant" => last_assistant = event["message"].clone(),
                    Some("agent_settled") => {
                        if timed_out { return RunOutcome { status: "aborted", error: Some("Stopped after reaching the time limit".into()), error_code: Some("time-limit"), counts_as_failure: true }; }
                        return match last_assistant["stopReason"].as_str() {
                            Some("error") => failure(last_assistant["errorMessage"].as_str().unwrap_or("Model request failed")),
                            Some("aborted") => RunOutcome { status: "aborted", error: Some("Stopped by the user".into()), error_code: Some("stopped"), counts_as_failure: false },
                            None => failure("scheduled run settled without an assistant response"),
                            _ => RunOutcome { status: "succeeded", error: None, error_code: None, counts_as_failure: false },
                        };
                    }
                    _ => {}
                }
                },
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if session.wait_for_settle(u64::MAX, Duration::ZERO) == session_host::SettleOutcome::ChildExited {
                        return failure("pi process exited during the scheduled run");
                    }
                },
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return failure("pi process exited during the scheduled run"),
            }
        }
    })();
    session.unsubscribe(subscriber);
    result
}
