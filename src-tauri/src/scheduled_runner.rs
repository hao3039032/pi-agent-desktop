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
    pub error_params: Option<Value>,
    pub counts_as_failure: bool,
    /// Request attribution is separate from the persisted display status.
    pub prompt_result: PromptResult,
    /// Leader lifetime is separate from both prompt and ledger results.
    pub controlled_writer: ControlledWriter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptResult { NotSubmitted, Unknown, Uncorrelated }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlledWriter { NotStarted, Unconfirmed }

pub(crate) fn now_iso() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
    task_scheduler::store::ms_to_iso(ms)
}

pub(crate) fn new_run_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..]))
}

fn failure(error: impl Into<String>) -> RunOutcome {
    RunOutcome { status: "failed", error: Some(error.into()), error_code: None, error_params: None, counts_as_failure: true,
        prompt_result: PromptResult::NotSubmitted, controlled_writer: ControlledWriter::NotStarted }
}

/// Admit one manual run and return once its session is durably linked, or its
/// early failure is recorded. Never retries a prompt whose outcome is unknown.
pub fn run_now(state: &IpcHostState, task_id: &str) -> Result<Value, String> {
    let run_id = new_run_id()?;
    let mut tracking = state.scheduled_lifecycle.admit(&run_id).map_err(str::to_string)?;
    let lifecycle = state.scheduler_lifecycle.lock().unwrap();
    if !state.scheduler_owner.load(std::sync::atomic::Ordering::SeqCst) || state.scheduled_lifecycle.is_closing() { return Err("Scheduler is not the owner".into()); }
    let agent = state.agent_dir();
    let repo = TaskRepository::new(&agent);
    let task = repo.list()?.into_iter().find(|task| task["id"] == task_id).ok_or("Task not found")?;
    let record = json!({ "runId": run_id, "taskId": task_id, "trigger": "manual", "startedAt": now_iso(), "status": "running", "pid": std::process::id() });
    let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as i64;
    state.scheduled_active.lock().unwrap().insert(run_id.clone());
    tracking.claimed();
    if let Err(error) = repo.admit_manual(task_id, &task, record.clone(), now_ms, std::process::id()) {
        state.scheduled_active.lock().unwrap().remove(&run_id);
        // These repository rejections precede its write. I/O errors may
        // follow a partial write and remain unresolved instead.
        if matches!(error.as_str(), "Invalid task id" | "Scheduler is not the owner" | "Task not found" | "Task changed during run admission; reload before retrying" | "This task is already running")
            || error.starts_with("scheduler transaction busy:") { tracking.resolved(); }
        return Err(error);
    }
    drop(lifecycle);
    spawn_claimed(state, task, record, tracking)
}

