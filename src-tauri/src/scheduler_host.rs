//! Scheduled-task editing. Session execution and the scheduler timer are separate.
use serde_json::{json, Value};
use task_scheduler::task_repository::TaskRepository;
use crate::pi_ipc::{management_call, IpcHostState};

pub struct HostError { pub code: String, pub message: String, pub key: Option<String>, pub params: Option<Value> }
impl From<(String, String)> for HostError {
    fn from((code, message): (String, String)) -> Self { Self { code, message, key: None, params: None } }
}
fn err(code: &str, message: impl Into<String>) -> HostError {
    HostError { code: code.into(), message: message.into(), key: None, params: None }
}
fn id(args: &Value) -> Result<&str, HostError> {
    args.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or_else(|| err("invalid_args", "id is required"))
}
fn task(repo: &TaskRepository, id: &str) -> Result<Value, HostError> {
    repo.list().map_err(|e| err("io", e))?.into_iter().find(|task| task["id"] == id)
        .ok_or_else(|| err("not_found", "Task not found"))
}
fn view(task: Value, next: Value, runs: &[Value]) -> Value {
    let unread = runs.iter().filter(|run| run["status"] != "running" && run["status"] != "skipped"
        && run["sessionId"].is_string() && run.get("seenAt").is_none_or(Value::is_null)).count();
    let mut obj = task.as_object().cloned().unwrap_or_default();
    obj.insert("nextRunAt".into(), next);
    obj.insert("lastRun".into(), runs.last().cloned().unwrap_or(Value::Null));
    obj.insert("unreadRuns".into(), json!(unread));
    Value::Object(obj)
}
fn next_run(state: &IpcHostState, task: &Value) -> Result<Value, HostError> {
    if task["enabled"] != true { return Ok(Value::Null); }
    match task["schedule"]["kind"].as_str() {
        Some("manual") => Ok(Value::Null),
        Some("once") => Ok(task["schedule"]["at"].clone()),
        Some("cron") => Ok(management_call(state, "tasks.nextRun", json!({ "task": task }))?["nextRunAt"].clone()),
        _ => Ok(Value::Null),
    }
}
fn checked_validation(result: Value) -> Result<(Value, Value), HostError> {
    if result["valid"] != true {
        let mut error = err("invalid_args", result["error"].as_str().unwrap_or("Invalid task"));
        error.key = result["key"].as_str().map(str::to_string);
        error.params = result.get("params").filter(|value| value.is_object()).cloned();
        return Err(error);
    }
    Ok((result["task"].clone(), result["nextRunAt"].clone()))
}
fn check_unique(tasks: &[Value], next: &Value, except: Option<&str>) -> Result<(), String> {
    let name = next["name"].as_str().ok_or("Invalid task name")?.trim().to_lowercase();
    if tasks.iter().any(|task| task["id"].as_str() != except && task["name"].as_str().is_some_and(|other| other.trim().to_lowercase() == name)) {
        return Err("a task with that name already exists".into());
    }
    Ok(())
}

fn mutation_error(message: String, task: &Value) -> HostError {
    if message == "a task with that name already exists" {
        let mut error = err("invalid_args", message);
        error.key = Some("scheduled.error.nameTaken".into());
        error.params = Some(json!({ "name": task["name"] }));
        error
    } else { err("io", message) }
}

pub fn dispatch(state: &IpcHostState, op: &str, args: &Value) -> Result<Value, HostError> {
    let repo = TaskRepository::new(state.agent_dir());
    match op {
        "tasks.list" => {
            let tasks = repo.list().map_err(|e| err("io", e))?;
            let mut views = Vec::with_capacity(tasks.len());
            for task in tasks {
                let task_id = task["id"].as_str().ok_or_else(|| err("io", "Invalid task id"))?;
                let runs = repo.runs(task_id).map_err(|e| err("io", e))?;
                let next = next_run(state, &task)?;
                views.push(view(task, next, &runs));
            }
            Ok(json!({ "tasks": views, "scheduler": { "owner": null, "ownerInfo": null } }))
        }
        "tasks.get" => {
            let task_id = id(args)?;
            let task = task(&repo, task_id)?;
            let runs = repo.runs(task_id).map_err(|e| err("io", e))?;
            let next = next_run(state, &task)?;
            Ok(json!({ "task": view(task, next, &runs) }))
        }
        "tasks.run" => {
            let result = crate::scheduled_runner::run_now(state, id(args)?).map_err(|e| {
                if e == "Task not found" { err("not_found", e) }
                else if e == "This task is already running" { err("busy", e) }
                else { err("io", e) }
            })?;
            Ok(json!({ "run": result }))
        }
        "tasks.runs" => {
            let task_id = id(args)?;
            task(&repo, task_id)?;
            let mut runs = repo.runs(task_id).map_err(|e| err("io", e))?;
            runs.reverse();
            let limit = args.get("limit").and_then(Value::as_u64).filter(|n| *n > 0).unwrap_or(50).min(200) as usize;
            let start = args.get("before").and_then(Value::as_str).and_then(|before| runs.iter().position(|run| run["runId"] == before)).map_or(0, |i| i + 1);
            let end = (start + limit).min(runs.len());
            Ok(json!({ "runs": &runs[start..end], "hasMore": end < runs.len() }))
        }
        "tasks.markSeen" => {
            let task_id = id(args)?;
            let run_id = args.get("runId").and_then(Value::as_str).ok_or_else(|| err("invalid_args", "runId is required"))?;
            let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| err("io", e.to_string()))?.as_millis() as i64;
            let seen = task_scheduler::store::ms_to_iso(ms);
            let updated = repo.mutate_runs(task_id, |runs| {
                let run = runs.iter_mut().find(|run| run["runId"] == run_id).ok_or("Run not found")?;
                if run["seenAt"].as_str().is_none_or(str::is_empty) { run["seenAt"] = json!(seen); }
                Ok(run.clone())
            }).map_err(|e| if e == "Run not found" || e == "Task not found" { err("not_found", e) } else { err("io", e) })?;
            Ok(json!({ "run": updated }))
        }
        "tasks.delete" => {
            let removed = repo.delete(id(args)?).map_err(|e| err("io", e))?;
            if !removed { return Err(err("not_found", "Task not found")); }
            Ok(json!({ "success": true }))
        }
        "tasks.create" => {
            let (created, next) = checked_validation(management_call(state, "tasks.validateCreate", json!({ "input": args.get("input") }))?)?;
            repo.mutate(|tasks| {
                check_unique(tasks, &created, None)?;
                tasks.push(created.clone());
                Ok(())
            }).map_err(|e| mutation_error(e, &created))?;
            Ok(json!({ "task": view(created, next, &[]) }))
        }
        "tasks.update" => {
            let task_id = id(args)?;
            let existing = task(&repo, task_id)?;
            let runs = repo.runs(task_id).map_err(|e| err("io", e))?;
            let (updated, next) = checked_validation(management_call(state, "tasks.validateUpdate", json!({ "existing": existing, "patch": args.get("patch") }))?)?;
            repo.mutate(|tasks| {
                let index = tasks.iter().position(|task| task["id"] == task_id).ok_or("Task not found")?;
                if tasks[index] != existing { return Err("Task changed during edit; reload before retrying".into()); }
                check_unique(tasks, &updated, Some(task_id))?;
                tasks[index] = updated.clone();
                Ok(())
            }).map_err(|e| mutation_error(e, &updated))?;
            Ok(json!({ "task": view(updated, next, &runs) }))
        }
        _ => Err(err("unknown_op", "unknown scheduled tasks operation")),
    }
}
