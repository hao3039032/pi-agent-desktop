//! Real management child over the Rust IPC dispatch, using only isolated fixture data.
#[cfg(unix)]
#[test]
fn distro_ipc_reaches_real_management_and_never_returns_key() {
    use serde_json::json;
    use std::path::Path;
    let Some(executable) = std::env::var("PI_CLI_BIN").ok().filter(|v| !v.is_empty()) else {
        eprintln!("skipping: PI_CLI_BIN not set"); return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let agent = tmp.path().join("agent"); let managed = tmp.path().join("managed");
    std::fs::create_dir_all(&agent).unwrap();
    let script = Path::new("../scripts/migration/build-management-modules.mjs").canonicalize().unwrap();
    let output = std::process::Command::new("node").arg(script).arg("--out").arg(&managed).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    std::fs::create_dir(managed.join("node_modules")).unwrap();
    std::os::unix::fs::symlink(Path::new("../node_modules/jiti").canonicalize().unwrap(), managed.join("node_modules/jiti")).unwrap();
    let state = crate::pi_ipc::IpcHostState::new();
    *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
    *state.management_config.lock().unwrap() = Some(management_host::ManagementSpawnConfig {
        executable, agent_dir: Some(agent),
        extensions: vec![Path::new("../lib/pi-rpc/assets/pi-web-management.mjs").canonicalize().unwrap()],
        env: vec![("PI_WEB_MANAGED_MODULES".into(), managed.to_string_lossy().into_owned()), ("HOME".into(), tmp.path().to_string_lossy().into_owned())],
    });
    let send = |op: &str, args: serde_json::Value| crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"fixture","op":op,"args":args}));
    let result = send("distro.configure", json!({"baseUrl":"http://127.0.0.1:12345","apiKey":"fixture-secret","useNpmMirror":false}));
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(result["data"]["hasApiKey"], true);
    assert!(!result.to_string().contains("fixture-secret"));
    let status = send("distro.status", json!({}));
    assert_eq!(status["data"]["baseUrl"], "http://127.0.0.1:12345");
    assert!(!status.to_string().contains("fixture-secret"));
    let forbidden = send("distro.seed", json!({"resourcesDir":tmp.path()}));
    assert_eq!(forbidden["ok"], false);
    assert_eq!(forbidden["error"]["code"], "unknown_op");
    state.management.shutdown_all(std::time::Duration::from_secs(5));
}
