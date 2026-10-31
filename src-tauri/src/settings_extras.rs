//! Settings Extras (migration M3):
//! Host-side handling for configuration domains:
//! - tools.settingsGet / tools.settingsSet
//! - artifacts.settingsGet / artifacts.settingsSet
//! - chats.settingsGet / chats.settingsSet
//! - appearance.customCssGet / appearance.customCssSet

use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const DEFAULT_TOOLS: [&str; 4] = ["read", "bash", "edit", "write"];
const SHELL_TOOLS: [&str; 2] = ["bash", "powershell"];
const CODEMODE: &str = "codemode";
const CODEMODE_INLINE_BUDGET_MAX: u64 = 1_000_000;
const CHAT_INSTRUCTIONS_MAX_CHARS: usize = 8000;
const CHAT_ALLOWED_TOOLS_MAX: usize = 50;

const CHAT_THINKING_LEVELS: [&str; 7] = [
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

const STARTER_CSS: &str = r#"/* Pi Agent custom stylesheet.
 * Loaded last, so these rules win the cascade.
 * Reload the window (Ctrl+R / Cmd+R) to apply edits.
 *
 * Font variables used by the app:
 *   --font-ui       chat and interface text
 *   --font-display  headings
 *   --font-mono     code blocks and tool output
 *
 * Example:
 * :root {
 *   --font-ui: "Inter", "Segoe UI", -apple-system, sans-serif;
 *   --font-mono: "Cascadia Code", "JetBrains Mono", monospace;
 * }
 * .markdown-body { font-size: 15px; }
 */
"#;

#[derive(Debug, PartialEq)]
pub enum SettingsExtrasError {
    InvalidArgs {
        message: String,
        reason: Option<String>,
    },
    NotFound {
        message: String,
        reason: Option<String>,
    },
    CorruptFile {
        message: String,
        reason: Option<String>,
    },
    Io {
        message: String,
        reason: Option<String>,
    },
}

impl std::fmt::Display for SettingsExtrasError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidArgs { message, .. } => write!(f, "{message}"),
            Self::NotFound { message, .. } => write!(f, "{message}"),
            Self::CorruptFile { message, .. } => write!(f, "{message}"),
            Self::Io { message, .. } => write!(f, "{message}"),
        }
    }
}

impl SettingsExtrasError {
    pub fn to_protocol_value(&self, id: &str) -> Value {
        match self {
            Self::InvalidArgs { message, reason } => {
                let mut err = json!({
                    "code": "invalid_args",
                    "message": message,
                    "retryable": false,
                });
                if let Some(r) = reason {
                    err["reason"] = json!(r);
                }
                json!({ "v": 1, "id": id, "ok": false, "error": err })
            }
            Self::NotFound { message, reason } => {
                let mut err = json!({
                    "code": "not_found",
                    "message": message,
                    "retryable": false,
                });
                if let Some(r) = reason {
                    err["reason"] = json!(r);
                }
                json!({ "v": 1, "id": id, "ok": false, "error": err })
            }
            Self::CorruptFile { message, reason } => {
                let mut err = json!({
                    "code": "io",
                    "message": message,
                    "retryable": false,
                });
                if let Some(r) = reason {
                    err["reason"] = json!(r);
                }
                json!({ "v": 1, "id": id, "ok": false, "error": err })
            }
            Self::Io { message, reason } => {
                let mut err = json!({
                    "code": "io",
                    "message": message,
                    "retryable": false,
                });
                if let Some(r) = reason {
                    err["reason"] = json!(r);
                }
                json!({ "v": 1, "id": id, "ok": false, "error": err })
            }
        }
    }
}

