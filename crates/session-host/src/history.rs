//! The session history index (M2): scan the agent dir's session files,
//! read their headers (first JSONL line) and group them by project cwd.
//!
//! Ported shape from lib/session-list-scanner.ts / lib/session-reader.ts:
//! - session files live under `<agentDir>/sessions/<encoded-cwd>/…jsonl`;
//! - the header (first line) carries id, timestamp, cwd, and optionally
//!   parentSession (forks render as children) and name;
//! - the listing is read-only: no file is ever opened for writing and no
//!   header parse failure can break the listing (the file is skipped with
//!   a reason).
//!
//! The full context projection (entries/branch trees) stays with the
//! management extension's SDK reads; this index answers the sidebar.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// One listed session.
#[derive(Debug, Clone)]
pub struct SessionSummary {
    pub file: PathBuf,
    pub id: String,
    pub timestamp_ms: i64,
    /// File mtime in epoch ms (the catalogue's `modified`).
    pub modified_ms: i64,
    pub cwd: String,
    pub name: Option<String>,
    pub parent_session: Option<String>,
    /// The first user message's text (the catalogue's `firstMessage`): a
    /// single pass over the entry lines, truncated to a preview length.
    pub first_message: Option<String>,
    /// Bytes on disk (the sidebar shows sizes for cleanup hints).
    pub size_bytes: u64,
}

/// The indexed tree: project cwd → sessions (newest first).
#[derive(Debug, Default)]
pub struct SessionIndex {
    pub projects: BTreeMap<String, Vec<SessionSummary>>,
    /// Files skipped for a reason (unreadable header, truncated…).
    pub skipped: Vec<(PathBuf, String)>,
}

/// Scan `<agentDir>/sessions` recursively for `.jsonl` session files and
/// read their headers. Best effort per file: one bad file never fails the
/// listing.
pub fn scan_sessions(agent_dir: &Path) -> SessionIndex {
    let mut index = SessionIndex::default();
    let sessions_root = agent_dir.join("sessions");
    let Ok(entries) = std::fs::read_dir(&sessions_root) else {
        return index;
    };
    let mut files: Vec<PathBuf> = Vec::new();
    collect_jsonl(&sessions_root, &mut files);
    let _ = entries;
    for file in files {
        match read_header_summary(&file) {
            Ok(summary) => {
                index
                    .projects
                    .entry(summary.cwd.clone())
                    .or_default()
                    .push(summary);
            }
            Err(reason) => index.skipped.push((file, reason)),
        }
    }
    for (_, sessions) in index.projects.iter_mut() {
        sessions.sort_by(|a, b| b.timestamp_ms.cmp(&a.timestamp_ms));
    }
    index
}

/// Find one session's file and header by id (the resolveSessionPath
/// contract: a targeted look-up, then nothing — no negative caching).
pub fn find_session_by_id(agent_dir: &Path, session_id: &str) -> Option<SessionSummary> {
    if session_id.is_empty() {
        return None;
    }
    let index = scan_sessions(agent_dir);
    index
        .projects
        .into_values()
        .flatten()
        .find(|summary| summary.id == session_id)
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        if file_type.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

/// Read one session file's header line into a summary.
pub fn read_header_summary(file: &Path) -> Result<SessionSummary, String> {
    let content = std::fs::read_to_string(file).map_err(|error| format!("unreadable: {error}"))?;
    let size_bytes = content.len() as u64;
    let first_line = content.lines().next().unwrap_or("");
    if first_line.trim().is_empty() {
        return Err("empty file".to_string());
    }
    let header: Value =
        serde_json::from_str(first_line).map_err(|error| format!("header not JSON: {error}"))?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err("first line is not a session header".to_string());
    }
    let id = header
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "header has no id".to_string())?
        .to_string();
    let timestamp_ms = header
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso_ms)
        .unwrap_or(0);
    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if cwd.is_empty() {
        return Err("header has no cwd".to_string());
    }
    let modified_ms = std::fs::metadata(file)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(timestamp_ms);
    // The first user message (the catalogue's preview). One pass; the
    // session_info/model_change entries ahead of it are skipped.
    let first_message = content.lines().find_map(|line| {
        let entry: Value = serde_json::from_str(line.trim()).ok()?;
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            return None;
        }
        let role = entry.pointer("/message/role").and_then(Value::as_str)?;
        if role != "user" {
            return None;
        }
        let text = message_text(entry.pointer("/message/content").unwrap_or(&Value::Null))?;
        let preview: String = text.chars().take(200).collect();
        Some(preview)
    });
    Ok(SessionSummary {
        file: file.to_path_buf(),
        id,
        timestamp_ms,
        modified_ms,
        cwd,
        name: header.get("name").and_then(Value::as_str).map(str::to_string),
        parent_session: header
            .get("parentSession")
            .and_then(Value::as_str)
            .map(str::to_string),
        first_message,
        size_bytes,
    })
}

