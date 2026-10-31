//! The session spawn plan (M2): the pure half of `lib/pi-rpc/factory.ts`'s
//! `startCliRpcSessionFromManager` — everything about a child that can be
//! computed BEFORE it exists:
//!
//! - the CLI arguments per session kind (project / chat-only pin / chat
//!   workspace), including the discovery flags only the restricted kinds
//!   set — a PROJECT session keeps discovery on exactly like the Next
//!   factory (skills, context files and user extensions load);
//! - the pinned tool selection's `--tools` entries (the coding domain
//!   mapped through the powershell switch, which reads the same settings
//!   files pi itself reads);
//! - the session-file entry readers the plan needs (the persisted tool pin,
//!   the chat unlock marker, the saved model) — the same scans
//!   `lib/session-tool-selection.ts` / `lib/chat-unlock.ts` /
//!   `lib/session-projection.ts` run on the Next server;
//! - the private `--system-prompt` file (0600 inside a 0700 temp dir) the
//!   restricted kinds pass instead of pi's own prompt.
//!
//! Nothing here spawns anything or knows about the registry; `lib.rs`
//! consumes the plan, `src-tauri` assembles it (it owns workspace
//! classification and the management instance that builds the exact
//! prompts).

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// The coding tool domain (`lib/pi-rpc/factory.ts` CODING_TOOL_NAMES:
/// PRESET_FULL + powershell), in the exact order `buildToolEntries` emits.
pub const CODING_TOOL_NAMES: [&str; 8] = [
    "bash", "read", "edit", "write", "grep", "find", "ls", "powershell",
];

/// pi's own default tools (`settings-manager.js` DEFAULT_TOOL_NAMES) — what a
/// `defaultTools` list of pure modifiers starts from.
const PI_DEFAULT_TOOLS: [&str; 4] = ["read", "bash", "edit", "write"];

/// The builtin tool names a pinned selection may contain
/// (`lib/session-tool-selection.ts` BUILTIN_TOOL_NAMES = PRESET_FULL —
/// `powershell` is a mapping target, never a stored pin).
const PINNABLE_TOOL_NAMES: [&str; 7] = ["bash", "read", "edit", "write", "grep", "find", "ls"];

pub const TOOL_SELECTION_TYPE: &str = "pi-web:tool-selection";
pub const CHAT_UNLOCK_TYPE: &str = "pi-web:chat-unlock";

/// Is this entry a `+name` / `-name` modifier (pi's defaultTools syntax)?
fn is_tool_modifier(entry: &str) -> bool {
    entry.starts_with('+') || entry.starts_with('-')
}

/// Resolve a merged `defaultTools` list by pi's rule: plain names replace
/// `DEFAULT_TOOL_NAMES`, then each modifier applies in list order
/// (`resolveDefaultTools` in settings-manager.js).
fn resolve_default_tools(entries: &[String]) -> Vec<String> {
    let plain: Vec<&String> = entries.iter().filter(|entry| !is_tool_modifier(entry)).collect();
    let mut tools: Vec<String> = if !plain.is_empty() || entries.is_empty() {
        plain.into_iter().cloned().collect()
    } else {
        PI_DEFAULT_TOOLS.iter().map(|name| name.to_string()).collect()
    };
    for entry in entries {
        if !is_tool_modifier(entry) {
            continue;
        }
        let name = &entry[1..];
        if let Some(index) = tools.iter().position(|tool| tool == name) {
            if entry.starts_with('-') {
                tools.remove(index);
            }
        } else if entry.starts_with('+') && !name.is_empty() {
            tools.push(name.to_string());
        }
    }
    tools
}