fn write_private_atomic(path: &Path, content: &str) -> Result<(), SettingsExtrasError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| SettingsExtrasError::Io {
            message: format!("failed to create directory {}: {e}", parent.display()),
            reason: None,
        })?;
    }
    let counter = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("tmp");
    let temp_name = format!("{file_stem}.tmp.{now}.{counter}.{ext}");
    let temp_path = path.with_file_name(temp_name);

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temp_path)
            .map_err(|e| SettingsExtrasError::Io {
                message: format!("failed to open temp file {}: {e}", temp_path.display()),
                reason: None,
            })?;
        file.write_all(content.as_bytes())
            .map_err(|e| SettingsExtrasError::Io {
                message: format!("failed to write temp file {}: {e}", temp_path.display()),
                reason: None,
            })?;
        file.flush().map_err(|e| SettingsExtrasError::Io {
            message: format!("failed to flush temp file {}: {e}", temp_path.display()),
            reason: None,
        })?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&temp_path, content).map_err(|e| SettingsExtrasError::Io {
            message: format!("failed to write temp file {}: {e}", temp_path.display()),
            reason: None,
        })?;
    }

    std::fs::rename(&temp_path, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        SettingsExtrasError::Io {
            message: format!(
                "failed to rename {} to {}: {e}",
                temp_path.display(),
                path.display()
            ),
            reason: None,
        }
    })?;
    Ok(())
}

fn read_json_object(path: &Path, name: &str) -> Result<Option<Map<String, Value>>, SettingsExtrasError> {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => Ok(Some(map)),
            _ => Err(SettingsExtrasError::CorruptFile {
                message: format!("Invalid {name}: expected an object"),
                reason: Some("internal".to_string()),
            }),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(SettingsExtrasError::Io {
            message: format!("failed to read {name} at {}: {e}", path.display()),
            reason: Some("internal".to_string()),
        }),
    }
}

// ---------------------------------------------------------------------------
// Tools Settings
// ---------------------------------------------------------------------------

fn is_tool_modifier(entry: &str) -> bool {
    entry.starts_with('+') || entry.starts_with('-')
}

fn resolve_default_tool_entries(entries: &[String]) -> Vec<String> {
    let plain: Vec<String> = entries
        .iter()
        .filter(|e| !is_tool_modifier(e))
        .cloned()
        .collect();
    let mut tools = if !plain.is_empty() || entries.is_empty() {
        plain
    } else {
        DEFAULT_TOOLS.iter().map(|&s| s.to_string()).collect()
    };
    for entry in entries {
        if !is_tool_modifier(entry) {
            continue;
        }
        let name = &entry[1..];
        if name.is_empty() {
            continue;
        }
        if entry.starts_with('+') {
            if !tools.iter().any(|t| t == name) {
                tools.push(name.to_string());
            }
        } else if entry.starts_with('-') {
            if let Some(pos) = tools.iter().position(|t| t == name) {
                tools.remove(pos);
            }
        }
    }
    tools
}

fn extract_default_tool_entries(settings: &Map<String, Value>) -> Result<Option<Vec<String>>, SettingsExtrasError> {
    let Some(val) = settings.get("defaultTools") else {
        return Ok(None);
    };
    let Some(arr) = val.as_array() else {
        return Err(SettingsExtrasError::CorruptFile {
            message: "Invalid settings.json: defaultTools must be an array of strings".to_string(),
            reason: Some("internal".to_string()),
        });
    };
    let mut list = Vec::new();
    for item in arr {
        let Some(s) = item.as_str() else {
            return Err(SettingsExtrasError::CorruptFile {
                message: "Invalid settings.json: defaultTools must be an array of strings".to_string(),
                reason: Some("internal".to_string()),
            });
        };
        list.push(s.to_string());
    }
    Ok(Some(list))
}

fn replace_shell_tool(tool_names: &[String], use_powershell: bool) -> Vec<String> {
    let shell = if use_powershell { "powershell" } else { "bash" };
    let mut result = Vec::new();
    for name in tool_names {
        let next = if SHELL_TOOLS.contains(&name.as_str()) {
            shell
        } else {
            name.as_str()
        };
        if !result.iter().any(|r| r == next) {
            result.push(next.to_string());
        }
    }
    result
}

fn invalid_value_text(val: &Value) -> String {
    let json = val.to_string();
    if json.len() > 60 {
        format!("{}…", &json[..59])
    } else {
        json
    }
}

pub fn tools_settings_get(agent_dir: &Path) -> Result<Value, SettingsExtrasError> {
    let path = agent_dir.join("settings.json");
    let settings = read_json_object(&path, "settings.json")?.unwrap_or_default();
    tools_settings_from_map(&settings)
}

