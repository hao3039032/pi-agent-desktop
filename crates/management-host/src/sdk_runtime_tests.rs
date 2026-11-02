use super::*;
use serde_json::json;
use std::{fs, io::{BufRead, BufReader}, process::{Child, Command, Stdio}, time::Duration};

#[cfg(unix)]
#[test]
fn legacy_launcher_removes_sdk_mode_selectors() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let script = temp.path().join("legacy-child");
    let marker = temp.path().join("environment");
    fs::write(&script, "#!/bin/sh\nprintf '%s|%s|%s' \"${PI_WEB_MANAGEMENT_SDK_ROOT-unset}\" \"${PI_WEB_MANAGEMENT_CLI_VERSION-unset}\" \"$PI_WEB_MANAGED_MODULES\" > \"$FIXTURE_MARKER\"\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let host = ManagementHost::new();
    let config = ManagementSpawnConfig {
        executable: script.display().to_string(), agent_dir: Some(temp.path().to_path_buf()), extensions: vec![],
        env: vec![("PI_WEB_MANAGEMENT_SDK_ROOT".into(), "/untrusted".into()), ("PI_WEB_MANAGEMENT_CLI_VERSION".into(), "9.9.9".into()),
            ("PI_WEB_MANAGED_MODULES".into(), "legacy-tree".into()), ("FIXTURE_MARKER".into(), marker.display().to_string())],
    };
    let _instance = host.instance("legacy", &config).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let observed = loop {
        if let Ok(value) = fs::read_to_string(&marker) { if !value.is_empty() { break value; } }
        assert!(std::time::Instant::now() < deadline, "legacy child did not report environment");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(observed, "unset|unset|legacy-tree");
    host.shutdown_until(std::time::Instant::now() + Duration::from_secs(5));
}

#[cfg(unix)]
#[test]
fn invalid_sdk_runtime_never_falls_back_to_legacy() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let script = temp.path().join("legacy-child");
    let marker = temp.path().join("started");
    fs::write(&script, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let runtime = ManagementSdkRuntime { node: script.clone(), entry: script.clone(), dependency_root: temp.path().to_path_buf(), projection_root: temp.path().to_path_buf(), cli_version: "9.0.0".into() };
    let host = ManagementHost::with_sdk_runtime(runtime, Arc::new(|_| Ok(())));
    let config = ManagementSpawnConfig { executable: script.display().to_string(), agent_dir: Some(temp.path().to_path_buf()), extensions: vec![], env: vec![] };
    assert!(host.instance("global", &config).is_err());
    assert!(!marker.exists());
}

struct FakeServer(Child);
impl Drop for FakeServer {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

#[test]
fn sdk_runtime_serves_offline_management_without_dialogue() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let agent = dir.path().join("agent");
    let projection = dir.path().join("projection");
    fs::create_dir(&agent).unwrap();
    let node = PathBuf::from(std::env::var("PI_WEB_TEST_NODE").expect("PI_WEB_TEST_NODE required")).canonicalize().unwrap();
    let cli = std::env::var("PI_CLI_BIN").expect("PI_CLI_BIN required");
    let version = Command::new(cli).arg("--version").env("HOME", dir.path()).env("PI_OFFLINE", "1").env_remove("PI_PACKAGE_DIR").env_remove("JITI_ALIAS").output().unwrap();
    assert!(version.status.success());
    let version = String::from_utf8(version.stdout).unwrap().trim().to_owned();
    assert_eq!(version, "1.4.0");
    let build = Command::new(&node).arg(repo.join("scripts/migration/build-management-modules.mjs"))
        .args(["--sdk-runtime", "--out"]).arg(&projection).env("HOME", dir.path()).env("PI_OFFLINE", "1")
        .env_remove("PI_PACKAGE_DIR").env_remove("JITI_ALIAS").output().unwrap();
    assert!(build.status.success(), "{}", String::from_utf8_lossy(&build.stderr));
    let runtime = ManagementSdkRuntime {
        node: node.clone(), entry: repo.join("lib/pi-rpc/assets/management-sdk-entry.mjs"),
        dependency_root: repo.join("node_modules").canonicalize().unwrap(),
        projection_root: projection, cli_version: version,
    };
    let pinned_agent = agent.clone();
    let host = ManagementHost::with_sdk_runtime(runtime, Arc::new(move |path| if path == pinned_agent { Ok(()) } else { Err("agent directory denied".into()) }));
    let config = ManagementSpawnConfig { executable: "unused".into(), agent_dir: Some(agent.clone()), extensions: vec![],
        env: vec![("HOME".into(), dir.path().display().to_string()), ("PI_OFFLINE".into(), "1".into())] };
    let instance = host.instance("global", &config).unwrap();
    let (events, _subscription) = instance.client.on_event();
    let caps = instance.management_call_sync("sys.capabilities", json!({})).unwrap();
    assert_eq!(caps["version"], 1);
    let models = instance.management_call_sync("modelsConfig.get", json!({})).unwrap();
    assert!(models.is_object());
    let file = dir.path().join("session.jsonl");
    fs::write(&file, format!("{{\"type\":\"session\",\"version\":3,\"id\":\"fixture-session\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":{}}}\n", json!(dir.path()))).unwrap();
    let header = instance.management_call_sync("session.readHeader", json!({"file":file})).unwrap();
    assert_eq!(header["header"]["id"], "fixture-session");
    fs::write(agent.join("mcp.json"), json!({"mcpServers":{"fixture":{"command":node,"args":[repo.join("lib/__fixtures__/mcp-env-server.mjs")]}}}).to_string()).unwrap();
    let mcp = instance.management_call_sync("mcp.configGet", json!({"agentDir":agent,"allowedRoots":[]})).unwrap();
    assert_eq!(mcp["mcp"]["available"], true, "{mcp}");
    // The existing host correctly refuses broad stdio probes before running
    // them. The separate JS fixture exercises the same SDK connection itself.
    let refusal = instance.resolve_mcp_probe(json!({"agentDir":agent,"allowedRoots":[],"scope":"global","name":"fixture"})).err().unwrap();
    assert_eq!(refusal, "MCP probe has a broad unverified side-effect scope");
    let mut server = FakeServer(Command::new(&node).arg(repo.join("lib/__fixtures__/management-mcp-http-server.mjs"))
        .env("HOME", dir.path()).env("PI_OFFLINE", "1").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap());
    let mut url = String::new();
    BufReader::new(server.0.stdout.take().unwrap()).read_line(&mut url).unwrap();
    assert!(url.starts_with("http://127.0.0.1:"));
    fs::write(agent.join("mcp.json"), json!({"mcpServers":{"fixture":{"url":url.trim(),"headers":{"Authorization":"Bearer fixture"}}}}).to_string()).unwrap();
    let admission = instance.resolve_mcp_probe(json!({"agentDir":agent,"allowedRoots":[],"scope":"global","name":"fixture"})).unwrap();
    let handle = instance.start_mcp_probe(admission, Duration::from_secs(30)).unwrap();
    let until = std::time::Instant::now() + Duration::from_secs(30);
    let probe = loop {
        let snapshot = instance.task_snapshot(&handle).unwrap();
        if snapshot.status != TaskStatus::Running { break snapshot; }
        assert!(std::time::Instant::now() < until, "MCP probe timed out");
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(probe.status, TaskStatus::Succeeded, "{:?}", probe.error);
    assert_eq!(probe.result.unwrap()["result"]["state"], "connected");
    assert!(instance.extension_prompt("arbitrary prompt", Duration::from_secs(5)).is_err());
    assert!(events.try_iter().next().is_none(), "management emitted a dialogue event");
    assert!(!agent.join("sessions").exists(), "management created dialogue session files");
    host.shutdown_until(std::time::Instant::now() + Duration::from_secs(5));
}
