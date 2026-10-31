use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FontPreferences {
    pub ui: String,
    pub mono: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalizedFontName {
    pub lang: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstalledFont {
    pub family: String,
    #[serde(default)]
    pub names: Vec<LocalizedFontName>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FontError {
    InvalidArgs(String),
    Io(String),
}

/// One installed family name, not an arbitrary CSS declaration or font stack.
/// Matches lib/font-preferences.ts isFontFamily.
pub fn is_font_family(s: &str) -> bool {
    if s.len() > 120 || s != s.trim() {
        return false;
    }
    !s.chars().any(|c| {
        c <= '\u{001f}'
            || ('\u{007f}'..='\u{009f}').contains(&c)
            || matches!(
                c,
                '"' | '\''
                    | '\\'
                    | ','
                    | ';'
                    | ':'
                    | '{'
                    | '}'
                    | '('
                    | ')'
                    | '<'
                    | '>'
                    | '['
                    | ']'
                    | '/'
            )
    })
}

fn write_private_file_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "Target path has no parent directory".to_string())?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create settings directory: {e}"))?;

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("settings.json");
    let random_id = format!(
        "{:016x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let temp_path = dir.join(format!(".{}-{}.tmp", file_name, random_id));

    let mut open_options = std::fs::OpenOptions::new();
    open_options.write(true).create_new(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_options.mode(0o600);
    }

    let mut file = match open_options.open(&temp_path) {
        Ok(f) => f,
        Err(e) => return Err(format!("Failed to create temporary file: {e}")),
    };

    use std::io::Write;
    if let Err(e) = file.write_all(contents.as_bytes()) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("Failed to write to temporary file: {e}"));
    }
    if let Err(e) = file.sync_all() {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("Failed to sync temporary file: {e}"));
    }
    drop(file);

    if let Err(e) = std::fs::rename(&temp_path, path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!(
            "Failed to rename temporary file to destination: {e}"
        ));
    }

    Ok(())
}

/// Read font preferences from `<agent_dir>/pi-web/settings.json`.
pub fn read_font_preferences(agent_dir: &Path) -> Result<Option<FontPreferences>, String> {
    let settings_path = agent_dir.join("pi-web").join("settings.json");
    if !settings_path.exists() {
        return Ok(None);
    }
    let text = match std::fs::read_to_string(&settings_path) {
        Ok(t) => t,
        Err(e) => return Err(format!("Could not read font settings: {e}")),
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Err("Invalid Pi Web settings: expected an object".to_string()),
    };
    let Some(obj) = parsed.as_object() else {
        return Err("Invalid Pi Web settings: expected an object".to_string());
    };
    let Some(fonts_val) = obj.get("fonts") else {
        return Ok(None);
    };
    if fonts_val.is_null() {
        return Ok(None);
    }
    let Some(fonts_obj) = fonts_val.as_object() else {
        return Ok(None);
    };
    let (Some(ui_val), Some(mono_val)) = (fonts_obj.get("ui"), fonts_obj.get("mono")) else {
        return Ok(None);
    };
    let (Some(ui), Some(mono)) = (ui_val.as_str(), mono_val.as_str()) else {
        return Ok(None);
    };
    if is_font_family(ui) && is_font_family(mono) {
        Ok(Some(FontPreferences {
            ui: ui.to_string(),
            mono: mono.to_string(),
        }))
    } else {
        Ok(None)
    }
}