fn tools_settings_from_map(settings: &Map<String, Value>) -> Result<Value, SettingsExtrasError> {
    let is_windows = cfg!(windows);
    let default_tool_entries = extract_default_tool_entries(settings)?;
    let resolved_tools = default_tool_entries
        .as_ref()
        .map(|entries| resolve_default_tool_entries(entries));

    let power_shell_enabled = if is_windows {
        resolved_tools.as_ref().is_some_and(|tools| {
            tools.iter().any(|t| t == "powershell") && !tools.iter().any(|t| t == "bash")
        })
    } else {
        false
    };

    let codemode_pref = if resolved_tools
        .as_ref()
        .is_some_and(|tools| tools.iter().any(|t| t == CODEMODE))
    {
        "always"
    } else {
        "automatic"
    };

    let codemode_obj = settings.get("codemode").and_then(Value::as_object);

    let codemode_mode = match codemode_obj.and_then(|c| c.get("mode")) {
        Some(Value::String(s)) if s == "only" => json!({ "value": "only" }),
        None | Some(Value::String(_)) if codemode_obj.and_then(|c| c.get("mode")).and_then(Value::as_str) == Some("on") => {
            json!({ "value": "on" })
        }
        None => json!({ "value": "on" }),
        Some(other) => json!({
            "value": "on",
            "invalid": invalid_value_text(other),
        }),
    };

    let codemode_budget = match codemode_obj.and_then(|c| c.get("inlineBudget")) {
        None => json!({}),
        Some(Value::Number(n)) if n.as_u64().is_some() => json!({ "value": n.as_u64().unwrap() }),
        Some(other) => json!({ "invalid": invalid_value_text(other) }),
    };

    Ok(json!({
        "isWindows": is_windows,
        "powerShellEnabled": power_shell_enabled,
        "codemode": codemode_pref,
        "codemodeMode": codemode_mode,
        "codemodeInlineBudget": codemode_budget,
    }))
}