pub(crate) fn spawn_claimed(state: &IpcHostState, task: Value, record: Value, mut tracking: crate::scheduled_lifecycle::ScheduledRunGuard) -> Result<Value, String> {
    struct ActiveGuard { active: std::sync::Arc<std::sync::Mutex<std::collections::BTreeSet<String>>>, run_id: String }
    impl Drop for ActiveGuard { fn drop(&mut self) { self.active.lock().unwrap().remove(&self.run_id); } }
    let agent = state.agent_dir();
    let task_id = record["taskId"].as_str().ok_or("Run missing task id")?;
    let run_id = record["runId"].as_str().ok_or("Run missing id")?.to_string();
    state.scheduled_active.lock().unwrap().insert(run_id.clone());
    let guard = ActiveGuard { active: std::sync::Arc::clone(&state.scheduled_active), run_id: run_id.clone() };
    let trigger = record["trigger"].as_str().ok_or("Run missing trigger")?.to_string();
    let cwd = task["cwd"].as_str().unwrap_or("");
    if !std::path::Path::new(cwd).is_dir() {
        let result = finish_early(state, &agent, &task, &record, RunOutcome {
            status: "failed", error: Some(format!("Directory does not exist: {cwd}")), error_code: Some("cwd-missing"),
            error_params: Some(json!({ "path": cwd })), counts_as_failure: true,
            prompt_result: PromptResult::NotSubmitted, controlled_writer: ControlledWriter::NotStarted,
        });
        if result.is_ok() { tracking.resolved(); }
        return result;
    }
    let names = match task["toolPreset"].as_str().unwrap_or("read-only") {
        "none" => vec![],
        "read-only" => vec!["read", "grep", "find", "ls"],
        "default" => vec!["read", "bash", "edit", "write"],
        "full" => vec!["bash", "read", "edit", "write", "grep", "find", "ls"],
        _ => {
            let result = finish_early(state, &agent, &task, &record, failure("Invalid task tool preset"));
            if result.is_ok() { tracking.resolved(); }
            return result;
        },
    };
    let mut args = json!({ "cwd": task["cwd"], "type": "ensure_session", "toolNames": names });
    if task["model"].is_object() { args["provider"] = task["model"]["provider"].clone(); args["modelId"] = task["model"]["modelId"].clone(); }
    if task["thinkingLevel"].is_string() { args["thinkingLevel"] = task["thinkingLevel"].clone(); }
    let created = match create_session(state, &args) {
        Ok(value) => value,
        Err((_, message, _)) => return finish_early(state, &agent, &task, &record, failure(message)),
    };
    let Some(session_id) = created["sessionId"].as_str() else {
        return finish_early(state, &agent, &task, &record, failure("Session creation omitted id"));
    };
    let Some(session) = state.registry.get(session_id) else {
        return finish_early(state, &agent, &task, &record, failure("Created session disappeared"));
    };
    tracking.set_session(session_id).map_err(str::to_string)?;
    let task_id = task_id.to_string();
    let prompt = task["prompt"].as_str().unwrap_or("").to_string();
    let duration = task["maxDurationMin"].as_u64().unwrap_or(30).clamp(1, 1440);
    let mut marker = json!({ "version": 1, "taskId": task_id, "runId": run_id, "taskName": task["name"], "trigger": trigger });
    if record["scheduledFor"].is_string() { marker["scheduledFor"] = record["scheduledFor"].clone(); }
    let record_session = session.id.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let thread_agent = agent.clone();
    let thread_task = task_id.clone();
    let thread_run = run_id.clone();
    let events = std::sync::Arc::clone(&state.scheduled_events);
    let task_name = task["name"].as_str().unwrap_or("").to_string();
    let spawned = std::thread::Builder::new().name(format!("scheduled-run-{run_id}")).spawn(move || {
        let _guard = guard;
        let mut tracking = tracking;
        let link_tx = ready_tx.clone();
        let attention_events = std::sync::Arc::clone(&events);
        let outcome = run_session(&session, marker, &prompt, Duration::from_secs(duration * 60), |session_id| {
            let linked = TaskRepository::new(&thread_agent).mutate_runs(&thread_task, |runs| {
                let run = runs.iter_mut().find(|run| run["runId"] == thread_run).ok_or("Run not found")?;
                run["sessionId"] = json!(session_id);
                Ok(run.clone())
            })?;
            events.emit(json!({ "type": "run_started", "taskId": thread_task, "taskName": task_name, "runId": thread_run, "sessionId": session_id, "trigger": trigger }));
            events.emit(json!({ "type": "task_changed", "taskId": thread_task }));
            let _ = link_tx.send(Ok(linked));
            Ok(())
        }, || {
            attention_events.emit(json!({ "type": "run_attention", "taskId": thread_task, "taskName": task_name, "runId": thread_run, "sessionId": session.id }));
        });
        // Even a marker refusal produced a real session. Keep the history
        // link so that failed setup cannot leak it into the project tree.
        if outcome.status == "failed" {
            if let Err(error) = TaskRepository::new(&thread_agent).mutate_runs(&thread_task, |runs| {
                let run = runs.iter_mut().find(|run| run["runId"] == thread_run).ok_or("Run not found")?;
                if run.get("sessionId").is_none() { run["sessionId"] = json!(session.id); }
                Ok(())
            }) {
                let _ = ready_tx.try_send(Err(format!("recording failed session link: {error}")));
                return;
            }
        }
        let status = outcome.status;
        let error = outcome.error.clone();
        let error_code = outcome.error_code;
        let error_params = outcome.error_params.clone();
        let finished = finish_tracked_run(&thread_agent, &thread_task, &thread_run, outcome, &mut tracking);
        if let Ok((run, auto_paused)) = &finished {
            let mut event = json!({ "type": "run_finished", "taskId": thread_task, "taskName": task_name, "runId": thread_run, "trigger": trigger, "status": status });
            if run["sessionId"].is_string() { event["sessionId"] = run["sessionId"].clone(); }
            if let Some(error) = error { event["error"] = json!(error); }
            if let Some(code) = error_code { event["errorCode"] = json!(code); }
            if let Some(params) = error_params { event["errorParams"] = params; }
            if *auto_paused { event["autoPaused"] = json!(true); }
            events.emit(event);
            events.emit(json!({ "type": "task_changed", "taskId": thread_task }));
        }
        let _ = ready_tx.try_send(finished.map(|(run, _)| run));
    });
    if let Err(error) = spawned {
        state.registry.remove(session_id, Duration::from_secs(5));
        TaskRepository::new(&agent).mutate_runs(&task_id, |runs| {
            let run = runs.iter_mut().find(|run| run["runId"] == run_id).ok_or("Run not found")?;
            run["sessionId"] = json!(record_session);
            Ok(())
        })?;
        return finish_early(state, &agent, &task, &record, failure(format!("failed to start scheduled runner: {error}")));
    }
    ready_rx.recv_timeout(Duration::from_secs(60)).map_err(|_| "scheduled run readiness timed out; its outcome may be unknown".to_string())?
}