/// Write font preferences to `<agent_dir>/pi-web/settings.json` atomically and privately.
pub fn write_font_preferences(
    agent_dir: &Path,
    fonts_val: &Value,
) -> Result<FontPreferences, FontError> {
    let Some(fonts_obj) = fonts_val.as_object() else {
        return Err(FontError::InvalidArgs("Invalid fonts".to_string()));
    };
    let (Some(ui_val), Some(mono_val)) = (fonts_obj.get("ui"), fonts_obj.get("mono")) else {
        return Err(FontError::InvalidArgs("Invalid fonts".to_string()));
    };
    let (Some(ui), Some(mono)) = (ui_val.as_str(), mono_val.as_str()) else {
        return Err(FontError::InvalidArgs("Invalid fonts".to_string()));
    };
    if !is_font_family(ui) || !is_font_family(mono) {
        return Err(FontError::InvalidArgs("Invalid fonts".to_string()));
    }

    let settings_path = agent_dir.join("pi-web").join("settings.json");
    let mut stored_map = serde_json::Map::new();

    if settings_path.exists() {
        let text = std::fs::read_to_string(&settings_path)
            .map_err(|e| FontError::Io(format!("Could not read font settings: {e}")))?;
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|_| FontError::Io("Invalid Pi Web settings: expected an object".to_string()))?;
        let Some(existing_obj) = parsed.as_object() else {
            return Err(FontError::Io(
                "Invalid Pi Web settings: expected an object".to_string(),
            ));
        };
        stored_map = existing_obj.clone();
    }

    stored_map.insert("version".to_string(), json!(1));
    stored_map.insert(
        "fonts".to_string(),
        json!({
            "ui": ui,
            "mono": mono,
        }),
    );

    let serialized = serde_json::to_string_pretty(&stored_map)
        .map_err(|e| FontError::Io(format!("Failed to serialize settings: {e}")))?;

    write_private_file_atomic(&settings_path, &serialized)
        .map_err(|e| FontError::Io(format!("Could not save font settings: {e}")))?;

    Ok(FontPreferences {
        ui: ui.to_string(),
        mono: mono.to_string(),
    })
}

/// Normalize installed fonts list: deduplicate by lowercase family, bound to 10000,
/// filter invalid families and `@` aliases, sanitize localized names, sort alphabetically.
pub fn normalize_installed_fonts(input: &[InstalledFont]) -> Result<Vec<InstalledFont>, String> {
    use std::collections::BTreeMap;
    let mut fonts: BTreeMap<String, InstalledFont> = BTreeMap::new();
    let limit = input.len().min(10_000);
    for entry in &input[..limit] {
        if !is_font_family(&entry.family)
            || entry.family.is_empty()
            || entry.family.starts_with('@')
        {
            continue;
        }
        let names = entry
            .names
            .iter()
            .filter(|n| n.lang.len() <= 35 && !n.name.is_empty() && is_font_family(&n.name))
            .take(32)
            .cloned()
            .collect::<Vec<_>>();
        let key = entry.family.to_lowercase();
        fonts.entry(key).or_insert_with(|| InstalledFont {
            family: entry.family.clone(),
            names,
        });
    }
    let mut result: Vec<InstalledFont> = fonts.into_values().collect();
    result.sort_by(|a, b| a.family.cmp(&b.family));
    if result.is_empty() {
        return Err("No installed fonts found".to_string());
    }
    Ok(result)
}

struct FontCache {
    fonts: Vec<InstalledFont>,
    expires_at: Instant,
}

static FONT_CACHE: Mutex<Option<FontCache>> = Mutex::new(None);

#[cfg(target_os = "linux")]
fn enumerate_system_fonts() -> Result<Vec<InstalledFont>, String> {
    let output = std::process::Command::new("fc-list")
        .arg("--format=%{family}\n")
        .output()
        .map_err(|e| format!("fc-list failed: {e}"))?;
    if !output.status.success() {
        return Err(format!("fc-list exited with status {}", output.status));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut candidates = Vec::new();
    for line in stdout.lines() {
        for family in line.split(',') {
            let family = family.trim().to_string();
            if !family.is_empty() {
                candidates.push(InstalledFont {
                    family,
                    names: Vec::new(),
                });
            }
        }
    }
    normalize_installed_fonts(&candidates)
}

#[cfg(target_os = "macos")]
fn enumerate_system_fonts() -> Result<Vec<InstalledFont>, String> {
    let output = std::process::Command::new("/usr/sbin/system_profiler")
        .args(["SPFontsDataType", "-json"])
        .output()
        .map_err(|e| format!("system_profiler failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "system_profiler exited with status {}",
            output.status
        ));
    }
    let val: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("failed to parse system_profiler output: {e}"))?;
    let mut candidates = Vec::new();
    if let Some(files) = val.get("SPFontsDataType").and_then(|v| v.as_array()) {
        for file in files {
            if let Some(typefaces) = file.get("typefaces").and_then(|v| v.as_array()) {
                for face in typefaces {
                    if let Some(family) = face.get("family").and_then(|v| v.as_str()) {
                        candidates.push(InstalledFont {
                            family: family.to_string(),
                            names: Vec::new(),
                        });
                    }
                }
            }
        }
    }
    normalize_installed_fonts(&candidates)
}