pub fn tools_settings_set(agent_dir: &Path, args: &Value) -> Result<Value, SettingsExtrasError> {
    let Some(obj) = args.as_object() else {
        return Err(SettingsExtrasError::InvalidArgs {
            message: "Expected a JSON object".to_string(),
            reason: Some("invalid-request".to_string()),
        });
    };

    let keys = ["enabled", "codemode", "codemodeMode", "codemodeInlineBudget"];
    let count = keys.iter().filter(|&&k| obj.contains_key(k)).count();
    if count != 1 {
        return Err(SettingsExtrasError::InvalidArgs {
            message: "Send one of enabled (PowerShell), codemode, codemodeMode or codemodeInlineBudget".to_string(),
            reason: Some("invalid-request".to_string()),
        });
    }

    let path = agent_dir.join("settings.json");
    let mut settings = read_json_object(&path, "settings.json")?.unwrap_or_default();

    if let Some(mode_val) = obj.get("codemodeMode") {
        let Some(mode) = mode_val.as_str() else {
            return Err(SettingsExtrasError::InvalidArgs {
                message: "codemodeMode must be \"on\" or \"only\"".to_string(),
                reason: Some("invalid-request".to_string()),
            });
        };
        if mode != "on" && mode != "only" {
            return Err(SettingsExtrasError::InvalidArgs {
                message: "codemodeMode must be \"on\" or \"only\"".to_string(),
                reason: Some("invalid-request".to_string()),
            });
        }
        if let Some(existing_cm) = settings.get("codemode") {
            if !existing_cm.is_object() {
                return Err(SettingsExtrasError::CorruptFile {
                    message: "Invalid settings.json: codemode must be an object".to_string(),
                    reason: Some("internal".to_string()),
                });
            }
        }

        if mode == "only" {
            let cm = settings
                .entry("codemode")
                .or_insert_with(|| json!({}))
                .as_object_mut()
                .unwrap();
            cm.insert("mode".to_string(), json!("only"));
        } else {
            if let Some(cm) = settings.get_mut("codemode").and_then(Value::as_object_mut) {
                cm.remove("mode");
                if cm.is_empty() {
                    settings.remove("codemode");
                }
            }
        }
        write_private_atomic(&path, &serde_json::to_string_pretty(&settings).unwrap())?;
        return tools_settings_from_map(&settings);
    }

    if let Some(budget_val) = obj.get("codemodeInlineBudget") {
        let budget_opt = if budget_val.is_null() {
            None
        } else if let Some(n) = budget_val.as_u64() {
            if n > CODEMODE_INLINE_BUDGET_MAX {
                return Err(SettingsExtrasError::InvalidArgs {
                    message: format!(
                        "codemodeInlineBudget must be a whole number from 0 to {CODEMODE_INLINE_BUDGET_MAX}, or null"
                    ),
                    reason: Some("invalid-request".to_string()),
                });
            }
            Some(n)
        } else {
            return Err(SettingsExtrasError::InvalidArgs {
                message: format!(
                    "codemodeInlineBudget must be a whole number from 0 to {CODEMODE_INLINE_BUDGET_MAX}, or null"
                ),
                reason: Some("invalid-request".to_string()),
            });
        };

        if let Some(existing_cm) = settings.get("codemode") {
            if !existing_cm.is_object() {
                return Err(SettingsExtrasError::CorruptFile {
                    message: "Invalid settings.json: codemode must be an object".to_string(),
                    reason: Some("internal".to_string()),
                });
            }
        }

        match budget_opt {
            Some(budget) => {
                let cm = settings
                    .entry("codemode")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .unwrap();
                cm.insert("inlineBudget".to_string(), json!(budget));
            }
            None => {
                if let Some(cm) = settings.get_mut("codemode").and_then(Value::as_object_mut) {
                    cm.remove("inlineBudget");
                    if cm.is_empty() {
                        settings.remove("codemode");
                    }
                }
            }
        }
        write_private_atomic(&path, &serde_json::to_string_pretty(&settings).unwrap())?;
        return tools_settings_from_map(&settings);
    }

    if let Some(cm_val) = obj.get("codemode") {
        let Some(pref) = cm_val.as_str() else {
            return Err(SettingsExtrasError::InvalidArgs {
                message: "codemode must be \"automatic\" or \"always\"".to_string(),
                reason: Some("invalid-request".to_string()),
            });
        };
        if pref != "automatic" && pref != "always" {
            return Err(SettingsExtrasError::InvalidArgs {
                message: "codemode must be \"automatic\" or \"always\"".to_string(),
                reason: Some("invalid-request".to_string()),
            });
        }

        let default_tools_opt = extract_default_tool_entries(&settings)?;
        let kept: Vec<String> = default_tools_opt
            .as_ref()
            .unwrap_or(&Vec::new())
            .iter()
            .filter(|e| {
                let name = if is_tool_modifier(e) { &e[1..] } else { e.as_str() };
                name != CODEMODE
            })
            .cloned()
            .collect();

        if pref == "always" {
            let mut next = kept;
            next.push(format!("+{CODEMODE}"));
            settings.insert("defaultTools".to_string(), json!(next));
        } else if !kept.is_empty() {
            settings.insert("defaultTools".to_string(), json!(kept));
        } else if default_tools_opt
            .as_ref()
            .is_some_and(|entries| entries.iter().any(|e| !is_tool_modifier(e)))
        {
            settings.insert("defaultTools".to_string(), json!([]));
        } else {
            settings.remove("defaultTools");
        }

        write_private_atomic(&path, &serde_json::to_string_pretty(&settings).unwrap())?;
        return tools_settings_from_map(&settings);
    }

    if let Some(enabled_val) = obj.get("enabled") {
        if !cfg!(windows) {
            return Err(SettingsExtrasError::NotFound {
                message: "PowerShell tool settings are only available on Windows".to_string(),
                reason: Some("invalid-request".to_string()),
            });
        }
        let Some(enabled) = enabled_val.as_bool() else {
            return Err(SettingsExtrasError::InvalidArgs {
                message: "enabled must be a boolean".to_string(),
                reason: Some("invalid-request".to_string()),
            });
        };

        let default_tools_opt = extract_default_tool_entries(&settings)?;
        let current_tools = default_tools_opt
            .as_ref()
            .map(|entries| resolve_default_tool_entries(entries))
            .unwrap_or_else(|| DEFAULT_TOOLS.iter().map(|&s| s.to_string()).collect());

        let mut next_tools = replace_shell_tool(&current_tools, enabled);
        if !current_tools.iter().any(|n| SHELL_TOOLS.contains(&n.as_str())) {
            next_tools.push(if enabled { "powershell" } else { "bash" }.to_string());
        }

        settings.insert("defaultTools".to_string(), json!(next_tools));
        write_private_atomic(&path, &serde_json::to_string_pretty(&settings).unwrap())?;
        return tools_settings_from_map(&settings);
    }

    unreachable!()
}