/// Merge a project's defaultTools over the global one (`mergeDefaultTools`:
/// pure-modifier overrides append to the base; anything else replaces).
fn merge_default_tools(base: Option<&Vec<String>>, overrides: Option<&Vec<String>>) -> Option<Vec<String>> {
    match (base, overrides) {
        (_, None) => base.cloned(),
        (None, Some(overrides)) => Some(overrides.clone()),
        (Some(base), Some(overrides)) => {
            if !overrides.iter().all(|entry| is_tool_modifier(entry)) {
                return Some(overrides.clone());
            }
            let mut merged = base.clone();
            merged.extend(overrides.iter().cloned());
            Some(merged)
        }
    }
}

/// The `defaultTools` a session's child resolves: the global settings file
/// deep-merged with the project's (only when the project is trusted — pi
/// itself ignores an untrusted project's settings), resolved through the
/// modifier rules. `None` when no file names any (`getDefaultTools()`
/// returning undefined).
pub fn resolved_default_tools(agent_dir: &Path, cwd: &Path, project_trusted: bool) -> Option<Vec<String>> {
    let read = |path: &Path| -> Option<Vec<String>> {
        let text = std::fs::read_to_string(path).ok()?;
        let parsed: Value = serde_json::from_str(&text).ok()?;
        let entries = parsed.get("defaultTools")?.as_array()?;
        Some(
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
        )
    };
    let global = read(&agent_dir.join("settings.json"));
    let project = if project_trusted {
        read(&cwd.join(".pi").join("settings.json"))
    } else {
        None
    };
    merge_default_tools(global.as_ref(), project.as_ref()).map(|entries| resolve_default_tools(&entries))
}

/// The powershell switch (`lib/powershell-settings.ts` isPowerShellToolEnabled):
/// Windows-only, defaultTools selects powershell and not bash.
pub fn powershell_tool_enabled(default_tools: Option<&Vec<String>>, windows: bool) -> bool {
    windows
        && default_tools.is_some_and(|tools| tools.iter().any(|tool| tool == "powershell"))
        && default_tools.is_some_and(|tools| !tools.iter().any(|tool| tool == "bash"))
}

/// Map a selection's shell tools through the switch (`replaceShellTool`).
fn resolve_shell_tools(tool_names: &[String], use_powershell: bool) -> Vec<String> {
    let shell = if use_powershell { "powershell" } else { "bash" };
    let mut result: Vec<String> = Vec::new();
    for name in tool_names {
        let next = if name == "bash" || name == "powershell" { shell } else { name.as_str() };
        if !result.iter().any(|tool| tool == next) {
            result.push(next.to_string());
        }
    }
    result
}

/// pi's relative `--tools` entries for a pinned selection (`buildToolEntries`):
/// every coding tool gets an explicit `+`/`-` so an unselected shell can never
/// survive through the child's defaults.
pub fn build_tool_entries(selection: &[String], default_tools: Option<&Vec<String>>) -> Vec<String> {
    let use_powershell = powershell_tool_enabled(default_tools, cfg!(windows));
    let coding: Vec<String> = selection
        .iter()
        .filter(|name| CODING_TOOL_NAMES.contains(&name.as_str()))
        .cloned()
        .collect();
    let selected = resolve_shell_tools(&coding, use_powershell);
    CODING_TOOL_NAMES
        .iter()
        .map(|name| {
            if selected.iter().any(|tool| tool == name) {
                format!("+{name}")
            } else {
                format!("-{name}")
            }
        })
        .collect()
}

/// Validate a requested pin exactly like `validateSessionToolSelection`:
/// every name must be a builtin (PRESET_FULL) tool, duplicates collapse.
pub fn validate_tool_selection(tools: &[Value]) -> Option<Vec<String>> {
    let mut names: Vec<String> = Vec::new();
    for tool in tools {
        let name = tool.as_str()?;
        if !PINNABLE_TOOL_NAMES.contains(&name) {
            return None;
        }
        if !names.iter().any(|existing| existing == name) {
            names.push(name.to_string());
        }
    }
    Some(names)
}

// ---------------------------------------------------------------------------
// The session-file entry readers (append-only custom entries)
// ---------------------------------------------------------------------------

