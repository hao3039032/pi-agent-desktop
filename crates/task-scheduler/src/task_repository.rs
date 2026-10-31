//! TS-compatible task file transactions. Callers validate edits inside the
//! transaction so a concurrent creator cannot bypass name uniqueness.
use crate::transaction_lock::TransactionLock;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub struct TaskRepository { agent_dir: PathBuf }

#[derive(Debug, PartialEq)]
pub enum SlotClaim { Fired(Value), Skipped(Value), Deferred, Lost }

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| {
        if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() }
    })
}

pub fn is_task(value: &Value) -> bool {
    value.get("id").and_then(Value::as_str).is_some_and(valid_id)
        && ["name", "prompt", "cwd"].iter().all(|key| value.get(key).is_some_and(Value::is_string))
        && value.get("schedule").is_some_and(Value::is_object)
        && value.get("enabled").is_some_and(Value::is_boolean)
}

impl TaskRepository {
    pub fn new(agent_dir: impl Into<PathBuf>) -> Self { Self { agent_dir: agent_dir.into() } }

    fn read_file(&self) -> Result<Map<String, Value>, String> {
        match std::fs::read_to_string(self.agent_dir.join("scheduled-tasks.json")) {
            Ok(text) => {
                let object = serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())?
                    .as_object().cloned().ok_or_else(|| "Invalid scheduled tasks file: expected an object".to_string())?;
                if object.get("tasks").is_some_and(|value| !value.is_array()) {
                    return Err("Invalid scheduled tasks file: tasks is not an array".into());
                }
                Ok(object)
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn list(&self) -> Result<Vec<Value>, String> {
        let root = self.read_file()?;
        Ok(tasks_from(&root))
    }

    pub fn runs(&self, task_id: &str) -> Result<Vec<Value>, String> {
        if !valid_id(task_id) { return Err("Invalid task id".into()); }
        let file = self.agent_dir.join("scheduled-tasks/runs").join(format!("{task_id}.jsonl"));
        let content = match std::fs::read_to_string(file) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.to_string()),
        };
        Ok(content.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|run| run.get("runId").is_some_and(Value::is_string) && run.get("taskId").and_then(Value::as_str) == Some(task_id)).collect())
    }

    pub fn admit_manual(&self, task_id: &str, expected_task: &Value, run: Value, now_ms: i64, pid: u32) -> Result<(), String> {
        if !valid_id(task_id) { return Err("Invalid task id".into()); }
        let before_lock = std::time::Instant::now();
        let _guard = TransactionLock::acquire(&self.agent_dir).map_err(|e| format!("scheduler transaction busy: {e}"))?;
        let now_ms = now_ms.saturating_add(before_lock.elapsed().as_millis().min(i64::MAX as u128) as i64);
        let lease: Value = serde_json::from_str(&std::fs::read_to_string(self.agent_dir.join("scheduled-tasks/scheduler.lock")).map_err(|_| "Scheduler is not the owner")?).map_err(|_| "Scheduler is not the owner")?;
        let heartbeat = lease["heartbeatAt"].as_str().and_then(crate::store::iso_to_ms).ok_or("Scheduler is not the owner")?;
        if lease["pid"].as_u64() != Some(pid as u64) || now_ms.saturating_sub(heartbeat) >= crate::LEASE_STALE_MS as i64 { return Err("Scheduler is not the owner".into()); }
        let tasks = tasks_from(&self.read_file()?);
        let task = tasks.iter().find(|task| task["id"] == task_id).ok_or("Task not found")?;
        if task != expected_task { return Err("Task changed during run admission; reload before retrying".into()); }
        let mut runs = self.runs(task_id)?;
        if runs.iter().any(|run| run["status"] == "running") { return Err("This task is already running".into()); }
        runs.push(run);
        self.write_runs_locked(task_id, &runs)
    }

    /// Update one task's history while holding the same gate as task deletion.
    pub fn mutate_runs<T>(&self, task_id: &str, change: impl FnOnce(&mut Vec<Value>) -> Result<T, String>) -> Result<T, String> {
        if !valid_id(task_id) { return Err("Invalid task id".into()); }
        let _guard = TransactionLock::acquire(&self.agent_dir).map_err(|e| format!("scheduler transaction busy: {e}"))?;
        if !tasks_from(&self.read_file()?).iter().any(|task| task["id"].as_str() == Some(task_id)) {
            return Err("Task not found".into());
        }
        let mut runs = self.runs(task_id)?;
        let result = change(&mut runs)?;
        self.write_runs_locked(task_id, &runs)?;
        Ok(result)
    }

    fn write_runs_locked(&self, task_id: &str, runs: &[Value]) -> Result<(), String> {
        let dir = self.agent_dir.join("scheduled-tasks/runs");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let drop_count = runs.len().saturating_sub(200);
        if drop_count > 0 {
            use std::io::Write;
            let archive = dir.join(format!("{task_id}.archive.jsonl"));
            let mut options = std::fs::OpenOptions::new();
            options.create(true).append(true);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            let mut file = options.open(archive).map_err(|e| e.to_string())?;
            for run in &runs[..drop_count] {
                if let (Some(run_id), Some(session_id)) = (run["runId"].as_str(), run["sessionId"].as_str()) {
                    writeln!(file, "{}", json!({ "runId": run_id, "sessionId": session_id })).map_err(|e| e.to_string())?;
                }
            }
            file.flush().map_err(|e| e.to_string())?;
        }
        let mut lines = String::new();
        for run in &runs[drop_count..] {
            lines.push_str(&serde_json::to_string(run).map_err(|e| e.to_string())?);
            lines.push('\n');
        }
        write_private_atomic(&dir.join(format!("{task_id}.jsonl")), lines.as_bytes())?;
        Ok(())
    }

    /// Claim a previously calculated slot only while the scheduler still
    /// owns the lease and the task snapshot still matches. The watermark
    /// is durable before the run record, as in the transitional TS engine.
    pub fn claim_slot(&self, snapshot: &Value, slot: &str, run: Value, drop_slot: bool, now_ms: i64, pid: u32) -> Result<SlotClaim, String> {
        let task_id = snapshot["id"].as_str().ok_or("Invalid task id")?;
        let before_lock = std::time::Instant::now();
        let _guard = TransactionLock::acquire(&self.agent_dir).map_err(|e| format!("scheduler transaction busy: {e}"))?;
        let now_ms = now_ms.saturating_add(before_lock.elapsed().as_millis().min(i64::MAX as u128) as i64);
        let lease: Value = serde_json::from_str(&std::fs::read_to_string(self.agent_dir.join("scheduled-tasks/scheduler.lock")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let heartbeat = lease["heartbeatAt"].as_str().and_then(crate::store::iso_to_ms).ok_or("Invalid scheduler lease")?;
        if lease["pid"].as_u64() != Some(pid as u64) || now_ms.saturating_sub(heartbeat) >= crate::LEASE_STALE_MS as i64 { return Ok(SlotClaim::Lost); }
        let mut root = self.read_file()?;
        let mut tasks = tasks_from(&root);
        let Some(index) = tasks.iter().position(|task| task["id"] == task_id) else { return Ok(SlotClaim::Lost) };
        if tasks[index] != *snapshot || tasks[index]["enabled"] != true { return Ok(SlotClaim::Lost); }
        let mut active = 0usize;
        let mut overlap = false;
        for task in &tasks {
            let Some(id) = task["id"].as_str() else { continue };
            for current in self.runs(id)? {
                if current["status"] == "running" { active += 1; if id == task_id { overlap = true; } }
            }
        }
        if !drop_slot && !overlap && active >= crate::MAX_CONCURRENT_RUNS { return Ok(SlotClaim::Deferred); }
        tasks[index]["lastScheduledFor"] = json!(slot);
        if tasks[index]["schedule"]["kind"] == "once" { tasks[index]["enabled"] = json!(false); }
        let mut combined: Vec<Value> = root.get("tasks").and_then(Value::as_array).into_iter().flatten().filter(|v| !is_task(v)).cloned().collect();
        combined.extend(tasks);
        root.insert("version".into(), json!(1));
        root.insert("tasks".into(), Value::Array(combined));
        let content = format!("{}\n", serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())?);
        write_private_atomic(&self.agent_dir.join("scheduled-tasks.json"), content.as_bytes())?;
        let mut record = run;
        if overlap || drop_slot {
            record["status"] = json!("skipped");
            record["trigger"] = json!("schedule");
            record["skipReason"] = json!(if drop_slot { "app-asleep" } else { "overlap" });
            record.as_object_mut().ok_or("Invalid run record")?.remove("pid");
            record.as_object_mut().unwrap().remove("startedAt");
        }
        let mut runs = self.runs(task_id)?;
        runs.push(record.clone());
        self.write_runs_locked(task_id, &runs)?;
        Ok(if overlap || drop_slot { SlotClaim::Skipped(record) } else { SlotClaim::Fired(record) })
    }

    pub fn mutate<T>(&self, change: impl FnOnce(&mut Vec<Value>) -> Result<T, String>) -> Result<T, String> {
        self.mutate_with_after(change, |_| Ok(()))
    }

    pub fn delete(&self, task_id: &str) -> Result<bool, String> {
        if !valid_id(task_id) { return Err("Invalid task id".into()); }
        self.mutate_with_after(|tasks| {
            let count = tasks.len();
            tasks.retain(|task| task["id"].as_str() != Some(task_id));
            Ok(tasks.len() != count)
        }, |removed| {
            if *removed {
                let dir = self.agent_dir.join("scheduled-tasks/runs");
                for name in [format!("{task_id}.jsonl"), format!("{task_id}.archive.jsonl")] {
                    match std::fs::remove_file(dir.join(name)) {
                        Ok(()) => {},
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                        Err(error) => return Err(error.to_string()),
                    }
                }
            }
            Ok(())
        })
    }

    fn mutate_with_after<T>(&self, change: impl FnOnce(&mut Vec<Value>) -> Result<T, String>, after: impl FnOnce(&T) -> Result<(), String>) -> Result<T, String> {
        let _guard = TransactionLock::acquire(&self.agent_dir).map_err(|e| format!("scheduler transaction busy: {e}"))?;
        let mut root = self.read_file()?;
        let mut tasks = tasks_from(&root);
        let result = change(&mut tasks)?;
        if !tasks.iter().all(is_task) { return Err("invalid task in transaction".into()); }
        let mut combined: Vec<Value> = root.get("tasks").and_then(Value::as_array).into_iter().flatten()
            .filter(|entry| !is_task(entry)).cloned().collect();
        combined.extend(tasks);
        root.insert("version".into(), json!(1));
        root.insert("tasks".into(), Value::Array(combined));
        let serialized = format!("{}\n", serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())?);
        write_private_atomic(&self.agent_dir.join("scheduled-tasks.json"), serialized.as_bytes())?;
        after(&result)?;
        Ok(result)
    }
}

