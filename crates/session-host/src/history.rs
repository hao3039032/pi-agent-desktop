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
use std::io::BufRead as _;

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

/// Every session file under `<agentDir>/sessions` (recursive; the catalogue
/// and the ID lookup enumerate once and share the list).
pub fn list_session_files(agent_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_jsonl(&agent_dir.join("sessions"), &mut files);
    files
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

/// Read only a session file's header id (the parent-session resolution:
/// the parent's id is authoritative from ITS header, never from a filename
/// suffix). None for a missing, empty or non-session file.
pub fn read_header_id(file: &Path) -> Option<String> {
    let content = std::fs::read_to_string(file).ok()?;
    let first_line = content.lines().next()?.trim();
    if first_line.is_empty() {
        return None;
    }
    let header: Value = serde_json::from_str(first_line).ok()?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    header.get("id").and_then(Value::as_str).map(str::to_string)
}

/// The subagent relation of a session file (`readSessionRelationEntries` +
/// `readSubagentRun`, bounded the same way): the meta entry must sit in the
/// file's SECOND line (a subagent session opens with its marker), and the
/// lifecycle entry is searched in the last 256 KiB. None = not a subagent
/// session — the caller falls back to the fork relation.
const SUBAGENT_META_TYPE: &str = "pi-web:subagent";
const SUBAGENT_RESULT_TYPE: &str = "pi-web:subagent-result";
const SUBAGENT_STATUS_TYPE: &str = "pi-web:subagent-status";
const RELATION_TAIL_MAX_BYTES: u64 = 256 * 1024;

pub fn read_subagent_relation(file: &Path) -> Option<Value> {
    // The bounded prefix: the header plus (at most) the first entry line.
    // The 256 KiB bound matches the TS reader's; an over-long line fails to
    // parse there and does here too (the truncation marker breaks the JSON).
    let mut handle = std::fs::File::open(file).ok()?;
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(&mut handle);
    let mut header = String::new();
    let mut second = String::new();
    let _ = reader.read_line(&mut header);
    let _ = reader.read_line(&mut second);
    if second.len() > RELATION_TAIL_MAX_BYTES as usize {
        second.truncate(RELATION_TAIL_MAX_BYTES as usize);
    }
    let meta: Value = serde_json::from_str(second.trim()).ok()?;
    if meta.get("type").and_then(Value::as_str) != Some("custom")
        || meta.get("customType").and_then(Value::as_str) != Some(SUBAGENT_META_TYPE)
    {
        return None;
    }
    let data = meta.get("data")?;
    if data.get("version").and_then(Value::as_i64) != Some(1) {
        return None;
    }
    let parent_session_id = data.get("parentSessionId").and_then(Value::as_str)?.to_string();
    if parent_session_id.is_empty() {
        return None;
    }
    let profile = data
        .get("profile")
        .and_then(Value::as_str)
        .unwrap_or("general-purpose")
        .to_string();
    let description = data
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("Subagent")
        .to_string();

    // The lifecycle entry (result or status), searched newest-first in the
    // bounded tail; a torn last line is skipped like every parse miss.
    let meta = std::fs::metadata(file).ok()?;
    let size = meta.len();
    let start = size.saturating_sub(RELATION_TAIL_MAX_BYTES);
    use std::io::{Read, Seek, SeekFrom};
    let mut handle = std::fs::File::open(file).ok()?;
    handle.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = String::new();
    handle.take(RELATION_TAIL_MAX_BYTES).read_to_string(&mut tail).ok()?;
    let lines: Vec<&str> = if start > 0 {
        tail.split('\n').skip(1).collect() // A partial first line is dropped.
    } else {
        tail.split('\n').collect()
    };
    let mut status = "interrupted".to_string();
    for line in lines.iter().rev() {
        let Ok(entry) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if entry.get("type").and_then(Value::as_str) != Some("custom") {
            continue;
        }
        let custom_type = entry.get("customType").and_then(Value::as_str).unwrap_or_default();
        if custom_type == SUBAGENT_RESULT_TYPE {
            if let Some(result_status) = entry
                .get("data")
                .and_then(|data| data.get("status"))
                .and_then(Value::as_str)
            {
                if matches!(result_status, "completed" | "failed" | "aborted") {
                    status = result_status.to_string();
                }
            }
            break;
        }
        if custom_type == SUBAGENT_STATUS_TYPE {
            let data = entry.get("data");
            let version_ok = data.and_then(|data| data.get("version")).and_then(Value::as_i64) == Some(1);
            if let Some(status_value) = data.and_then(|data| data.get("status")).and_then(Value::as_str) {
                if version_ok && matches!(status_value, "queued" | "running") {
                    status = status_value.to_string();
                    break;
                }
            }
        }
    }
    Some(json!({
        "kind": "subagent",
        "parentSessionId": parent_session_id,
        "profile": profile,
        "description": description,
        "status": status,
    }))
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

// ============================================================================
// The full per-file scan (lib/session-list-scanner.ts scanSessionFileInfo)
//
// The CHEAP header scan above answers the session index (id/cwd/time from
// line one). THIS scan is the catalogue's projection: it streams the whole
// file line by line, tolerating unparsable lines (a crashed write's tail
// never hides a session), and derives the fields the TS scanner derived —
// the session_info rename, message/compaction counts, the attachment-aware
// first-user-message title, and the modified time from message activity.
// A differential test keeps the two implementations in step.
// ============================================================================

/// The per-file catalogue projection (ScannedSessionInfo's shape).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScannedSession {
    pub path: PathBuf,
    pub id: String,
    pub cwd: String,
    pub name: Option<String>,
    pub parent_session_path: Option<String>,
    /// Epoch ms of the header timestamp (a REAL ISO parse: milliseconds and
    /// numeric offsets honored, invalid dates rejected to 0).
    pub created_ms: i64,
    /// Epoch ms: last message activity, else the header time, else mtime.
    pub modified_ms: i64,
    pub message_count: u64,
    pub compaction_count: u64,
    /// The attachment-aware first user message, else "(no messages)".
    pub first_message: String,
    pub size_bytes: u64,
}

/// Stream a session file and project the catalogue fields. A missing file,
/// an empty file or a non-session first parsable line yields None (the TS
/// scanner's null); every other parse error skips just that line.
pub fn scan_session_file_info(path: &Path) -> Option<ScannedSession> {
    let file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    let size_bytes = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let mut reader = std::io::BufReader::new(file);
    let mut header: Option<Value> = None;
    let mut name: Option<String> = None;
    let mut message_count: u64 = 0;
    let mut compaction_count: u64 = 0;
    let mut first_message: Option<String> = None;
    let mut last_activity_ms: Option<i64> = None;

    let mut buffer = String::new();
    loop {
        buffer.clear();
        match reader.read_line(&mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break, // a binary/undecodable middle never hides the session
        }
        let line = buffer.trim_end_matches(['\r', '\n']);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(trimmed) else {
            continue; // an unparsable line (a crashed write's tail) skips
        };
        if !entry.is_object() {
            continue;
        }
        let Some(header_ref) = header.as_ref() else {
            if entry.get("type").and_then(Value::as_str) != Some("session") {
                return None; // the TS scanner: a foreign first line hides the file
            }
            header = Some(entry);
            continue;
        };
        let _ = header_ref;
        match entry.get("type").and_then(Value::as_str).unwrap_or("") {
            "session_info" => {
                // The LAST non-empty name wins (a rename overwrites).
                if let Some(value) = entry.get("name").and_then(Value::as_str) {
                    let trimmed_name = value.trim();
                    name = if trimmed_name.is_empty() {
                        None
                    } else {
                        Some(trimmed_name.to_string())
                    };
                }
            }
            "compaction" => compaction_count += 1,
            "message" => {
                message_count += 1;
                if let Some(activity) = activity_time_ms(&entry) {
                    last_activity_ms = Some(last_activity_ms.unwrap_or(0).max(activity));
                }
                let message = entry.get("message");
                let role = message
                    .and_then(|message| message.get("role"))
                    .and_then(Value::as_str);
                if !matches!(role, Some("user") | Some("assistant")) {
                    continue;
                }
                let message = message.expect("role checked above");
                if first_message.is_none() && role == Some("user") {
                    if let Some(text) = extract_text_content(message.get("content")) {
                        let title = attachment_aware_title(&text);
                        if !title.is_empty() {
                            first_message = Some(title);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let header = header?;
    let id = header.get("id").and_then(Value::as_str)?.to_string();
    let cwd = header
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let parent_session_path = header
        .get("parentSession")
        .and_then(Value::as_str)
        .map(str::to_string);
    let created_ms = header
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso_ms_full)
        .unwrap_or(0);
    let modified_ms = match last_activity_ms {
        Some(activity) if activity > 0 => activity,
        _ => {
            if created_ms > 0 {
                created_ms
            } else {
                mtime_ms
            }
        }
    };
    Some(ScannedSession {
        path: path.to_path_buf(),
        id,
        cwd,
        name,
        parent_session_path,
        created_ms,
        modified_ms,
        message_count,
        compaction_count,
        first_message: first_message.unwrap_or_else(|| "(no messages)".to_string()),
        size_bytes,
    })
}

/// The TS activityTimeOf: message.timestamp (a number, ms) else the entry's
/// own ISO timestamp — only user/assistant messages count.
fn activity_time_ms(entry: &Value) -> Option<i64> {
    let message = entry.get("message")?;
    let role = message.get("role").and_then(Value::as_str)?;
    if role != "user" && role != "assistant" {
        return None;
    }
    if !message.get("content").is_some() {
        return None;
    }
    if let Some(stamp) = message.get("timestamp").and_then(Value::as_f64) {
        return Some(stamp as i64);
    }
    match entry.get("timestamp") {
        // An entry-level ms epoch (the JS Date accepts either shape).
        Some(Value::Number(number)) => number.as_f64().map(|stamp| stamp as i64),
        Some(Value::String(text)) => parse_iso_ms_full(text),
        _ => None,
    }
}

/// The TS extractTextContent: a plain string is itself; an array joins its
/// text blocks with single spaces.
fn extract_text_content(content: Option<&Value>) -> Option<String> {
    let content = content?;
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let parts: Vec<String> = blocks
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(Value::as_str) == Some("text") {
                        block.get("text").and_then(Value::as_str).map(str::to_string)
                    } else {
                        None
                    }
                })
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(" "))
            }
        }
        _ => None,
    }
}