/// One parsed JSONL entry line (already an object) with its `type`.
struct EntryLine {
    kind: String,
    value: Value,
}

/// Stream a session file's entry lines (skipping the header); a torn or
/// unparsable line is skipped, exactly like `parseSessionEntries`.
fn read_entry_lines(path: &Path) -> Vec<EntryLine> {
    let Ok(file) = std::fs::File::open(path) else { return Vec::new() };
    use std::io::BufRead;
    let mut entries = Vec::new();
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(kind) = value.get("type").and_then(Value::as_str) else { continue };
        if kind == "session" {
            continue;
        }
        entries.push(EntryLine { kind: kind.to_string(), value });
    }
    entries
}

fn custom_entries_rev<'a>(entries: &'a [EntryLine], custom_type: &'a str) -> impl Iterator<Item = &'a Value> + 'a {
    entries.iter().rev().filter_map(move |entry| {
        if entry.kind == "custom" && entry.value.get("customType").and_then(Value::as_str) == Some(custom_type) {
            Some(&entry.value)
        } else {
            None
        }
    })
}

/// The newest valid persisted tool pin (`readSessionToolSelection`):
/// `None` = no pin of its own (legacy, unpinned, or explicitly cleared).
pub fn read_session_tool_selection(path: &Path) -> Option<Vec<String>> {
    let entries = read_entry_lines(path);
    for entry in custom_entries_rev(&entries, TOOL_SELECTION_TYPE) {
        let Some(data) = entry.get("data") else { continue };
        if data.get("version").and_then(Value::as_i64) != Some(1) {
            continue;
        }
        if data.get("cleared").and_then(Value::as_bool) == Some(true) {
            return None;
        }
        let Some(tools) = data.get("tools").and_then(Value::as_array) else { continue };
        let names: Vec<String> = tools
            .iter()
            .filter_map(Value::as_str)
            .filter(|name| PINNABLE_TOOL_NAMES.contains(name))
            .map(str::to_string)
            .collect();
        if names.len() != tools.len() {
            continue; // An invalid pin entry is skipped, not trusted.
        }
        let mut unique: Vec<String> = Vec::new();
        for name in names {
            if !unique.contains(&name) {
                unique.push(name);
            }
        }
        return Some(unique);
    }
    None
}

/// The chat unlock marker (`readChatUnlocked`): the newest valid
/// `pi-web:chat-unlock` entry decides; absent means locked.
pub fn read_chat_unlocked(path: &Path) -> bool {
    let entries = read_entry_lines(path);
    for entry in custom_entries_rev(&entries, CHAT_UNLOCK_TYPE) {
        let Some(data) = entry.get("data") else { continue };
        if data.get("version").and_then(Value::as_i64) == Some(1) {
            if let Some(unlocked) = data.get("unlocked").and_then(Value::as_bool) {
                return unlocked;
            }
        }
    }
    false
}

/// The saved model: the newest `model_change` entry, else the newest
/// assistant response's provider/model pair (`getLatestModelChange` ??
/// `getLatestResponseModel` — the factory's restore order).
pub fn read_saved_model(path: &Path) -> Option<(String, String)> {
    let entries = read_entry_lines(path);
    for entry in entries.iter().rev() {
        if entry.kind == "model_change" {
            let provider = entry.value.get("provider").and_then(Value::as_str)?;
            let model_id = entry.value.get("modelId").and_then(Value::as_str)?;
            return Some((provider.to_string(), model_id.to_string()));
        }
    }
    for entry in entries.iter().rev() {
        if entry.kind != "message" {
            continue;
        }
        let Some(message) = entry.value.get("message") else { continue };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let provider = message.get("provider").and_then(Value::as_str)?;
        let model = message.get("model").and_then(Value::as_str)?;
        return Some((provider.to_string(), model.to_string()));
    }
    None
}