pub(crate) fn fail_claimed(state: &IpcHostState, task: &Value, record: &Value, message: String) -> Result<Value, String> {
    finish_early(state, &state.agent_dir(), task, record, failure(message))
}

fn finish_early(state: &IpcHostState, agent: &std::path::Path, task: &Value, record: &Value, outcome: RunOutcome) -> Result<Value, String> {
    let task_id = task["id"].as_str().ok_or("Invalid task id")?;
    let run_id = record["runId"].as_str().ok_or("Run missing id")?;
    let status = outcome.status;
    let error = outcome.error.clone();
    let error_code = outcome.error_code;
    let error_params = outcome.error_params.clone();
    let (run, auto_paused) = finish_run(agent, task_id, run_id, outcome)?;
    let mut event = json!({ "type": "run_finished", "taskId": task_id, "taskName": task["name"], "runId": run_id, "trigger": record["trigger"], "status": status });
    if let Some(error) = error { event["error"] = json!(error); }
    if let Some(code) = error_code { event["errorCode"] = json!(code); }
    if let Some(params) = error_params { event["errorParams"] = params; }
    if auto_paused { event["autoPaused"] = json!(true); }
    state.scheduled_events.emit(event);
    state.scheduled_events.emit(json!({ "type": "task_changed", "taskId": task_id }));
    Ok(run)
}

fn finish_tracked_run(agent: &std::path::Path, task_id: &str, run_id: &str, outcome: RunOutcome, tracking: &mut crate::scheduled_lifecycle::ScheduledRunGuard) -> Result<(Value, bool), String> {
    let prompt = outcome.prompt_result;
    let writer = outcome.controlled_writer;
    let finished = finish_run(agent, task_id, run_id, outcome);
    if finished.is_ok() && prompt == PromptResult::NotSubmitted && writer == ControlledWriter::NotStarted {
        tracking.resolved();
    } else {
        tracking.record_outcome(finished.is_ok(), format!("{prompt:?}"), format!("{writer:?}"));
    }
    finished
}

fn finish_run(agent: &std::path::Path, task_id: &str, run_id: &str, outcome: RunOutcome) -> Result<(Value, bool), String> {
    let repo = TaskRepository::new(agent);
    let finished = repo.mutate_runs(task_id, |runs| {
        let run = runs.iter_mut().find(|run| run["runId"] == run_id).ok_or("Run not found")?;
        run["status"] = json!(outcome.status);
        run["endedAt"] = json!(now_iso());
        if let Some(error) = &outcome.error { run["error"] = json!(error); }
        if let Some(code) = outcome.error_code { run["errorCode"] = json!(code); }
        if let Some(params) = &outcome.error_params { run["errorParams"] = params.clone(); }
        Ok(run.clone())
    })?;
    let mut auto_paused = false;
    repo.mutate(|tasks| {
        if let Some(task) = tasks.iter_mut().find(|task| task["id"] == task_id) {
            if outcome.status == "succeeded" { task["consecutiveFailures"] = json!(0); }
            else if outcome.counts_as_failure {
                let failures = task["consecutiveFailures"].as_u64().unwrap_or(0) + 1;
                task["consecutiveFailures"] = json!(failures);
                if failures >= 5 && task["enabled"] == true {
                    auto_paused = true;
                    task["enabled"] = json!(false);
                    task["autoPausedReason"] = json!(outcome.error.as_deref().unwrap_or("unknown error"));
                }
            }
        }
        Ok(())
    })?;
    Ok((finished, auto_paused))
}

/// The marker acknowledgement and durable session link are both required
/// before the first prompt. A failed link must never send an untracked run.
pub fn run_session(
    session: &Session,
    marker: Value,
    prompt: &str,
    limit: Duration,
    link_session: impl FnOnce(&str) -> Result<(), String>,
    on_attention: impl FnMut(),
) -> RunOutcome {
    run_session_with_timeouts(session, marker, prompt, limit, link_session, on_attention, Duration::from_secs(120), Duration::from_secs(5))
}