/// The TS attachmentAwareTitle: the typed text, else the attached-file
/// names joined with ", " (the attached_file block markup is stripped).
fn attachment_aware_title(content: &str) -> String {
    if !content.contains("<attached_file name=") {
        return content.to_string();
    }
    let close = "\n</attached_file>";
    let mut text = String::new();
    let mut names: Vec<String> = Vec::new();
    let mut rest = content;
    loop {
        let Some(open_at) = rest.find("<attached_file name=\"") else {
            text.push_str(rest);
            break;
        };
        let after_quote = open_at + "<attached_file name=\"".len();
        let Some(name_end) = rest[after_quote..].find('"') else {
            text.push_str(rest);
            break;
        };
        let name = rest[after_quote..after_quote + name_end].to_string();
        // The TS tag regex consumes `">\n`: the body starts after the
        // closing angle bracket and its newline.
        let after_name_quote = after_quote + name_end;
        let Some(tag_tail) = rest[after_name_quote..].strip_prefix("\">\n") else {
            text.push_str(rest);
            break;
        };
        let body_start = rest.len() - tag_tail.len();
        let Some(close_at) = rest[body_start..].find(close) else {
            text.push_str(rest);
            break;
        };
        text.push_str(&rest[..open_at]);
        names.push(name);
        rest = &rest[body_start + close_at + close.len()..];
    }
    let cleaned = collapse_triple_newlines(text.trim());
    if !cleaned.is_empty() {
        return cleaned;
    }
    names.join(", ")
}

