//! TS-compatible task file transactions. Callers validate edits inside the
//! transaction so a concurrent creator cannot bypass name uniqueness.
use crate::transaction_lock::TransactionLock;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub struct TaskRepository { agent_dir: PathBuf }

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| {
        if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() }
    })
}

fn is_task(value: &Value) -> bool {
    value.get("id").and_then(Value::as_str).is_some_and(valid_id)
        && ["name", "prompt", "cwd"].iter().all(|key| value.get(key).is_some_and(Value::is_string))
        && value.get("schedule").is_some_and(Value::is_object)
        && value.get("enabled").is_some_and(Value::is_boolean)
}

impl TaskRepository {
    pub fn new(agent_dir: impl Into<PathBuf>) -> Self { Self { agent_dir: agent_dir.into() } }

    fn read_file(&self) -> Result<Map<String, Value>, String> {
        match std::fs::read_to_string(self.agent_dir.join("scheduled-tasks.json")) {
            Ok(text) => serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())?
                .as_object().cloned().ok_or_else(|| "Invalid scheduled tasks file: expected an object".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub fn list(&self) -> Result<Vec<Value>, String> {
        let root = self.read_file()?;
        Ok(tasks_from(&root))
    }

    pub fn mutate<T>(&self, change: impl FnOnce(&mut Vec<Value>) -> Result<T, String>) -> Result<T, String> {
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