fn tasks_from(root: &Map<String, Value>) -> Vec<Value> {
    root.get("tasks").and_then(Value::as_array).into_iter().flatten().filter(|item| is_task(item)).map(|item| {
        let mut task = item.clone();
        let obj = task.as_object_mut().unwrap();
        if obj.get("toolPreset").is_none_or(Value::is_null) { obj.insert("toolPreset".into(), json!("read-only")); }
        if !obj.get("consecutiveFailures").is_some_and(Value::is_number) { obj.insert("consecutiveFailures".into(), json!(0)); }
        task
    }).collect()
}

fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let tmp = path.with_extension(format!("tmp-{}-{nanos}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let result = (|| -> std::io::Result<()> {
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.flush()?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(error) = result { let _ = std::fs::remove_file(&tmp); return Err(error.to_string()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typescript_and_rust_store_updates_do_not_lose_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        let mut child = std::process::Command::new("node")
            .arg(root.join("crates/task-scheduler/tests/fixtures/store-contender.mjs"))
            .arg(&root).arg(dir.path()).spawn().unwrap();
        let repo = TaskRepository::new(dir.path());
        for i in 0..20 {
            repo.mutate(|tasks| {
                tasks.push(json!({
                    "id": format!("22222222-2222-2222-2222-{i:012}"), "name": format!("rust-{i}"),
                    "prompt": "fixture", "cwd": dir.path(), "enabled": true, "schedule": {"kind": "manual"}
                }));
                Ok(())
            }).unwrap();
        }
        assert!(child.wait().unwrap().success());
        let tasks = repo.list().unwrap();
        assert_eq!(tasks.len(), 40);
        assert_eq!(tasks.iter().filter(|task| task["name"].as_str().unwrap().starts_with("ts-")).count(), 20);
    }

    #[test]
    fn slot_claim_fences_owner_snapshot_overlap_and_limit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = TaskRepository::new(dir.path());
        let now = 1_772_342_220_000_i64;
        let ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"];
        repo.mutate(|tasks| { for id in ids { tasks.push(json!({"id":id,"name":id,"prompt":"p","cwd":"/tmp","enabled":true,"schedule":{"kind":"cron","expr":"0 * * * *","timezone":"UTC"},"createdAt":"2026-03-01T04:00:00.000Z"})); } Ok(()) }).unwrap();
        assert!(crate::lease::acquire(dir.path(), 99, now, |_| true).unwrap());
        let record = |id: &str| json!({"runId":format!("run-{id}"),"taskId":id,"status":"running","trigger":"schedule","pid":99});
        let tasks = repo.list().unwrap();
        let mut stale = tasks[0].clone();
        stale["toolPreset"] = json!("full");
        assert!(repo.admit_manual(ids[0], &stale, record(ids[0]), now, 99).is_err());
        assert!(repo.runs(ids[0]).unwrap().is_empty());
        let slot = "2026-03-01T05:00:00.000Z";
        assert_eq!(repo.claim_slot(&tasks[0], slot, record(ids[0]), false, now, 100).unwrap(), SlotClaim::Lost);
        assert!(matches!(repo.claim_slot(&tasks[0], slot, record(ids[0]), false, now, 99).unwrap(), SlotClaim::Fired(_)));
        assert_eq!(repo.claim_slot(&tasks[0], slot, record(ids[0]), false, now, 99).unwrap(), SlotClaim::Lost);
        let updated = repo.list().unwrap();
        assert!(matches!(repo.claim_slot(&updated[0], "2026-03-01T06:00:00.000Z", record(ids[0]), false, now, 99).unwrap(), SlotClaim::Skipped(_)));
        assert!(matches!(repo.claim_slot(&updated[1], slot, record(ids[1]), false, now, 99).unwrap(), SlotClaim::Fired(_)));
        assert_eq!(repo.claim_slot(&updated[2], slot, record(ids[2]), false, now, 99).unwrap(), SlotClaim::Deferred);
    }

    #[test]
    fn history_rotates_and_preserves_session_links() {
        let dir = tempfile::tempdir().unwrap();
        let repo = TaskRepository::new(dir.path());
        let id = "12345678-1234-1234-1234-123456789abc";
        repo.mutate(|tasks| { tasks.push(json!({ "id": id, "name": "x", "prompt": "p", "cwd": "/tmp", "enabled": true, "schedule": { "kind": "manual" } })); Ok(()) }).unwrap();
        repo.mutate_runs(id, |runs| {
            for i in 0..201 { runs.push(json!({ "runId": format!("r{i}"), "taskId": id, "sessionId": format!("s{i}") })); }
            Ok(())
        }).unwrap();
        assert_eq!(repo.runs(id).unwrap().len(), 200);
        let archive = std::fs::read_to_string(dir.path().join(format!("scheduled-tasks/runs/{id}.archive.jsonl"))).unwrap();
        let link: Value = serde_json::from_str(archive.trim()).unwrap();
        assert_eq!(link, json!({ "runId": "r0", "sessionId": "s0" }));
        assert!(repo.delete(id).unwrap());
        assert!(repo.mutate_runs(id, |_| Ok(())).is_err());
    }

    #[test]
    fn edits_preserve_foreign_entries_and_refuse_damage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("scheduled-tasks.json");
        let original = json!({"extension": 7, "tasks": ["foreign", {"id":"bad","name":"untouched"}]});
        std::fs::write(&path, original.to_string()).unwrap();
        let repo = TaskRepository::new(dir.path());
        repo.mutate(|tasks| { tasks.push(json!({"id":"12345678-1234-1234-1234-123456789abc", "name":"x", "prompt":"p", "cwd":"/tmp", "enabled":true, "schedule":{"kind":"manual"}})); Ok(()) }).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["extension"], 7);
        assert_eq!(saved["tasks"][0], original["tasks"][0]);
        assert_eq!(saved["tasks"][1], original["tasks"][1]);
        assert_eq!(repo.list().unwrap()[0]["toolPreset"], "read-only");
        std::fs::write(&path, "{").unwrap();
        assert!(repo.mutate(|_| Ok(())).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "{");
    }
}
