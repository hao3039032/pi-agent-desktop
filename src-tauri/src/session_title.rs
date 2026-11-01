//! Session-bound title generation. The provider call runs in the live child;
//! the host only commits after revalidating the same child and branch.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use crate::pi_ipc::{dispatch_with_resume, IpcHostState};

#[cfg(all(test, unix))]
#[path = "session_title_test.rs"]
mod tests;

fn err(code: &str, message: impl ToString) -> (String, String) { (code.into(), message.to_string()) }

pub(crate) struct TitleTask {
    session: Arc<session_host::Session>,
    id: String,
    snapshot: Value,
    expires: Instant,
}

fn identity(args: &Value) -> Result<(&str, &str), (String, String)> {
    let session = args.get("session").and_then(Value::as_str).filter(|v| !v.is_empty()).ok_or_else(|| err("invalid_args", "session is required"))?;
    let id = args.get("task").and_then(Value::as_str).filter(|v| !v.is_empty()).ok_or_else(|| err("invalid_args", "task is required"))?;
    Ok((session, id))
}

fn snapshot(session: &session_host::Session) -> Result<Value, (String, String)> {
    let state = session.get_state().map_err(|e| err("op_failed", e))?;
    let entries = session.command("get_entries", json!({}), Some(Duration::from_secs(30))).map_err(|e| err("op_failed", e))?;
    if !entries.get("entries").is_some_and(Value::is_array) || !entries.get("leafId").is_some() || !state.get("model").is_some_and(Value::is_object) {
        return Err(err("op_failed", "Live session snapshot is incomplete"));
    }
    Ok(json!({"model":state["model"],"name":state["sessionName"],"entries":entries}))
}

pub(crate) fn start(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let id = args.get("session").and_then(Value::as_str).filter(|v| !v.is_empty()).ok_or_else(|| err("invalid_args", "session is required"))?;
    let _policy = state.policy_gate.try_read().map_err(|_| err("busy", "Session policy change is in progress"))?;
    dispatch_with_resume(state, "agent.command", &json!({"session":id,"type":"get_state"}))?;
    let session = state.registry.get(id).ok_or_else(|| err("not_found", "Session not found"))?;
    let mut tasks = state.title_tasks.lock().unwrap();
    tasks.retain(|_, task| task.lock().unwrap().expires > Instant::now());
    if tasks.contains_key(id) { return Err(err("busy", "Title generation is already in progress")); }
    if tasks.len() >= 32 { return Err(err("busy", "Too many title requests are in progress")); }
    let guard = session.try_branch_activity().map_err(|e| err("busy", e))?;
    if session.run_state().is_running() || !session.composer_outbox.snapshot().0.is_empty() { return Err(err("busy", "Wait for the current response and queued messages before generating a title")); }
    session.bridge_request("tree.assertIdle", None, Some(Duration::from_secs(30))).map_err(|e| err("busy", e))?;
    let saved = snapshot(&session)?;
    let config = state.management_config.lock().unwrap().clone().ok_or_else(|| err("management_unavailable", "Managed title modules are unavailable"))?;
    let dir = config.env.iter().find(|(key, _)| key == "PI_WEB_MANAGED_MODULES").map(|(_, value)| value).ok_or_else(|| err("management_unavailable", "Managed title modules are unavailable"))?;
    let module = std::path::Path::new(dir).join("pi-web-session-projection.mjs").canonicalize().map_err(|e| err("management_unavailable", e))?;
    let result = session.bridge_request("title.start", Some(json!({"module":module})), Some(Duration::from_secs(30))).map_err(|e| err("op_failed", e))?;
    let task = result.get("id").and_then(Value::as_str).filter(|v| !v.is_empty()).ok_or_else(|| err("op_failed", "Invalid title task"))?.to_owned();
    drop(guard);
    tasks.insert(id.to_owned(), Arc::new(Mutex::new(TitleTask { session, id: task.clone(), snapshot: saved, expires: Instant::now() + Duration::from_secs(120) })));
    Ok(json!({"task":task}))
}