/// Minimal ISO-8601 → epoch ms (the header timestamps are UTC Zulu).
fn parse_iso_ms(value: &str) -> Option<i64> {
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
    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1000) as i64)
}

/// Howard Hinnant's days_from_civil.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Serialize the index for the sessions.list IPC response.
pub fn index_json(index: &SessionIndex) -> Value {
    let projects: Vec<Value> = index
        .projects
        .iter()
        .map(|(cwd, sessions)| {
            json!({
                "cwd": cwd,
                "sessions": sessions.iter().map(summary_json).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({
        "projects": projects,
        "skipped": index.skipped.iter().map(|(file, reason)| json!({
            "file": file.display().to_string(),
            "reason": reason,
        })).collect::<Vec<_>>(),
    })
}

fn summary_json(summary: &SessionSummary) -> Value {
    json!({
        "id": summary.id,
        "file": summary.file.display().to_string(),
        "timestampMs": summary.timestamp_ms,
        "modifiedMs": summary.modified_ms,
        "cwd": summary.cwd,
        "name": summary.name,
        "parentSession": summary.parent_session,
        "firstMessage": summary.first_message,
        "sizeBytes": summary.size_bytes,
    })
}

/// The text of a message content block: a plain string is itself; an array
/// yields its text parts joined (the first-user-message preview).
fn message_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let joined: Vec<String> = parts
                .iter()
                .filter_map(|part| {
                    if part.get("type").and_then(Value::as_str) == Some("text") {
                        part.get("text").and_then(Value::as_str).map(str::to_string)
                    } else {
                        None
                    }
                })
                .collect();
            if joined.is_empty() {
                None
            } else {
                Some(joined.join("\n"))
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_session(dir: &Path, name: &str, header: &str) -> PathBuf {
        let encoded = dir.join(name);
        std::fs::write(&encoded, format!("{header}\n")).expect("write");
        encoded
    }

    #[test]
    fn scans_group_and_sort_by_project_and_time() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions = dir.path().join("sessions");
        let project_a = sessions.join("encoded-a");
        let project_b = sessions.join("encoded-b");
        std::fs::create_dir_all(&project_a).expect("a");
        std::fs::create_dir_all(&project_b).expect("b");

        write_session(
            &project_a,
            "old.jsonl",
            r#"{"type":"session","version":3,"id":"a-old","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/proj/a"}"#,
        );
        write_session(
            &project_a,
            "new.jsonl",
            r#"{"type":"session","version":3,"id":"a-new","timestamp":"2026-02-01T00:00:00.000Z","cwd":"/proj/a","name":"Named","parentSession":"/elsewhere.jsonl"}"#,
        );
        write_session(
            &project_b,
            "one.jsonl",
            r#"{"type":"session","version":3,"id":"b-one","timestamp":"2026-03-01T12:30:45.000Z","cwd":"/proj/b"}"#,
        );
        // A corrupt file is skipped with a reason, not fatal.
        write_session(&project_b, "broken.jsonl", "not json at all");

        let index = scan_sessions(dir.path());
        assert_eq!(index.projects.len(), 2);
        let a = &index.projects["/proj/a"];
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].id, "a-new", "newest first");
        assert_eq!(a[0].name.as_deref(), Some("Named"));
        assert!(a[0].parent_session.is_some());
        assert_eq!(a[1].id, "a-old");
        let b = &index.projects["/proj/b"];
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].timestamp_ms, 1_772_368_245_000, "ISO → epoch ms");
        assert_eq!(index.skipped.len(), 1);
        assert!(index.skipped[0].1.contains("header not JSON"));

        // The JSON shape for IPC.
        let value = index_json(&index);
        assert_eq!(value["projects"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn empty_or_missing_roots_index_cleanly() {
        let dir = tempfile::tempdir().expect("tempdir");
        let index = scan_sessions(dir.path());
        assert!(index.projects.is_empty());
        assert!(index.skipped.is_empty());

        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(sessions.join("x")).expect("x");
        let index = scan_sessions(dir.path());
        assert!(index.projects.is_empty());
    }

    #[test]
    fn non_header_first_lines_are_skipped() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("stray.jsonl");
        std::fs::write(&file, "{\"type\":\"message\",\"id\":\"m\"}\n").expect("write");
        let error = read_header_summary(&file).expect_err("not a session file");
        assert!(error.contains("not a session header"));
    }

    #[test]
    fn summaries_carry_modified_and_first_message_for_the_catalogue() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions = dir.path().join("sessions").join("proj");
        std::fs::create_dir_all(&sessions).expect("sessions");
        let file = sessions.join("s.jsonl");
        std::fs::write(
            &file,
            concat!(
                r#"{"type":"session","version":3,"id":"sid","timestamp":"2026-03-01T12:30:45.000Z","cwd":"/proj"}"#,
                "\n",
                r#"{"type":"model_change","id":"m1","parentId":null,"provider":"p","modelId":"m"}"#,
                "\n",
                r#"{"type":"message","id":"e1","parentId":null,"message":{"role":"user","content":"first question"}}"#,
                "\n",
                r#"{"type":"message","id":"e2","parentId":"e1","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}"#,
                "\n",
            ),
        )
        .expect("write");

        let summary = read_header_summary(&file).expect("summary");
        assert_eq!(summary.first_message.as_deref(), Some("first question"),
            "the first USER message, not the assistant reply or the model_change");
        assert!(summary.modified_ms >= summary.timestamp_ms, "modified is the file mtime");

        // A session with no user message yet: the preview is absent.
        let empty = sessions.join("empty.jsonl");
        std::fs::write(
            &empty,
            r#"{"type":"session","version":3,"id":"sid2","timestamp":"2026-03-01T12:30:45.000Z","cwd":"/proj"}"#,
        )
        .expect("write");
        let summary = read_header_summary(&empty).expect("summary");
        assert!(summary.first_message.is_none());

        // A structured user content block yields its text parts.
        let structured = sessions.join("structured.jsonl");
        std::fs::write(
            &structured,
            concat!(
                r#"{"type":"session","version":3,"id":"sid3","timestamp":"2026-03-01T12:30:45.000Z","cwd":"/proj"}"#,
                "\n",
                r#"{"type":"message","id":"e1","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"hello "},{"type":"image","data":"x"},{"type":"text","text":"world"}]}}"#,
                "\n",
            ),
        )
        .expect("write");
        let summary = read_header_summary(&structured).expect("summary");
        assert_eq!(summary.first_message.as_deref(), Some("hello \nworld"));

        // The index JSON carries the new fields for the IPC catalogue.
        let index = scan_sessions(dir.path());
        let value = index_json(&index);
        let entry = &value["projects"][0]["sessions"][0];
        assert!(entry.get("modifiedMs").is_some());
        assert!(entry.get("firstMessage").is_some());
    }
}
