//! Disk-backed scheduled session relations shared by the catalogue and deletion gate.
use std::collections::{HashMap, HashSet};
use std::path::Path;
use serde_json::Value;
use task_scheduler::task_repository::TaskRepository;

#[derive(Debug)]
pub struct IndexError(pub String);

pub struct ScheduledSessionIndex {
    referenced: HashSet<String>,
    hidden: HashSet<String>,
    relations: HashMap<String, (String, String)>,
}

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, b)| {
        if matches!(i, 8 | 13 | 18 | 23) { b == b'-' } else { b.is_ascii_hexdigit() }
    })
}

impl ScheduledSessionIndex {
    pub fn load(agent_dir: &Path) -> Result<Self, IndexError> {
        let tasks = TaskRepository::new(agent_dir).list().map_err(IndexError)?;
        let existing: HashSet<String> = tasks.iter().filter_map(|task| task["id"].as_str().map(str::to_string)).collect();
        let mut result = Self { referenced: HashSet::new(), hidden: HashSet::new(), relations: HashMap::new() };
        let directory = agent_dir.join("scheduled-tasks/runs");
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(result),
            Err(e) => return Err(IndexError(e.to_string())),
        };
        for entry in entries {
            let entry = entry.map_err(|e| IndexError(e.to_string()))?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let (id, archive) = if let Some(id) = name.strip_suffix(".archive.jsonl") { (id, true) }
                else if let Some(id) = name.strip_suffix(".jsonl") { (id, false) }
                else { continue };
            if !valid_id(id) { continue; }
            let content = std::fs::read_to_string(entry.path()).map_err(|e| IndexError(e.to_string()))?;
            for line in content.lines() {
                let Ok(run) = serde_json::from_str::<Value>(line) else { continue };
                let (Some(run_id), Some(session_id)) = (run["runId"].as_str(), run["sessionId"].as_str()) else { continue };
                if !archive && run["taskId"].as_str() != Some(id) { continue; }
                result.referenced.insert(session_id.to_string());
                if existing.contains(id) {
                    result.hidden.insert(session_id.to_string());
                    result.relations.insert(session_id.to_string(), (id.to_string(), run_id.to_string()));
                }
            }
        }
        Ok(result)
    }

    pub fn is_referenced(&self, session_id: &str) -> bool { self.referenced.contains(session_id) }
    pub fn hidden_session_ids(&self) -> &HashSet<String> { &self.hidden }
    pub fn relation(&self, session_id: &str) -> Option<(&str, &str)> {
        self.relations.get(session_id).map(|(task, run)| (task.as_str(), run.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn running_history_archive_deleted_tasks_and_torn_lines() {
        let dir = tempfile::tempdir().unwrap();
        let id = "12345678-1234-1234-1234-123456789abc";
        let orphan = "87654321-4321-4321-4321-cba987654321";
        std::fs::write(dir.path().join("scheduled-tasks.json"), json!({"tasks":[{"id":id,"name":"x","prompt":"p","cwd":"/tmp","enabled":true,"schedule":{"kind":"manual"}}]}).to_string()).unwrap();
        let runs = dir.path().join("scheduled-tasks/runs"); std::fs::create_dir_all(&runs).unwrap();
        std::fs::write(runs.join(format!("{id}.jsonl")), format!("{}\n{{broken\n{}\n", json!({"taskId":id,"runId":"r1","sessionId":"running","status":"running"}), json!({"taskId":id,"runId":"r2","sessionId":"history","status":"succeeded"}))).unwrap();
        std::fs::write(runs.join(format!("{id}.archive.jsonl")), format!("{}\n", json!({"runId":"r3","sessionId":"archive"}))).unwrap();
        std::fs::write(runs.join(format!("{orphan}.archive.jsonl")), format!("{}\n", json!({"runId":"r4","sessionId":"orphan"}))).unwrap();
        let index = ScheduledSessionIndex::load(dir.path()).unwrap();
        for session in ["running", "history", "archive"] { assert!(index.is_referenced(session)); assert!(index.hidden_session_ids().contains(session)); }
        assert!(index.is_referenced("orphan"));
        assert!(!index.hidden_session_ids().contains("orphan"));
        assert_eq!(index.relation("running"), Some((id, "r1")));
        std::fs::write(dir.path().join("scheduled-tasks.json"), "{broken").unwrap();
        assert!(ScheduledSessionIndex::load(dir.path()).is_err());
    }
}