/// Append a custom entry to a session file (the host owns custom entries:
/// `appendSessionToolSelection`'s write shape, id/parentId/timestamp
/// following the file's leaf — the SDK's appendCustomEntry contract).
pub fn append_custom_entry(path: &Path, custom_type: &str, data: Value) -> std::io::Result<()> {
    // parentId is the file's current leaf (the SDK's appendCustomEntry); a
    // file with no entries yet has no leaf, and the first entry's parent is
    // null (the session format's shape).
    let lines = read_entry_lines(path);
    let parent = lines
        .iter()
        .rev()
        .find_map(|entry| entry.value.get("id").and_then(Value::as_str).map(str::to_string))
        .map(Value::String)
        .unwrap_or(Value::Null);
    let mut existing_ids: Vec<String> = lines
        .iter()
        .filter_map(|entry| entry.value.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut id = format!("{:08x}", rand_u32());
    for _ in 0..100 {
        if !existing_ids.contains(&id) {
            break;
        }
        id = format!("{:08x}", rand_u32());
    }
    let entry = json!({
        "type": "custom",
        "id": id,
        "parentId": parent,
        "timestamp": crate::iso_now_iso(),
        "customType": custom_type,
        "data": data,
    });
    existing_ids.clear();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut handle = std::fs::OpenOptions::new().append(true).mode(0o600).open(path)?;
        handle.write_all(format!("{entry}\n").as_bytes())?;
    }
    #[cfg(not(unix))]
    {
        let mut handle = std::fs::OpenOptions::new().append(true).open(path)?;
        handle.write_all(format!("{entry}\n").as_bytes())?;
    }
    Ok(())
}

/// 32 random bits in hex (entry ids are 8 hex chars in pi's files, the
/// same slice-of-a-UUID shape `generateId` produces).
fn rand_u32() -> u32 {
    uuid::Uuid::new_v4().as_bytes()[0..4].iter().fold(0u32, |acc, byte| (acc << 8) | *byte as u32)
}

// (The bundled uuid crate provides the randomness; no FFI needed.)

// ---------------------------------------------------------------------------
// The private --system-prompt file (createExactPromptFile's contract)
// ---------------------------------------------------------------------------

/// Write the exact prompt to a private temp file (0700 dir, 0600 file): the
/// prompt can carry the project's context files, so it must not sit in the
/// shared tmp under a predictable name. The caller removes the dir once the
/// child has started (pi reads --system-prompt once at startup).
pub fn write_prompt_file(prompt: &str) -> std::io::Result<PathBuf> {
    let name: String = uuid::Uuid::new_v4()
        .simple()
        .encode_upper(&mut uuid::Uuid::encode_buffer())
        .chars()
        .take(16)
        .collect();
    let dir = std::env::temp_dir().join(format!("pi-web-prompt-{name}"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir(&dir)?;
    let file = dir.join("system-prompt.txt");
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut handle = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&file)?;
        handle.write_all(prompt.as_bytes())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&file, prompt)?;
    Ok(file)
}

