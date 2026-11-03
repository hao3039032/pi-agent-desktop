//! Static Preview installation consistency checks. These hashes bind files to
//! the installed manifest; they do not authenticate the manifest's origin.
use std::{collections::{BTreeMap, BTreeSet}, fs, io::{Read, BufReader}, path::{Path, PathBuf}};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_MANIFEST: u64 = 32 * 1024 * 1024;
const MAX_FILES: usize = 100_000;
const MAX_PATH_BYTES: usize = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PACKAGE: u64 = 1024 * 1024;

pub(crate) struct PreviewBundle {
    pub runtime: management_host::ManagementSdkRuntime,
    pub cli: PathBuf,
    pub bridge: PathBuf,
    pub artifacts: PathBuf,
    pub chat: PathBuf,
}

fn json_file(path: &Path, cap: u64) -> Result<Value, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "preview metadata unavailable")?;
    if !regular(&meta) || meta.len() > cap { return Err("invalid preview metadata".into()); }
    let file = fs::File::open(path).map_err(|_| "preview metadata unavailable")?;
    let mut data = Vec::new();
    file.take(cap + 1).read_to_end(&mut data).map_err(|_| "preview metadata unreadable")?;
    if data.len() as u64 > cap { return Err("preview metadata too large".into()); }
    serde_json::from_slice(&data).map_err(|_| "invalid preview metadata".into())
}

fn regular(meta: &fs::Metadata) -> bool {
    if !meta.is_file() || meta.file_type().is_symlink() { return false; }
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 { return false; } }
    true
}
fn directory(meta: &fs::Metadata) -> bool {
    if !meta.is_dir() || meta.file_type().is_symlink() { return false; }
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 { return false; } }
    true
}
fn valid_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 4096 && path.split('/').all(|part| {
        !part.is_empty() && part != "." && part != ".." && !part.ends_with(['.', ' '])
            && !part.contains(['\\', ':', '\0'])
    })
}

/// A path safe to hand a child process. `canonicalize()` returns the verbatim
/// `\\?\D:\...` form on Windows, and Node's entry-point resolver is not
/// verbatim-path aware: it reduces such an argv[1] to the bare drive, so the
/// preview runtime died with `EISDIR: lstat 'D:'` before its first request.
/// Simplify every path that crosses the process boundary (argv or environment).
/// `lib.rs`'s `child_process_compatible_path` does the same for the server.
fn child_process_path(path: &Path) -> PathBuf {
    dunce::simplified(path).to_path_buf()
}
#[cfg(windows)]
fn reject_windows_aliases(names: &mut [String]) -> Result<(), String> {
    use std::{cmp::Ordering, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL, CSTR_GREATER_THAN, CSTR_LESS_THAN};
    let compare = |a: &str, b: &str| {
        let a: Vec<u16> = std::ffi::OsStr::new(a).encode_wide().collect();
        let b: Vec<u16> = std::ffi::OsStr::new(b).encode_wide().collect();
        unsafe { CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1) }
    };
    let mut invalid = false;
    names.sort_unstable_by(|a, b| match compare(a, b) {
        CSTR_LESS_THAN => Ordering::Less,
        CSTR_GREATER_THAN => Ordering::Greater,
        CSTR_EQUAL => Ordering::Equal,
        _ => { invalid = true; a.cmp(b) }
    });
    if invalid || names.windows(2).any(|pair| compare(&pair[0], &pair[1]) != CSTR_LESS_THAN) { return Err("preview path alias".into()); }
    Ok(())
}

fn hash(path: &Path) -> Result<(u64, String), String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "preview file unavailable")?;
    if !regular(&meta) { return Err("invalid preview file".into()); }
    let mut reader = BufReader::new(fs::File::open(path).map_err(|_| "preview file unavailable")?);
    let mut digest = Sha256::new(); let mut buffer = [0u8; 65536]; let mut size = 0u64;
    loop {
        let n = reader.read(&mut buffer).map_err(|_| "preview file unreadable")?;
        if n == 0 { break; }
        size = size.checked_add(n as u64).ok_or("preview file too large")?;
        if size > MAX_TOTAL_BYTES { return Err("preview file too large".into()); }
        digest.update(&buffer[..n]);
    }
    Ok((size, format!("{:x}", digest.finalize())))
}