// ---------------------------------------------------------------------------
// Artifacts Settings
// ---------------------------------------------------------------------------

pub fn artifacts_settings_get(agent_dir: &Path) -> Result<Value, SettingsExtrasError> {
    let path = agent_dir.join("pi-web").join("settings.json");
    let enabled = match read_json_object(&path, "Pi Web settings") {
        Ok(Some(stored)) => stored.get("artifactsPrompt").and_then(Value::as_bool) != Some(false),
        _ => true,
    };
    Ok(json!({ "enabled": enabled }))
}

pub fn artifacts_settings_set(agent_dir: &Path, args: &Value) -> Result<Value, SettingsExtrasError> {
    let Some(obj) = args.as_object() else {
        return Err(SettingsExtrasError::InvalidArgs {
            message: "Expected a JSON object".to_string(),
            reason: None,
        });
    };
    let Some(enabled) = obj.get("enabled").and_then(Value::as_bool) else {
        return Err(SettingsExtrasError::InvalidArgs {
            message: "enabled must be a boolean".to_string(),
            reason: None,
        });
    };

    let path = agent_dir.join("pi-web").join("settings.json");
    let mut stored = read_json_object(&path, "Pi Web settings")?.unwrap_or_default();
    stored.insert("version".to_string(), json!(1));
    stored.insert("artifactsPrompt".to_string(), json!(enabled));

    write_private_atomic(&path, &serde_json::to_string_pretty(&stored).unwrap())?;
    Ok(json!({ "enabled": enabled }))
}

// ---------------------------------------------------------------------------
// Chats Settings
// ---------------------------------------------------------------------------

fn is_valid_chat_tool_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    name.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == ':' || c == '-'
    })
}

fn parse_chat_settings_block(raw: Option<&Value>) -> (Value, Value, String, Vec<String>, bool) {
    let Some(obj) = raw.and_then(Value::as_object) else {
        return (Value::Null, Value::Null, String::new(), Vec::new(), false);
    };

    let model = match obj.get("model").and_then(Value::as_object) {
        Some(m) => {
            let p = m.get("provider").and_then(Value::as_str);
            let id = m.get("modelId").and_then(Value::as_str);
            if let (Some(provider), Some(model_id)) = (p, id) {
                if !provider.is_empty() && !model_id.is_empty() {
                    json!({ "provider": provider, "modelId": model_id })
                } else {
                    Value::Null
                }
            } else {
                Value::Null
            }
        }
        None => Value::Null,
    };

    let thinking_level = match obj.get("thinkingLevel").and_then(Value::as_str) {
        Some(s) if CHAT_THINKING_LEVELS.contains(&s) => json!(s),
        _ => Value::Null,
    };

    let instructions = match obj.get("instructions").and_then(Value::as_str) {
        Some(s) => {
            if s.chars().count() > CHAT_INSTRUCTIONS_MAX_CHARS {
                s.chars().take(CHAT_INSTRUCTIONS_MAX_CHARS).collect()
            } else {
                s.to_string()
            }
        }
        None => String::new(),
    };

    let mut allowed_tools = Vec::new();
    if let Some(arr) = obj.get("allowedTools").and_then(Value::as_array) {
        let mut seen = BTreeSet::new();
        for item in arr {
            if let Some(s) = item.as_str() {
                if is_valid_chat_tool_name(s) && seen.insert(s.to_string()) {
                    allowed_tools.push(s.to_string());
                    if allowed_tools.len() >= CHAT_ALLOWED_TOOLS_MAX {
                        break;
                    }
                }
            }
        }
    }

    let confirm_save = obj.get("confirmSave").and_then(Value::as_bool) == Some(true);

    (model, thinking_level, instructions, allowed_tools, confirm_save)
}