fn find(state: &IpcHostState, session: &str, id: &str) -> Result<Arc<Mutex<TitleTask>>, (String, String)> {
    let task = state.title_tasks.lock().unwrap().get(session).cloned().ok_or_else(|| err("not_found", "Title task not found"))?;
    if task.lock().unwrap().id != id { return Err(err("not_found", "Title task not found")); }
    Ok(task)
}
fn remove(state: &IpcHostState, session: &str, task: &Arc<Mutex<TitleTask>>) {
    let mut tasks = state.title_tasks.lock().unwrap();
    if tasks.get(session).is_some_and(|value| Arc::ptr_eq(value, task)) { tasks.remove(session); }
}

pub(crate) fn status(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let (id, task_id) = identity(args)?;
    let task = find(state, id, task_id)?;
    let task_guard = task.lock().unwrap();
    if Instant::now() >= task_guard.expires {
        let _ = task_guard.session.bridge_request("title.cancel", Some(json!({"id":task_id})), Some(Duration::from_secs(10)));
        drop(task_guard);
        remove(state, id, &task);
        return Err(err("timeout", "Session title generation timed out; no rename was attempted"));
    }
    let _policy = match state.policy_gate.try_read() {
        Ok(guard) => guard,
        Err(_) => {
            let _ = task_guard.session.bridge_request("title.cancel", Some(json!({"id":task_id})), Some(Duration::from_secs(10)));
            drop(task_guard); remove(state, id, &task);
            return Err(err("busy", "Session policy change is in progress"));
        }
    };
    if !state.registry.get(id).is_some_and(|current| Arc::ptr_eq(&current, &task_guard.session)) || task_guard.session.is_transport_closing() {
        drop(task_guard);
        remove(state, id, &task);
        return Err(err("stale", "Session was replaced while generating the title"));
    }
    let session = Arc::clone(&task_guard.session);
    let guard = match session.try_branch_activity() {
        Ok(guard) => guard,
        Err(message) => {
            let _ = task_guard.session.bridge_request("title.cancel", Some(json!({"id":task_id})), Some(Duration::from_secs(10)));
            drop(task_guard); remove(state, id, &task);
            return Err(err("busy", message));
        }
    };
    let response = match task_guard.session.bridge_request("title.status", Some(json!({"id":task_id})), Some(Duration::from_secs(10))) {
        Ok(response) => response,
        Err(error) => {
            let _ = task_guard.session.bridge_request("title.cancel", Some(json!({"id":task_id})), Some(Duration::from_secs(10)));
            drop(guard); drop(task_guard); remove(state, id, &task);
            return Err(err("op_failed", error));
        }
    };
    if response["status"] == "running" { return Ok(json!({"status":"running"})); }
    let result = (|| {
        if response["status"] != "succeeded" { return Err(err(if response["status"] == "stale" { "stale" } else { "op_failed" }, response["error"].as_str().unwrap_or("Title generation cancelled"))); }
        let title = response["result"]["title"].as_str().filter(|v| !v.is_empty()).ok_or_else(|| err("op_failed", "Invalid title result"))?;
        if task_guard.session.run_state().is_running() || !task_guard.session.composer_outbox.snapshot().0.is_empty() { return Err(err("busy", "Session is no longer idle")); }
        task_guard.session.bridge_request("tree.assertIdle", None, Some(Duration::from_secs(30))).map_err(|e| err("busy", e))?;
        if snapshot(&task_guard.session)? != task_guard.snapshot { return Err(err("stale", "Session changed while generating the title")); }
        task_guard.session.bridge_request_with_activity(&guard, "session.rename", Some(json!({"name":title})), Some(Duration::from_secs(30)))
            .map_err(|e| err("outcome_unknown", format!("Rename failed or its outcome is unknown; refresh the session list before trying again: {e}")))?;
        Ok(json!({"title":title,"usage":response["result"]["usage"]}))
    })();
    drop(guard);
    drop(task_guard);
    remove(state, id, &task);
    result
}

pub(crate) fn cancel(state: &IpcHostState, args: &Value) -> Result<Value, (String, String)> {
    let (id, task_id) = identity(args)?;
    let task = find(state, id, task_id)?;
    let guard = task.lock().unwrap();
    let result = guard.session.bridge_request("title.cancel", Some(json!({"id":task_id})), Some(Duration::from_secs(10))).map_err(|e| err("op_failed", e));
    drop(guard);
    remove(state, id, &task);
    result
}