pub(crate) fn verify(root: &Path) -> Result<PreviewBundle, String> {
    if !root.is_absolute() || !directory(&fs::symlink_metadata(root).map_err(|_| "preview root unavailable")?) { return Err("invalid preview root".into()); }
    let root = root.canonicalize().map_err(|_| "preview root unavailable")?;
    let root = child_process_path(&root);
    let manifest = json_file(&root.join("bundle-manifest.json"), MAX_MANIFEST)?;
    if manifest.get("version").and_then(Value::as_u64) != Some(1) || manifest.get("piVersion").and_then(Value::as_str) != Some("1.4.0") { return Err("invalid preview manifest version".into()); }
    let roles = manifest.get("managementRuntime").ok_or("preview runtime missing")?;
    for (key, value) in [("piVersion", "1.4.0"), ("node", "node/node.exe"), ("entry", "server/lib/pi-rpc/assets/management-sdk-entry.mjs"), ("dependencyRoot", "managed/node_modules"), ("projectionRoot", "managed"), ("cli", "pi/pi.exe")] {
        if roles.get(key).and_then(Value::as_str) != Some(value) { return Err("invalid preview runtime role".into()); }
    }
    if roles.get("version").and_then(Value::as_u64) != Some(1) || roles.as_object().map(|v| v.len()) != Some(7) { return Err("invalid preview runtime metadata".into()); }
    let rows = manifest.get("files").and_then(Value::as_array).ok_or("preview files missing")?;
    if rows.len() > MAX_FILES { return Err("preview file limit exceeded".into()); }
    let mut expected = BTreeMap::new(); let mut folded = BTreeSet::new(); let mut bytes = 0usize; let mut total = 0u64;
    for row in rows {
        let path = row.get("path").and_then(Value::as_str).ok_or("invalid preview file path")?;
        let size = row.get("size").and_then(Value::as_u64).ok_or("invalid preview file size")?;
        let sha = row.get("sha256").and_then(Value::as_str).ok_or("invalid preview digest")?;
        bytes = bytes.checked_add(path.len()).ok_or("preview path limit exceeded")?;
        total = total.checked_add(size).ok_or("preview size limit exceeded")?;
        if !valid_path(path) || path == "bundle-manifest.json" || bytes > MAX_PATH_BYTES || total > MAX_TOTAL_BYTES
            || sha.len() != 64 || !sha.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || !folded.insert(path.to_lowercase()) || expected.insert(path.to_string(), (size, sha.to_string())).is_some() {
            return Err("invalid preview file manifest".into());
        }
    }
    let mut stack = vec![root.clone()]; let mut actual = BTreeSet::new();
    let mut walked = 0usize; let mut walked_bytes = 0usize; let mut walked_names = BTreeSet::new();
    #[cfg(windows)]
    let mut windows_names = Vec::new();
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).map_err(|_| "preview directory unreadable")? {
            let entry = entry.map_err(|_| "preview directory unreadable")?; let path = entry.path();
            let rel = path.strip_prefix(&root).map_err(|_| "preview path escape")?.to_str().ok_or("invalid preview path")?.replace('\\', "/");
            walked = walked.checked_add(1).ok_or("preview entry limit exceeded")?;
            walked_bytes = walked_bytes.checked_add(rel.len()).ok_or("preview path limit exceeded")?;
            if walked > MAX_FILES || walked_bytes > MAX_PATH_BYTES || !valid_path(&rel) || !walked_names.insert(rel.to_lowercase()) { return Err("invalid or excessive preview paths".into()); }
            #[cfg(windows)]
            windows_names.push(rel.clone());
            let meta = fs::symlink_metadata(&path).map_err(|_| "preview file unavailable")?;
            if directory(&meta) { stack.push(path); continue; }
            if !regular(&meta) { return Err("preview contains a link or non-file".into()); }
            if rel == "bundle-manifest.json" { continue; }
            let expected_entry = expected.get(&rel).ok_or("unexpected preview file")?;
            if !actual.insert(rel) || hash(&path)? != *expected_entry { return Err("preview file mismatch".into()); }
        }
    }
    #[cfg(windows)]
    reject_windows_aliases(&mut windows_names)?;
    if actual.len() != expected.len() { return Err("preview file missing".into()); }
    for name in ["node/node.exe", "pi/pi.exe", "pi/pi-distribution.json", "managed/pi-web-session-projection.mjs", "server/lib/pi-rpc/assets/management-sdk-entry.mjs", "server/lib/pi-rpc/assets/management-stdio.mjs", "server/lib/pi-rpc/assets/pi-web-management.mjs", "server/lib/pi-rpc/assets/pi-web-bridge.mjs", "server/lib/pi-rpc/assets/pi-web-artifacts.mjs", "server/lib/pi-rpc/assets/pi-web-chat.mjs"] {
        if !actual.contains(name) { return Err("required preview file missing".into()); }
    }
    let distribution = json_file(&root.join("pi/pi-distribution.json"), MAX_MANIFEST)?;
    if distribution.get("complete").and_then(Value::as_bool) != Some(true) || distribution.get("binary").and_then(Value::as_str) != Some("pi.exe") { return Err("invalid preview CLI distribution".into()); }
    let files = distribution.get("files").and_then(Value::as_array).ok_or("preview CLI files missing")?;
    let mut cli_files = BTreeSet::new();
    for file in files { let file = file.as_str().ok_or("invalid preview CLI file")?; if !valid_path(file) || file == "pi-distribution.json" || !cli_files.insert(format!("pi/{file}")) { return Err("invalid preview CLI files".into()); } }
    if !cli_files.contains("pi/pi.exe") || cli_files != actual.iter().filter(|p| p.starts_with("pi/") && *p != "pi/pi-distribution.json").cloned().collect() { return Err("preview CLI files mismatch".into()); }
    let sdk = root.join("managed/node_modules");
    let mut queue = vec![("@earendil-works/pi-coding-agent".to_string(), "1.4.0".to_string())];
    let mut seen = BTreeMap::new();
    while let Some((name, version)) = queue.pop() {
        if seen.len() > 1000 || !name.starts_with("@earendil-works/pi-") || !name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"@/-".contains(&c)) || semver::Version::parse(&version).is_err() { return Err("invalid preview SDK dependency".into()); }
        if let Some(previous) = seen.get(&name) { if previous != &version { return Err("conflicting preview SDK dependency".into()); } continue; }
        let package_path = format!("managed/node_modules/{name}/package.json");
        if !actual.contains(&package_path) { return Err("preview SDK package missing".into()); }
        let pkg = json_file(&root.join(&package_path), MAX_PACKAGE)?;
        if pkg.get("name").and_then(Value::as_str) != Some(name.as_str()) || pkg.get("version").and_then(Value::as_str) != Some(version.as_str()) { return Err("preview SDK package version mismatch".into()); }
        if let Some(deps) = pkg.get("dependencies") {
            for (dependency, required) in deps.as_object().ok_or("invalid preview SDK dependencies")? {
                if dependency.starts_with("@earendil-works/") { queue.push((dependency.clone(), required.as_str().ok_or("invalid preview SDK version")?.to_string())); }
            }
        }
        seen.insert(name, version);
    }
    if !seen.contains_key("@earendil-works/pi-ai") || !seen.contains_key("@earendil-works/pi-mcp") { return Err("preview SDK graph incomplete".into()); }
    let assets = root.join("server/lib/pi-rpc/assets");
    Ok(PreviewBundle {
        runtime: management_host::ManagementSdkRuntime { node: root.join("node/node.exe"), entry: assets.join("management-sdk-entry.mjs"), dependency_root: sdk, projection_root: root.join("managed"), cli_version: "1.4.0".into() },
        cli: root.join("pi/pi.exe"), bridge: assets.join("pi-web-bridge.mjs"), artifacts: assets.join("pi-web-artifacts.mjs"), chat: assets.join("pi-web-chat.mjs"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, Value) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let files = [
            ("node/node.exe", "node"), ("pi/pi.exe", "cli"),
            ("pi/pi-distribution.json", r#"{"complete":true,"binary":"pi.exe","files":["pi.exe"]}"#),
            ("managed/pi-web-session-projection.mjs", "projection"),
            ("server/lib/pi-rpc/assets/management-sdk-entry.mjs", "entry"),
            ("server/lib/pi-rpc/assets/management-stdio.mjs", "stdio"),
            ("server/lib/pi-rpc/assets/pi-web-management.mjs", "management"),
            ("server/lib/pi-rpc/assets/pi-web-bridge.mjs", "bridge"),
            ("server/lib/pi-rpc/assets/pi-web-artifacts.mjs", "artifacts"),
            ("server/lib/pi-rpc/assets/pi-web-chat.mjs", "chat"),
            ("managed/node_modules/@earendil-works/pi-coding-agent/package.json", r#"{"name":"@earendil-works/pi-coding-agent","version":"1.4.0","dependencies":{"@earendil-works/pi-ai":"1.3.0","@earendil-works/pi-mcp":"1.2.0"}}"#),
            ("managed/node_modules/@earendil-works/pi-ai/package.json", r#"{"name":"@earendil-works/pi-ai","version":"1.3.0"}"#),
            ("managed/node_modules/@earendil-works/pi-mcp/package.json", r#"{"name":"@earendil-works/pi-mcp","version":"1.2.0"}"#),
        ];
        let mut rows = Vec::new();
        for (name, content) in files {
            let path = root.join(name); fs::create_dir_all(path.parent().unwrap()).unwrap(); fs::write(&path, content).unwrap();
            let (size, sha256) = hash(&path).unwrap(); rows.push(json!({"path":name,"size":size,"sha256":sha256}));
        }
        let manifest = json!({"version":1,"piVersion":"1.4.0","files":rows,"managementRuntime":{
            "version":1,"piVersion":"1.4.0","node":"node/node.exe","entry":"server/lib/pi-rpc/assets/management-sdk-entry.mjs",
            "dependencyRoot":"managed/node_modules","projectionRoot":"managed","cli":"pi/pi.exe"
        }});
        fs::write(root.join("bundle-manifest.json"), manifest.to_string()).unwrap();
        (dir, manifest)
    }

    #[test]
    fn preview_bundle_binds_roles_files_and_mixed_sdk_versions() {
        let (dir, _) = fixture();
        let bundle = verify(dir.path()).unwrap();
        assert_eq!(bundle.cli, child_process_path(&dir.path().canonicalize().unwrap()).join("pi/pi.exe"));
        fs::write(dir.path().join("pi/pi.exe"), "changed").unwrap();
        assert!(verify(dir.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn preview_bundle_rejects_symlinked_resource() {
        use std::os::unix::fs::symlink;
        let (dir, _) = fixture();
        let node = dir.path().join("node/node.exe");
        let original = dir.path().join("original-node");
        fs::rename(&node, &original).unwrap(); symlink(&original, &node).unwrap();
        assert!(verify(dir.path()).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn preview_bundle_simplifies_windows_runtime_paths() {
        // Node's entry resolver reduces a verbatim `\\?\D:\...` argv[1] to the
        // bare drive (the preview child died with EISDIR on `D:`), so no
        // runtime path may keep the verbatim prefix.
        assert_eq!(child_process_path(Path::new(r"\\?\D:\a\pi\static-preview")), PathBuf::from(r"D:\a\pi\static-preview"));
        let (dir, _) = fixture();
        let bundle = verify(dir.path()).unwrap();
        let entry = child_process_path(&dir.path().canonicalize().unwrap()).join("server/lib/pi-rpc/assets/management-sdk-entry.mjs");
        assert_eq!(bundle.runtime.entry, entry);
        for path in [&bundle.runtime.node, &bundle.runtime.dependency_root, &bundle.runtime.projection_root, &bundle.cli, &bundle.bridge] {
            assert!(!path.to_string_lossy().starts_with(r"\\?\"), "verbatim path reaches the child: {}", path.display());
        }
    }

    #[cfg(windows)]
    #[test]
    fn preview_bundle_rejects_windows_ordinal_path_aliases() {
        let mut names = vec!["Managed/Ä.txt".to_string(), "managed/ä.TXT".to_string()];
        assert!(reject_windows_aliases(&mut names).is_err());
        let mut distinct = vec!["managed/a.txt".to_string(), "managed/b.txt".to_string()];
        assert!(reject_windows_aliases(&mut distinct).is_ok());
    }

    #[test]
    fn preview_bundle_rejects_role_and_sdk_version_mismatches() {
        let (dir, mut manifest) = fixture();
        manifest["managementRuntime"]["cli"] = json!("pi/other.exe");
        fs::write(dir.path().join("bundle-manifest.json"), manifest.to_string()).unwrap();
        assert!(verify(dir.path()).is_err());
        let (dir, mut manifest) = fixture();
        let name = "managed/node_modules/@earendil-works/pi-ai/package.json";
        let path = dir.path().join(name);
        fs::write(&path, r#"{"name":"@earendil-works/pi-ai","version":"9.9.9"}"#).unwrap();
        let (size, sha) = hash(&path).unwrap();
        let row = manifest["files"].as_array_mut().unwrap().iter_mut().find(|r| r["path"] == name).unwrap();
        row["size"] = json!(size); row["sha256"] = json!(sha);
        fs::write(dir.path().join("bundle-manifest.json"), manifest.to_string()).unwrap();
        assert!(verify(dir.path()).is_err());
    }

    #[test]
    fn preview_bundle_rejects_escapes_aliases_and_extra_files() {
        let (dir, mut manifest) = fixture();
        manifest["files"][0]["path"] = json!("../escape");
        fs::write(dir.path().join("bundle-manifest.json"), manifest.to_string()).unwrap();
        assert!(verify(dir.path()).is_err());
        let (dir, mut manifest) = fixture();
        let mut alias = manifest["files"][0].clone(); alias["path"] = json!("NODE/NODE.EXE");
        manifest["files"].as_array_mut().unwrap().push(alias);
        fs::write(dir.path().join("bundle-manifest.json"), manifest.to_string()).unwrap();
        assert!(verify(dir.path()).is_err());
        let (dir, _) = fixture(); fs::write(dir.path().join("unexpected"), "extra").unwrap();
        assert!(verify(dir.path()).is_err());
    }
}