/// Remove a prompt file's private dir (best effort; startup consumed it).
pub fn remove_prompt_file(file: &Path) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(path: &Path, lines: &[Value]) {
        let header = json!({ "type": "session", "version": 3, "id": "s1", "cwd": "/w" });
        let mut text = format!("{header}\n");
        for line in lines {
            text.push_str(&format!("{line}\n"));
        }
        std::fs::write(path, text).expect("write");
    }

    #[test]
    fn tool_entries_map_the_coding_domain_explicitly() {
        let selection: Vec<String> = ["read", "bash", "grep"].map(String::from).to_vec();
        let entries = build_tool_entries(&selection, None);
        assert_eq!(
            entries,
            vec!["+bash", "+read", "-edit", "-write", "+grep", "-find", "-ls", "-powershell"]
        );
        // A powershell-defaults machine maps the shell the other way.
        let defaults: Vec<String> = ["read", "powershell", "edit", "write"].map(String::from).to_vec();
        if cfg!(windows) {
            let mapped = build_tool_entries(&selection, Some(&defaults));
            assert_eq!(mapped[0], "-bash");
            assert_eq!(mapped[7], "+powershell");
        } else {
            // On non-Windows the switch never engages (identity mapping).
            let mapped = build_tool_entries(&selection, Some(&defaults));
            assert_eq!(mapped[0], "+bash");
            assert_eq!(mapped[7], "-powershell");
        }
    }

    #[test]
    fn default_tools_resolve_the_pi_way() {
        // Plain names replace the defaults; modifiers apply in order.
        let entries: Vec<String> = ["+ls", "read"].map(String::from).to_vec();
        assert_eq!(resolve_default_tools(&entries), vec!["read", "ls"]);
        let modifiers: Vec<String> = ["-bash", "+ls"].map(String::from).to_vec();
        assert_eq!(resolve_default_tools(&modifiers), vec!["read", "edit", "write", "ls"]);
    }

    #[test]
    fn tool_selection_round_trips_through_the_file() {
        let dir = tempfile::tempdir().expect("dir");
        let file = dir.path().join("s.jsonl");
        write_file(&file, &[]);
        assert_eq!(read_session_tool_selection(&file), None, "no pin of its own");
        append_custom_entry(
            &file,
            TOOL_SELECTION_TYPE,
            json!({ "version": 1, "tools": ["read", "bash", "read"] }),
        )
        .expect("append");
        assert_eq!(
            read_session_tool_selection(&file),
            Some(vec!["read".to_string(), "bash".to_string()]),
            "duplicates collapse like the TS reader"
        );
        append_custom_entry(&file, TOOL_SELECTION_TYPE, json!({ "version": 1, "cleared": true }))
            .expect("clear");
        assert_eq!(read_session_tool_selection(&file), None, "a cleared pin retracts");
    }

    #[test]
    fn chat_unlock_reads_the_newest_marker() {
        let dir = tempfile::tempdir().expect("dir");
        let file = dir.path().join("s.jsonl");
        write_file(&file, &[]);
        assert!(!read_chat_unlocked(&file));
        append_custom_entry(&file, CHAT_UNLOCK_TYPE, json!({ "version": 1, "unlocked": true })).expect("unlock");
        assert!(read_chat_unlocked(&file));
        append_custom_entry(&file, CHAT_UNLOCK_TYPE, json!({ "version": 1, "unlocked": false })).expect("relock");
        assert!(!read_chat_unlocked(&file), "the newest marker wins");
    }

    #[test]
    fn saved_model_prefers_model_change_over_response_metadata() {
        let dir = tempfile::tempdir().expect("dir");
        let file = dir.path().join("s.jsonl");
        write_file(
            &file,
            &[
                json!({ "type": "message", "id": "1", "parentId": "", "message": { "role": "assistant", "content": "hi", "provider": "p1", "model": "m1" } }),
                json!({ "type": "model_change", "id": "2", "parentId": "1", "provider": "p2", "modelId": "m2" }),
            ],
        );
        assert_eq!(read_saved_model(&file), Some(("p2".into(), "m2".into())));
        let other = dir.path().join("t.jsonl");
        write_file(
            &other,
            &[json!({ "type": "message", "id": "1", "parentId": "", "message": { "role": "assistant", "content": "hi", "provider": "p1", "model": "m1" } })],
        );
        assert_eq!(read_saved_model(&other), Some(("p1".into(), "m1".into())));
    }

    #[test]
    fn prompt_files_are_private_and_removable() {
        let file = write_prompt_file("the exact prompt").expect("prompt file");
        assert_eq!(std::fs::read_to_string(&file).expect("read"), "the exact prompt");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir_mode = std::fs::metadata(file.parent().unwrap()).unwrap().permissions().mode() & 0o777;
            let file_mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(dir_mode, 0o700);
            assert_eq!(file_mode, 0o600);
        }
        remove_prompt_file(&file);
        assert!(!file.exists());
    }
}