/// The TS text cleanup: three-or-more newlines collapse to two.
fn collapse_triple_newlines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = 0;
    for character in text.chars() {
        if character == '\n' {
            run += 1;
            if run <= 2 {
                out.push(character);
            }
        } else {
            run = 0;
            out.push(character);
        }
    }
    out
}

/// A REAL ISO-8601 parse (the TS new Date()): YYYY-MM-DD[T ]HH:MM[:SS[.fff]]
/// with an optional Z or ±HH:MM offset, validated as a calendar date. None
/// for anything malformed (the old parser dropped milliseconds, ignored
/// offsets and accepted impossible dates).
pub fn parse_iso_ms_full(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    let len = bytes.len();
    let digit = |range: std::ops::Range<usize>| -> Option<i64> {
        let slice = bytes.get(range)?;
        if slice.iter().all(|byte| byte.is_ascii_digit()) {
            Some(std::str::from_utf8(slice).ok()?.parse().ok()?)
        } else {
            None
        }
    };
    if len < 19 {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || !(bytes[10] == b'T' || bytes[10] == b' ') {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let year = digit(0..4)?;
    let month = digit(5..7)?;
    let day = digit(8..10)?;
    let hour = digit(11..13)?;
    let minute = digit(14..16)?;
    let second = digit(17..19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    // Day validity against the month (leap years included).
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => return None,
    };
    if day > max_day {
        return None;
    }
    let mut millis = 0i64;
    let mut index = 19;
    if bytes.get(index) == Some(&b'.') {
        let start = index + 1;
        let mut end = start;
        while end < len && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end == start {
            return None;
        }
        let fraction = std::str::from_utf8(&bytes[start..end]).ok()?;
        // .5 → 500ms, .25 → 250ms: scale the fraction to three digits.
        millis = fraction.chars().take(3).collect::<String>().parse().ok()?;
        for _ in fraction.len().min(3)..3 {
            millis *= 10;
        }
        index = end;
    }
    // The offset: Z, ±HH:MM or ±HHMM; none means UTC (the files are Zulu).
    let mut offset_ms: i64 = 0;
    match bytes.get(index) {
        Some(b'Z') | Some(b'z') => {
            index += 1;
        }
        Some(b'+') | Some(b'-') => {
            let sign = if bytes[index] == b'-' { -1 } else { 1 };
            let oh = digit(index + 1..index + 3)?;
            let om = if bytes.get(index + 3) == Some(&b':') {
                digit(index + 4..index + 6)?
            } else {
                digit(index + 3..index + 5)?
            };
            if oh > 23 || om > 59 {
                return None;
            }
            offset_ms = sign * (oh * 3_600_000 + om * 60_000);
            index += if bytes.get(index + 3) == Some(&b':') { 6 } else { 5 };
        }
        _ => {}
    }
    if index != len {
        return None; // trailing garbage is a malformed stamp, not a date
    }
    let days = civil_days_from_iso(year, month, day);
    let base = (days * 86_400_000) + (hour * 3_600_000) + (minute * 60_000) + (second * 1_000) + millis;
    Some(base - offset_ms)
}

fn civil_days_from_iso(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod scan_report {
    use super::*;

    /// Differential-test bridge: read a file list from the --files argument
    /// and print one RUST-SCAN <json> line per file (the TS scanner's
    /// fixture test compares field for field). Ignored unless run
    /// explicitly with --ignored --files <list>.
    #[test]
    #[ignore]
    fn rust_scan_fixture_report() {
        let list = std::env::var("RUST_SCAN_FILES").expect("RUST_SCAN_FILES lists the fixtures");
        let content = std::fs::read_to_string(list).expect("the fixture list");
        for line in content.lines().filter(|line| !line.trim().is_empty()) {
            let path = std::path::PathBuf::from(line);
            let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
            match scan_session_file_info(&path) {
                Some(scan) => {
                    let report = json!({
                        "path": name,
                        "id": scan.id,
                        "cwd": scan.cwd,
                        "name": scan.name,
                        "parentSessionPath": scan.parent_session_path,
                        "createdMs": scan.created_ms,
                        "modifiedMs": scan.modified_ms,
                        "messageCount": scan.message_count,
                        "compactionCount": scan.compaction_count,
                        "firstMessage": scan.first_message,
                        "sizeBytes": scan.size_bytes,
                    });
                    println!("RUST-SCAN {report}");
                }
                None => println!("RUST-SCAN {{\"path\":\"{name}\",\"null\":true}}"),
            }
        }
    }
}