pub fn chats_settings_get(agent_dir: &Path) -> Result<Value, SettingsExtrasError> {
    let path = agent_dir.join("pi-web").join("settings.json");
    let stored = match read_json_object(&path, "Pi Web settings") {
        Ok(Some(map)) => map,
        _ => Map::new(),
    };

    let (model, thinking_level, instructions, allowed_tools, confirm_save) =
        parse_chat_settings_block(stored.get("chats"));

    Ok(json!({
        "model": model,
        "thinkingLevel": thinking_level,
        "instructions": instructions,
        "allowedTools": allowed_tools,
        "confirmSave": confirm_save,
        "instructionsMaxChars": CHAT_INSTRUCTIONS_MAX_CHARS,
    }))
}

pub fn chats_settings_set(agent_dir: &Path, args: &Value) -> Result<Value, SettingsExtrasError> {
    let Some(patch) = args.as_object() else {
        return Err(SettingsExtrasError::InvalidArgs {
            message: "Expected an object".to_string(),
            reason: None,
        });
    };

    let path = agent_dir.join("pi-web").join("settings.json");
    let mut stored = read_json_object(&path, "Pi Web settings")?.unwrap_or_default();

    let (mut model, mut thinking_level, mut instructions, mut allowed_tools, mut confirm_save) =
        parse_chat_settings_block(stored.get("chats"));

    if let Some(m_val) = patch.get("model") {
        if m_val.is_null() {
            model = Value::Null;
        } else if let Some(m) = m_val.as_object() {
            let p = m.get("provider").and_then(Value::as_str);
            let id = m.get("modelId").and_then(Value::as_str);
            match (p, id) {
                (Some(provider), Some(model_id)) if !provider.is_empty() && !model_id.is_empty() => {
                    model = json!({ "provider": provider, "modelId": model_id });
                }
                _ => {
                    return Err(SettingsExtrasError::InvalidArgs {
                        message: "model must be null or { provider, modelId }".to_string(),
                        reason: None,
                    });
                }
            }
        } else {
            return Err(SettingsExtrasError::InvalidArgs {
                message: "model must be null or { provider, modelId }".to_string(),
                reason: None,
            });
        }
    }

    if let Some(tl_val) = patch.get("thinkingLevel") {
        if tl_val.is_null() {
            thinking_level = Value::Null;
        } else if let Some(s) = tl_val.as_str() {
            if CHAT_THINKING_LEVELS.contains(&s) {
                thinking_level = json!(s);
            } else {
                return Err(SettingsExtrasError::InvalidArgs {
                    message: "thinkingLevel must be null or a reasoning level".to_string(),
                    reason: None,
                });
            }
        } else {
            return Err(SettingsExtrasError::InvalidArgs {
                message: "thinkingLevel must be null or a reasoning level".to_string(),
                reason: None,
            });
        }
    }

    if let Some(inst_val) = patch.get("instructions") {
        let Some(s) = inst_val.as_str() else {
            return Err(SettingsExtrasError::InvalidArgs {
                message: "instructions must be a string".to_string(),
                reason: None,
            });
        };
        if s.chars().count() > CHAT_INSTRUCTIONS_MAX_CHARS {
            return Err(SettingsExtrasError::InvalidArgs {
                message: format!("instructions are limited to {CHAT_INSTRUCTIONS_MAX_CHARS} characters"),
                reason: None,
            });
        }
        instructions = s.to_string();
    }

    if let Some(tools_val) = patch.get("allowedTools") {
        let Some(arr) = tools_val.as_array() else {
            return Err(SettingsExtrasError::InvalidArgs {
                message: "allowedTools must be an array of tool names".to_string(),
                reason: None,
            });
        };
        let mut seen = BTreeSet::new();
        let mut list = Vec::new();
        for item in arr {
            let Some(name) = item.as_str() else {
                return Err(SettingsExtrasError::InvalidArgs {
                    message: "allowedTools must be an array of tool names".to_string(),
                    reason: None,
                });
            };
            if !is_valid_chat_tool_name(name) {
                return Err(SettingsExtrasError::InvalidArgs {
                    message: format!("\"{name}\" is not a valid tool name"),
                    reason: None,
                });
            }
            if seen.insert(name.to_string()) {
                list.push(name.to_string());
            }
        }
        if list.len() > CHAT_ALLOWED_TOOLS_MAX {
            return Err(SettingsExtrasError::InvalidArgs {
                message: format!("at most {CHAT_ALLOWED_TOOLS_MAX} tools can be allowed"),
                reason: None,
            });
        }
        allowed_tools = list;
    }

    if let Some(cs_val) = patch.get("confirmSave") {
        let Some(b) = cs_val.as_bool() else {
            return Err(SettingsExtrasError::InvalidArgs {
                message: "confirmSave must be true or false".to_string(),
                reason: None,
            });
        };
        confirm_save = b;
    }

    // Construct stored chats object:
    let mut chats_map = Map::new();
    if !model.is_null() {
        chats_map.insert("model".to_string(), model.clone());
    }
    if !thinking_level.is_null() {
        chats_map.insert("thinkingLevel".to_string(), thinking_level.clone());
    }
    if !instructions.trim().is_empty() {
        chats_map.insert("instructions".to_string(), json!(instructions));
    }
    if !allowed_tools.is_empty() {
        chats_map.insert("allowedTools".to_string(), json!(allowed_tools));
    }
    if confirm_save {
        chats_map.insert("confirmSave".to_string(), json!(true));
    }

    stored.insert("version".to_string(), json!(1));
    stored.insert("chats".to_string(), Value::Object(chats_map));

    write_private_atomic(&path, &serde_json::to_string_pretty(&stored).unwrap())?;

    Ok(json!({
        "model": model,
        "thinkingLevel": thinking_level,
        "instructions": instructions,
        "allowedTools": allowed_tools,
        "confirmSave": confirm_save,
        "instructionsMaxChars": CHAT_INSTRUCTIONS_MAX_CHARS,
    }))
}

