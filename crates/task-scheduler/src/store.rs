//! The task store (M4): byte-compatible with the TS engine's files.
//!
//! - tasks: `<agentDir>/scheduled-tasks.json` — a JSON object `{ tasks: [...] }`
//!   written atomically (tmp + rename); unknown fields are preserved
//!   (forward compatibility — a newer field never blocks an older host);
//! - runs: `<agentDir>/scheduled-tasks/runs/<taskId>.jsonl` — one JSON line
//!   per run, appended; reads tolerate a truncated tail (a crash mid-append
//!   never loses earlier runs);
//! - the archive (`<taskId>.archive.jsonl`) is only ever appended on
//!   rotation by the same rules.
//!
//! `lastScheduledFor` is the TS watermark; this store maps it to/from the
//! scheduler's `since_ms` (epoch ms).

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{json, Map, Value};

use crate::Task;

/// Where the store lives.
pub struct TaskStore {
    agent_dir: PathBuf,
}

/// One recorded run (the subset the scheduler writes; the UI view adds
/// projections on top).
#[derive(Debug, Clone)]
pub struct RunRecord {
    pub run_id: String,
    pub task_id: String,
    pub trigger: String,
    pub scheduled_for_ms: i64,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub status: String,
    pub error: Option<String>,
    pub session_file: Option<String>,
}

impl TaskStore {
    pub fn new(agent_dir: impl Into<PathBuf>) -> Self {
        Self { agent_dir: agent_dir.into() }
    }

    fn tasks_file(&self) -> PathBuf {
        self.agent_dir.join("scheduled-tasks.json")
    }

    fn runs_dir(&self) -> PathBuf {
        self.agent_dir.join("scheduled-tasks").join("runs")
    }

    fn runs_file(&self, task_id: &str) -> PathBuf {
        self.runs_dir().join(format!("{}.jsonl", sanitize_task_id(task_id)))
    }

    /// Read all tasks (raw JSON kept for unknown fields; parsed into the
    /// scheduler shape). A missing file is an empty store; a corrupt file
    /// is an ERROR (never silently replaced — the operator decides).
    pub fn read_tasks(&self) -> Result<BTreeMap<String, (Task, Value)>, String> {
        let file = self.tasks_file();
        if !file.exists() {
            return Ok(BTreeMap::new());
        }
        let content = std::fs::read_to_string(&file).map_err(|error| format!("unreadable: {error}"))?;
        let parsed: Value = serde_json::from_str(&content).map_err(|error| format!("corrupt tasks file: {error}"))?;
        let list = parsed
            .get("tasks")
            .and_then(Value::as_array)
            .ok_or_else(|| "corrupt tasks file: no tasks array".to_string())?;
        let mut tasks = BTreeMap::new();
        for raw in list {
            let Some(id) = raw.get("id").and_then(Value::as_str) else { continue };
            // The TS watermark is an ISO string; the scheduler wants epoch ms.
            let since_ms = raw
                .get("lastScheduledFor")
                .and_then(Value::as_str)
                .and_then(iso_to_ms)
                .unwrap_or(0);
            let enabled = raw.get("enabled").and_then(Value::as_bool).unwrap_or(true);
            let auto_paused_reason = raw
                .get("autoPausedReason")
                .and_then(Value::as_str)
                .map(str::to_string);
            let schedule = match raw.get("schedule").and_then(|s| s.get("kind")).and_then(Value::as_str) {
                Some("manual") => crate::Schedule::Manual,
                Some("once") => crate::Schedule::Once {
                    at_ms: raw
                        .pointer("/schedule/at")
                        .and_then(Value::as_str)
                        .and_then(iso_to_ms)
                        .unwrap_or(0),
                },
                Some("cron") => crate::Schedule::Cron {
                    expr: raw
                        .pointer("/schedule/expr")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    timezone: raw
                        .pointer("/schedule/timezone")
                        .and_then(Value::as_str)
                        .unwrap_or("UTC")
                        .to_string(),
                },
                _ => continue,
            };
            let task = Task {
                id: id.to_string(),
                enabled,
                schedule,
                since_ms,
                auto_paused_reason,
            };
            tasks.insert(id.to_string(), (task, raw.clone()));
        }
        Ok(tasks)
    }