fn run_session_with_timeouts(
    session: &Session, marker: Value, prompt: &str, limit: Duration,
    link_session: impl FnOnce(&str) -> Result<(), String>, mut on_attention: impl FnMut(),
    prompt_timeout: Duration, abort_timeout: Duration,
) -> RunOutcome {
    let mut outcome = run_session_inner(session, marker, prompt, limit, link_session, &mut on_attention, prompt_timeout, abort_timeout);
    // A command response or ledger write does not prove this leader stopped.
    outcome.controlled_writer = ControlledWriter::Unconfirmed;
    outcome
}

fn run_session_inner(
    session: &Session, marker: Value, prompt: &str, limit: Duration,
    link_session: impl FnOnce(&str) -> Result<(), String>, mut on_attention: impl FnMut(),
    prompt_timeout: Duration, abort_timeout: Duration,
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
    let mut prompt_result = PromptResult::Unknown;
    let mut result = (|| {
        match session.command("prompt", json!({ "message": prompt }), Some(prompt_timeout)) {
            Err(error) => {
                // A lost acknowledgement does not prove the prompt was rejected.
                // Abort rather than leaving a possibly running child behind.
                let _ = session.command("abort", json!({}), Some(abort_timeout));
                return failure(error.to_string());
            }
            Ok(response) if matches!(response["disposition"].as_str(), Some("handled" | "queued")) => {
                return failure("scheduled prompt did not start a new run");
            }
            Ok(response) => {
                if response["disposition"] == "started" { prompt_result = PromptResult::Uncorrelated; }
            }
        }
        let deadline = Instant::now() + limit;
        let mut last_assistant = Value::Null;
        let mut prompt_error: Option<String> = None;
        let mut attention_ids = std::collections::HashSet::new();
        let mut timed_out = false;
        let mut end = deadline;
        loop {
            let now = Instant::now();
            if now >= end {
                if timed_out {
                    session.shutdown(Duration::from_secs(5));
                    return RunOutcome { status: "aborted", error: Some(format!("Stopped after reaching the {} minute limit", limit.as_secs() / 60)), error_code: Some("time-limit"), error_params: Some(json!({ "minutes": limit.as_secs() / 60 })), counts_as_failure: true, prompt_result: PromptResult::Unknown, controlled_writer: ControlledWriter::Unconfirmed };
                }
                timed_out = true;
                let _ = session.command("abort", json!({}), Some(abort_timeout));
                end = Instant::now() + Duration::from_secs(30);
                continue;
            }
            match events.recv_timeout((end - now).min(Duration::from_secs(1))) {
                Ok(event) => {
                    match event["type"].as_str() {
                    Some("extension_ui_request") if matches!(event["method"].as_str(), Some("select" | "confirm" | "input" | "editor"))
                        || (event["type"] == "extension_ui_request" && event["method"] == "custom" && event["closed"] != true) => {
                        if let Some(id) = event["id"].as_str() {
                            if attention_ids.insert(id.to_string()) { on_attention(); }
                        }
                    }
                    Some("message_end") if event["message"]["role"] == "assistant" => last_assistant = event["message"].clone(),
                    Some("prompt_error") => prompt_error = Some(event["errorMessage"].as_str().unwrap_or("Prompt failed").to_string()),
                    Some("agent_settled") => {
                        if timed_out { return RunOutcome { status: "aborted", error: Some(format!("Stopped after reaching the {} minute limit", limit.as_secs() / 60)), error_code: Some("time-limit"), error_params: Some(json!({ "minutes": limit.as_secs() / 60 })), counts_as_failure: true, prompt_result: PromptResult::Unknown, controlled_writer: ControlledWriter::Unconfirmed }; }
                        if let Some(error) = prompt_error { return failure(error); }
                        return match last_assistant["stopReason"].as_str() {
                            Some("error") => failure(last_assistant["errorMessage"].as_str().unwrap_or("Model request failed")),
                            Some("aborted") => RunOutcome { status: "aborted", error: Some("Stopped by the user".into()), error_code: Some("stopped"), error_params: None, counts_as_failure: false, prompt_result: PromptResult::Unknown, controlled_writer: ControlledWriter::Unconfirmed },
                            None => failure("scheduled run settled without an assistant response"),
                            _ => RunOutcome { status: "succeeded", error: None, error_code: None, error_params: None, counts_as_failure: false, prompt_result: PromptResult::Unknown, controlled_writer: ControlledWriter::Unconfirmed },
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
    result.prompt_result = prompt_result;
    result
}

#[cfg(test)]
#[path = "scheduled_runner_tests.rs"]
mod tests;