// ---------------------------------------------------------------------------
// Appearance Custom CSS
// ---------------------------------------------------------------------------

pub fn appearance_custom_css_get(agent_dir: &Path) -> Result<Value, SettingsExtrasError> {
    let file_path = agent_dir.join("desktop").join("custom.css");
    let css = match std::fs::read_to_string(&file_path) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err(SettingsExtrasError::Io {
                message: format!("failed to read custom.css: {e}"),
                reason: None,
            });
        }
    };
    Ok(json!({
        "css": css,
        "path": file_path.to_string_lossy().to_string(),
    }))
}

pub fn appearance_custom_css_set(agent_dir: &Path, args: &Value) -> Result<Value, SettingsExtrasError> {
    let file_path = agent_dir.join("desktop").join("custom.css");

    let css_opt = if let Some(obj) = args.as_object() {
        if let Some(css_val) = obj.get("css") {
            let Some(css_str) = css_val.as_str() else {
                return Err(SettingsExtrasError::InvalidArgs {
                    message: "css must be a string".to_string(),
                    reason: None,
                });
            };
            Some(css_str.to_string())
        } else {
            None
        }
    } else {
        None
    };

    match css_opt {
        Some(css) => {
            write_private_atomic(&file_path, &css)?;
            Ok(json!({
                "path": file_path.to_string_lossy().to_string(),
                "created": false,
            }))
        }
        None => {
            if file_path.is_file() {
                Ok(json!({
                    "path": file_path.to_string_lossy().to_string(),
                    "created": false,
                }))
            } else {
                write_private_atomic(&file_path, STARTER_CSS)?;
                Ok(json!({
                    "path": file_path.to_string_lossy().to_string(),
                    "created": true,
                }))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tools_settings_roundtrip_and_unknown_fields() {
        let dir = tempfile::tempdir().expect("tempdir");
        let agent = dir.path();
        let path = agent.join("settings.json");

        // Missing file -> default response
        let res = tools_settings_get(agent).expect("get");
        assert_eq!(res["codemode"], "automatic");
        assert_eq!(res["codemodeMode"]["value"], "on");

        // Seed with unknown field
        std::fs::write(&path, r#"{"unknownField":"value123"}"#).expect("write");

        // Set codemode = always
        let set_res = tools_settings_set(agent, &json!({ "codemode": "always" })).expect("set");
        assert_eq!(set_res["codemode"], "always");

        let disk: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(disk["unknownField"], "value123");
        assert_eq!(disk["defaultTools"], json!(["+codemode"]));

        // Set codemodeMode = only
        let mode_res = tools_settings_set(agent, &json!({ "codemodeMode": "only" })).expect("set mode");
        assert_eq!(mode_res["codemodeMode"]["value"], "only");

        let disk2: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(disk2["codemode"]["mode"], "only");
        assert_eq!(disk2["unknownField"], "value123");

        // Set codemodeInlineBudget = 2500
        let budget_res = tools_settings_set(agent, &json!({ "codemodeInlineBudget": 2500 })).expect("set budget");
        assert_eq!(budget_res["codemodeInlineBudget"]["value"], 2500);

        let disk3: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(disk3["codemode"]["inlineBudget"], 2500);

        // Reset budget with null
        let reset_res = tools_settings_set(agent, &json!({ "codemodeInlineBudget": null })).expect("reset budget");
        assert_eq!(reset_res["codemodeInlineBudget"], json!({}));

        // Corrupt file refusal
        std::fs::write(&path, "{not valid json").expect("write corrupt");
        assert!(tools_settings_get(agent).is_err());
        assert!(tools_settings_set(agent, &json!({ "codemode": "always" })).is_err());
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "{not valid json");
    }

    #[test]
    fn test_artifacts_settings() {
        let dir = tempfile::tempdir().expect("tempdir");
        let agent = dir.path();
        let path = agent.join("pi-web").join("settings.json");

        // Default: enabled
        let res = artifacts_settings_get(agent).expect("get");
        assert_eq!(res["enabled"], true);

        // Set false
        let set_res = artifacts_settings_set(agent, &json!({ "enabled": false })).expect("set");
        assert_eq!(set_res["enabled"], false);

        let disk: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(disk["artifactsPrompt"], false);
        assert_eq!(disk["version"], 1);

        // Turn back on
        let on_res = artifacts_settings_set(agent, &json!({ "enabled": true })).expect("set on");
        assert_eq!(on_res["enabled"], true);
    }

    #[test]
    fn test_chats_settings_and_validation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let agent = dir.path();
        let path = agent.join("pi-web").join("settings.json");

        // Default
        let res = chats_settings_get(agent).expect("get");
        assert_eq!(res["instructions"], "");
        assert_eq!(res["confirmSave"], false);

        // Set valid patch
        let patch = json!({
            "instructions": "Be concise.",
            "thinkingLevel": "high",
            "allowedTools": ["tool-a", "tool-b"],
            "confirmSave": true
        });
        let set_res = chats_settings_set(agent, &patch).expect("set");
        assert_eq!(set_res["instructions"], "Be concise.");
        assert_eq!(set_res["thinkingLevel"], "high");
        assert_eq!(set_res["confirmSave"], true);

        let disk: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(disk["chats"]["instructions"], "Be concise.");
        assert_eq!(disk["chats"]["thinkingLevel"], "high");

        // Validation: invalid thinking level
        assert!(chats_settings_set(agent, &json!({ "thinkingLevel": "invalid" })).is_err());

        // Validation: instructions exceeding limit
        let too_long = "a".repeat(8001);
        assert!(chats_settings_set(agent, &json!({ "instructions": too_long })).is_err());
    }

    #[test]
    fn test_appearance_custom_css() {
        let dir = tempfile::tempdir().expect("tempdir");
        let agent = dir.path();

        // Get missing custom.css returns empty string
        let get_res = appearance_custom_css_get(agent).expect("get");
        assert_eq!(get_res["css"], "");

        // Set without css creates starter css
        let set_res = appearance_custom_css_set(agent, &json!({})).expect("ensure");
        assert_eq!(set_res["created"], true);

        let css_file = agent.join("desktop").join("custom.css");
        assert!(css_file.is_file());
        let content = std::fs::read_to_string(&css_file).expect("read");
        assert!(content.contains("Pi Agent custom stylesheet"));

        // Second ensure doesn't recreate
        let set_res2 = appearance_custom_css_set(agent, &json!({})).expect("ensure again");
        assert_eq!(set_res2["created"], false);

        // Set with explicit css updates it
        let custom = "/* my custom */";
        let update_res = appearance_custom_css_set(agent, &json!({ "css": custom })).expect("write");
        assert_eq!(update_res["created"], false);
        assert_eq!(std::fs::read_to_string(&css_file).expect("read"), custom);

        // Get reads updated css
        let get_res2 = appearance_custom_css_get(agent).expect("get");
        assert_eq!(get_res2["css"], custom);
    }
}