    /// Write the tasks file atomically, preserving unknown fields of each
    /// task's raw object (the map carries the last-seen raw values; callers
    /// merge their updates into them).
    pub fn write_tasks(&self, tasks: &[(Task, Value)]) -> Result<(), String> {
        let mut list: Vec<Value> = Vec::new();
        for (task, raw) in tasks {
            let mut raw = raw.clone();
            // Ensure the raw object carries this task's scheduler-visible
            // state; unknown fields pass through untouched.
            let object = raw.as_object_mut().ok_or("task raw is not an object")?;
            object.insert("id".into(), json!(task.id));
            object.insert("enabled".into(), json!(task.enabled));
            if task.since_ms > 0 {
                object.insert("lastScheduledFor".into(), json!(ms_to_iso(task.since_ms)));
            }
            match &task.auto_paused_reason {
                Some(reason) => {
                    object.insert("autoPausedReason".into(), json!(reason));
                }
                None => {
                    object.remove("autoPausedReason");
                }
            }
            list.push(raw.clone());
        }
        let serialized = serde_json::to_string_pretty(&json!({ "tasks": list })).map_err(|error| error.to_string())?;
        let file = self.tasks_file();
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("mkdir failed: {error}"))?;
        }
        let tmp = file.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&tmp, serialized + "\n").map_err(|error| format!("write failed: {error}"))?;
        std::fs::rename(&tmp, &file).map_err(|error| format!("rename failed: {error}"))?;
        Ok(())
    }

    /// Append one run record (JSONL; the truncated tail of a crashed
    /// append is tolerated on read).
    pub fn append_run(&self, run: &RunRecord) -> Result<(), String> {
        let dir = self.runs_dir();
        std::fs::create_dir_all(&dir).map_err(|error| format!("mkdir failed: {error}"))?;
        let line = serde_json::to_string(&run_to_json(run)).map_err(|error| error.to_string())?;
        let file = self.runs_file(&run.task_id);
        let append = |line: &str| -> Result<(), String> {
            use std::io::Write;
            let mut handle = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file)
                .map_err(|error| format!("open failed: {error}"))?;
            handle
                .write_all(format!("{line}\n").as_bytes())
                .and_then(|()| handle.flush())
                .map_err(|error| format!("append failed: {error}"))
        };
        // Tolerate a truncated tail: repair by starting a fresh line first
        // if the last byte is not a newline.
        if let Ok(existing) = std::fs::read(&file) {
            if !existing.is_empty() && existing.last() != Some(&b'\n') {
                append("\n{}")?;
                // The "{}" line is not a run; it parses as an empty object
                // and readers skip it. A cleaner repair rewrites the file,
                // but an append-only ledger must never rewrite history.
            }
        }
        append(&line)
    }

    /// Read one task's runs (skipping unparsable lines).
    pub fn read_runs(&self, task_id: &str) -> Vec<RunRecord> {
        let Ok(content) = std::fs::read_to_string(self.runs_file(task_id)) else {
            return Vec::new();
        };
        content
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter_map(|value| run_from_json(&value))
            .collect()
    }
}

/// Task ids become file names (`<id>.jsonl` under runs/): a store file —
/// hand-edited or from a hostile source — must not be able to name
/// `../evil` or `a/b` and escape the runs dir. Path separators, parent
/// segments, Windows drive letters and NUL are replaced with `_`.
fn sanitize_task_id(task_id: &str) -> String {
    let clean: String = task_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect();
    // After mapping, `..`-only names ("..", "...") still traverse; a
    // leading dot keeps the file hidden on Unix — strip leading dots.
    let stripped = clean.trim_start_matches('.');
    if stripped.is_empty() {
        "task".to_string()
    } else {
        stripped.to_string()
    }
}

fn run_to_json(run: &RunRecord) -> Value {    let mut object = Map::new();
    object.insert("runId".into(), json!(run.run_id));
    object.insert("taskId".into(), json!(run.task_id));
    object.insert("trigger".into(), json!(run.trigger));
    object.insert("scheduledFor".into(), json!(ms_to_iso(run.scheduled_for_ms)));
    object.insert("startedAt".into(), json!(ms_to_iso(run.started_at_ms)));
    match run.ended_at_ms {
        Some(ended) => {
            object.insert("endedAt".into(), json!(ms_to_iso(ended)));
        }
        None => {
            object.insert("endedAt".into(), Value::Null);
        }
    }
    object.insert("status".into(), json!(run.status));
    match &run.error {
        Some(error) => {
            object.insert("error".into(), json!(error));
        }
        None => {
            object.remove("error");
        }
    }
    if let Some(session_file) = &run.session_file {
        object.insert("sessionFile".into(), json!(session_file));
    }
    Value::Object(object)
}