#[cfg(target_os = "windows")]
fn enumerate_system_fonts() -> Result<Vec<InstalledFont>, String> {
    const WINDOWS_FONTS_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName PresentationCore
$families = @([System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object {
  [pscustomobject]@{ family = $_.Source; names = @($_.FamilyNames.GetEnumerator() | ForEach-Object {
    [pscustomobject]@{ lang = $_.Key.IetfLanguageTag; name = $_.Value }
  }) }
})
ConvertTo-Json -InputObject $families -Depth 5 -Compress
"#;
    let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let exe = Path::new(&sys_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let output = std::process::Command::new(exe)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            WINDOWS_FONTS_SCRIPT,
        ])
        .output()
        .map_err(|e| format!("powershell failed: {e}"))?;
    if !output.status.success() {
        return Err(format!("powershell exited with status {}", output.status));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed = stdout.trim_start_matches('\u{feff}').trim();
    let val: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("failed to parse powershell fonts json: {e}"))?;
    let Some(arr) = val.as_array() else {
        return Err("Expected json array of fonts from powershell".to_string());
    };
    let mut candidates = Vec::new();
    for item in arr {
        if let Some(family) = item.get("family").and_then(|v| v.as_str()) {
            let mut names = Vec::new();
            if let Some(names_arr) = item.get("names").and_then(|v| v.as_array()) {
                for name_obj in names_arr {
                    if let (Some(lang), Some(name)) = (
                        name_obj.get("lang").and_then(|v| v.as_str()),
                        name_obj.get("name").and_then(|v| v.as_str()),
                    ) {
                        names.push(LocalizedFontName {
                            lang: lang.to_string(),
                            name: name.to_string(),
                        });
                    }
                }
            }
            candidates.push(InstalledFont {
                family: family.to_string(),
                names,
            });
        }
    }
    normalize_installed_fonts(&candidates)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn enumerate_system_fonts() -> Result<Vec<InstalledFont>, String> {
    Err("System font enumeration is unavailable on this platform".to_string())
}

/// Enumerate native system fonts with 60s memory caching.
pub fn list_system_fonts() -> Result<Vec<InstalledFont>, String> {
    let now = Instant::now();
    let mut cache_lock = FONT_CACHE.lock().unwrap();
    if let Some(ref cache) = *cache_lock {
        if now < cache.expires_at {
            return Ok(cache.fonts.clone());
        }
    }
    let fonts = enumerate_system_fonts()?;
    *cache_lock = Some(FontCache {
        fonts: fonts.clone(),
        expires_at: now + Duration::from_secs(60),
    });
    Ok(fonts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_is_font_family() {
        for valid in ["", "Segoe UI", "思源黑体 CN", "Sarasa Mono SC", "M+ 1m"] {
            assert!(is_font_family(valid), "expected valid: {valid}");
        }
        for invalid in [
            " leading",
            "trailing ",
            "x\n",
            "x; color:red",
            "\"x\"",
            "'x'",
            "x, serif",
            "url(font)",
            "var(--x)",
            "</style>",
            "{font-size:12px}",
            "(font)",
            "<font>",
            "[font]",
            "/font",
            &"x".repeat(121),
        ] {
            assert!(!is_font_family(invalid), "expected invalid: {invalid}");
        }
    }

    #[test]
    fn test_read_write_font_preferences_atomic() {
        let dir = tempdir().expect("tempdir");
        let agent_dir = dir.path();

        // 1. Initial read from non-existent file returns None
        assert_eq!(read_font_preferences(agent_dir).unwrap(), None);

        // 2. Invalid font family rejection
        let invalid_payload = json!({ "ui": "bad; color:red", "mono": "Consolas" });
        match write_font_preferences(agent_dir, &invalid_payload) {
            Err(FontError::InvalidArgs(msg)) => assert_eq!(msg, "Invalid fonts"),
            other => panic!("expected InvalidArgs, got {other:?}"),
        }

        // 3. Valid write creates directory and file atomically
        let valid_payload = json!({ "ui": "Microsoft YaHei", "mono": "Consolas" });
        let written = write_font_preferences(agent_dir, &valid_payload).expect("write");
        assert_eq!(
            written,
            FontPreferences {
                ui: "Microsoft YaHei".to_string(),
                mono: "Consolas".to_string(),
            }
        );

        // Verify file exists and permissions
        let settings_path = agent_dir.join("pi-web").join("settings.json");
        assert!(settings_path.exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::metadata(&settings_path).expect("metadata");
            assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        }

        // 4. Read back verified
        let read = read_font_preferences(agent_dir).unwrap().expect("fonts");
        assert_eq!(
            read,
            FontPreferences {
                ui: "Microsoft YaHei".to_string(),
                mono: "Consolas".to_string(),
            }
        );

        // 5. Preserving unknown fields and version: 1
        // Manually write extra fields to settings.json
        let file_content = std::fs::read_to_string(&settings_path).expect("read");
        let mut parsed: Value = serde_json::from_str(&file_content).expect("parse");
        parsed["artifactsPrompt"] = json!(false);
        parsed["customField"] = json!("preserved");
        std::fs::write(&settings_path, serde_json::to_string_pretty(&parsed).unwrap()).unwrap();

        // Update fonts
        let update_payload = json!({ "ui": "Segoe UI", "mono": "Fira Code" });
        write_font_preferences(agent_dir, &update_payload).expect("update");

        let updated_text = std::fs::read_to_string(&settings_path).expect("read updated");
        let updated_json: Value = serde_json::from_str(&updated_text).expect("parse updated");
        assert_eq!(updated_json["version"], json!(1));
        assert_eq!(updated_json["artifactsPrompt"], json!(false));
        assert_eq!(updated_json["customField"], json!("preserved"));
        assert_eq!(updated_json["fonts"]["ui"], json!("Segoe UI"));
        assert_eq!(updated_json["fonts"]["mono"], json!("Fira Code"));

        // 6. Corrupt settings.json handling
        std::fs::write(&settings_path, "not json").unwrap();
        match read_font_preferences(agent_dir) {
            Err(msg) => assert!(msg.contains("Invalid Pi Web settings")),
            Ok(_) => panic!("expected error on corrupt settings"),
        }
        match write_font_preferences(agent_dir, &update_payload) {
            Err(FontError::Io(msg)) => assert!(msg.contains("Invalid Pi Web settings")),
            other => panic!("expected Io error on corrupt settings, got {other:?}"),
        }
    }

    #[test]
    fn test_normalize_installed_fonts() {
        let input = vec![
            InstalledFont {
                family: "Microsoft YaHei".to_string(),
                names: vec![
                    LocalizedFontName {
                        lang: "zh-cn".to_string(),
                        name: "微软雅黑".to_string(),
                    },
                    LocalizedFontName {
                        lang: "zh-tw".to_string(),
                        name: "微軟雅黑".to_string(),
                    },
                ],
            },
            InstalledFont {
                family: "microsoft yahei".to_string(),
                names: vec![],
            },
            InstalledFont {
                family: "Consolas".to_string(),
                names: vec![],
            },
            InstalledFont {
                family: "User Installed UI".to_string(),
                names: vec![],
            },
            InstalledFont {
                family: "@Microsoft YaHei".to_string(),
                names: vec![],
            },
            InstalledFont {
                family: "Arial; color:red".to_string(),
                names: vec![],
            },
            InstalledFont {
                family: "".to_string(),
                names: vec![],
            },
        ];

        let normalized = normalize_installed_fonts(&input).expect("normalize");
        let families: Vec<_> = normalized.iter().map(|f| f.family.as_str()).collect();
        assert_eq!(
            families,
            vec!["Consolas", "Microsoft YaHei", "User Installed UI"]
        );
        assert_eq!(normalized[1].names.len(), 2);
        assert_eq!(normalized[1].names[0].name, "微软雅黑");
    }

    #[test]
    fn test_normalize_empty_fails() {
        let input: Vec<InstalledFont> = vec![];
        let err = normalize_installed_fonts(&input).unwrap_err();
        assert_eq!(err, "No installed fonts found");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn test_linux_enumerate_system_fonts() {
        // If fc-list is available in the test environment, verify it returns valid fonts
        match list_system_fonts() {
            Ok(fonts) => {
                assert!(!fonts.is_empty());
                for f in &fonts {
                    assert!(is_font_family(&f.family));
                    assert!(!f.family.starts_with('@'));
                }
            }
            Err(e) => {
                eprintln!("System fonts enumeration skipped or failed on this host: {e}");
            }
        }
    }
}