fn run_from_json(value: &Value) -> Option<RunRecord> {
    let run_id = value.get("runId").and_then(Value::as_str)?.to_string();
    let task_id = value.get("taskId").and_then(Value::as_str)?.to_string();
    Some(RunRecord {
        run_id,
        task_id,
        trigger: value.get("trigger").and_then(Value::as_str).unwrap_or("manual").to_string(),
        scheduled_for_ms: value
            .get("scheduledFor")
            .and_then(Value::as_str)
            .and_then(iso_to_ms)
            .unwrap_or(0),
        started_at_ms: value.get("startedAt").and_then(Value::as_str).and_then(iso_to_ms).unwrap_or(0),
        ended_at_ms: value
            .get("endedAt")
            .and_then(Value::as_str)
            .and_then(iso_to_ms),
        status: value.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string(),
        error: value.get("error").and_then(Value::as_str).map(str::to_string),
        session_file: value.get("sessionFile").and_then(Value::as_str).map(str::to_string),
    })
}

/// ISO-8601 (Zulu) → epoch ms; the shared minimal parser.
pub(crate) fn iso_to_ms(value: &str) -> Option<i64> {
    iso_to_ms_impl(value)
}

/// The crate-public alias task_from_json uses (same parser).
pub(crate) fn iso_to_ms_pub(value: &str) -> Option<i64> {
    iso_to_ms_impl(value)
}

fn iso_to_ms_impl(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    let month: i64 = value.get(5..7)?.parse().ok()?;
    let day: i64 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: i64 = value.get(17..19)?.parse().ok()?;
    let millis: i64 = value
        .get(20..23)
        .and_then(|fraction| fraction.parse().ok())
        .unwrap_or(0);
    let days = days_from_civil(year, month, day);
    Some((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1000 + millis)
}

/// epoch ms → ISO-8601 (Zulu, millisecond precision).
pub(crate) fn ms_to_iso(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3_600,
        (rest % 3_600) / 60,
        rest % 60
    )
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Schedule;
    use serde_json::json;

    #[test]
    fn tasks_roundtrip_preserving_unknown_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = TaskStore::new(dir.path());
        let raw: Value = serde_json::json!({
            "id": "t1",
            "name": "Nightly build",
            "prompt": "run the build",
            "cwd": "/repo",
            "schedule": { "kind": "cron", "expr": "0 3 * * *", "timezone": "Asia/Shanghai" },
            "enabled": true,
            "consecutiveFailures": 0,
            "customFutureField": { "keep": "me" },
        });
        let mut task = crate::task_from_json(&raw).expect("parses");
        task.since_ms = 1_772_342_220_000;
        store.write_tasks(&[(task.clone(), raw)]).expect("write");

        let read = store.read_tasks().expect("read");
        let (task2, raw2) = &read["t1"];
        assert_eq!(task2.since_ms, task.since_ms);
        assert_eq!(task2.schedule, Schedule::Cron { expr: "0 3 * * *".into(), timezone: "Asia/Shanghai".into() });
        // Unknown fields survive the roundtrip.
        assert_eq!(raw2.pointer("/customFutureField/keep"), Some(&json!("me")));
        assert_eq!(
            raw2.get("lastScheduledFor").and_then(Value::as_str).map(String::from),
            Some(ms_to_iso(task.since_ms))
        );
    }

    #[test]
    fn runs_append_and_read_with_truncated_tail() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = TaskStore::new(dir.path());
        let run = RunRecord {
            run_id: "r1".into(),
            task_id: "t1".into(),
            trigger: "schedule".into(),
            scheduled_for_ms: 1_000,
            started_at_ms: 1_100,
            ended_at_ms: Some(2_000),
            status: "success".into(),
            error: None,
            session_file: Some("/s.jsonl".into()),
        };
        store.append_run(&run).expect("append");
        // Simulate a crashed append: a partial line without a newline.
        {
            use std::io::Write;
            let file = store.runs_file("t1");
            let mut handle = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
            let _ = handle.write_all(br#"{"runId":"trunc"#);
        }
        store
            .append_run(&RunRecord { run_id: "r2".into(), ..run.clone() })
            .expect("append after truncation");
        let runs = store.read_runs("t1");
        assert_eq!(runs.len(), 2, "the truncated line is skipped, both runs live");
        assert_eq!(runs[0].run_id, "r1");
        assert_eq!(runs[1].run_id, "r2");
        assert_eq!(runs[1].ended_at_ms, Some(2_000));
    }

    #[test]
    fn missing_store_is_empty_and_corrupt_is_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = TaskStore::new(dir.path());
        assert!(store.read_tasks().expect("empty").is_empty());

        std::fs::write(dir.path().join("scheduled-tasks.json"), "{ nope").expect("write");
        let error = store.read_tasks().expect_err("corrupt refuses");
        assert!(error.contains("corrupt"));
    }

    #[test]
    fn iso_roundtrips_ms() {
        assert_eq!(iso_to_ms(&ms_to_iso(1_772_342_220_123)), Some(1_772_342_220_123));
        assert_eq!(iso_to_ms("2026-03-01T05:17:00.000Z"), Some(1_772_342_220_000));
        assert_eq!(iso_to_ms("not a date"), None);
    }
}
