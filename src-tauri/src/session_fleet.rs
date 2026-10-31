//! Restricted pi-subagents control surface. No arbitrary bridge operation or
//! caller-selected path is accepted here; the child package owns run identity.
use serde_json::{json, Value};
use std::time::Duration;
use crate::pi_ipc::IpcHostState;

fn fail(code: &str, message: impl Into<String>) -> (String, String) { (code.into(), message.into()) }
fn rpc(session: &session_host::Session, method: &str, params: Option<Value>, timeout: u64) -> Result<Value, (String, String)> {
    let mut args = json!({"timeoutMs": timeout * 1000});
    if let Some(params) = params { args["params"] = params; }
    let response = session.bridge_request(&format!("subagents.{method}"), Some(args), Some(Duration::from_secs(timeout + 5)))
        .map_err(|e| {
            let message = e.to_string();
            let reason = if session.is_transport_closing() { "session-closed" }
                else if message.contains("unknown bridge op") { "unknown" }
                else { "unresponsive" };
            fail(reason, message)
        })?;
    if response.get("success").and_then(Value::as_bool) == Some(true) { return Ok(response.get("data").cloned().unwrap_or(Value::Null)); }
    let error = &response["error"];
    Err(fail(error.get("code").and_then(Value::as_str).unwrap_or("incompatible"), error.get("message").and_then(Value::as_str).unwrap_or("invalid subagent reply")))
}

fn source_state(tools: &Value, commands: &Value) -> &'static str {
    let sources = tools.get("tools").and_then(Value::as_array).into_iter().flatten()
        .chain(commands.get("commands").and_then(Value::as_array).into_iter().flatten())
        .filter_map(|value| value.get("sourceInfo").and_then(Value::as_object));
    let mut seen = false;
    for source in sources {
        seen = true;
        for field in ["path", "source"] {
            let value = source.get(field).and_then(Value::as_str).unwrap_or("").replace('\\', "/");
            if value.split('/').any(|s| s == "pi-subagents") || value.strip_prefix("npm:").unwrap_or(&value).split('@').next() == Some("pi-subagents") { return "loaded"; }
        }
    }
    if seen { "not-loaded" } else { "unknown" }
}

fn identifier(value: Option<&Value>) -> Result<&str, (String, String)> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| (33..=126).contains(&b) && b != b'/' && b != b'\\'))
        .ok_or_else(|| fail("invalid_args", "invalid run identifier"))
}

/// Public IPC operations: `agent.subagentsStatus` and `agent.subagentsAction`.
pub fn dispatch(state: &IpcHostState, op: &str, args: &Value) -> Result<Value, (String, String)> {
    let sid = args.get("session").and_then(Value::as_str).filter(|v| !v.is_empty()).ok_or_else(|| fail("invalid_args", "session required"))?;
    let session = state.registry.get(sid).ok_or_else(|| fail("not_found", "session not running"))?;
    if crate::session_view::is_chat_workspace_path(&session.cwd, &state.agent_dir()) { return Err(fail("chat-workspace", "Subagents are not available in chats")); }
    let tools = session.bridge_request("tools.list", None, Some(Duration::from_secs(10)));
    let commands = session.command("get_commands", json!({}), Some(Duration::from_secs(10)));
    if session.is_transport_closing() {
        if op == "agent.subagentsStatus" { return Ok(json!({"available":false,"reason":"session-closed"})); }
        return Err(fail("session-closed", "session is closing"));
    }
    let detected = source_state(tools.as_ref().unwrap_or(&Value::Null), commands.as_ref().unwrap_or(&Value::Null));
    let complete = tools.as_ref().ok().and_then(|v| v.get("tools")).is_some_and(Value::is_array)
        && commands.as_ref().ok().and_then(|v| v.get("commands")).is_some_and(Value::is_array);
    let source = if detected != "loaded" && !complete { "unknown" } else { detected };
    if source != "loaded" {
        if op == "agent.subagentsStatus" { return Ok(json!({"available":false,"reason":source})); }
        return Err(fail(source, "pi-subagents source is not confirmed for this session"));
    }
    let ping = match rpc(&session, "ping", None, 3) {
        Ok(value) => value,
        Err((code, message)) if op == "agent.subagentsStatus" => return Ok(json!({"available":false,"reason":code,"error":message})),
        Err(error) => return Err(error),
    };
    if ping["version"] != 1 || !ping["methods"].as_array().is_some_and(|v| v.iter().any(|m| m == "status")) {
        if op == "agent.subagentsStatus" { return Ok(json!({"available":false,"reason":"incompatible"})); }
        return Err(fail("incompatible", "pi-subagents does not advertise v1 status"));
    }
    if op == "agent.subagentsStatus" {
        return match rpc(&session, "status", None, 20) {
            Ok(status) => Ok(json!({"available":true,"ping":ping,"status":status})),
            Err((code, message)) if code == "session-closed" => Ok(json!({"available":false,"reason":"session-closed","error":message})),
            Err((code, message)) => Ok(json!({"available":false,"reason":"status-failed","error":format!("{code}: {message}")})),
        };
    }
    let body = args.get("body").and_then(Value::as_object).ok_or_else(|| fail("invalid_args", "action body required"))?;
    let action = body.get("action").and_then(Value::as_str).unwrap_or("");
    let allowed: &[&str] = match action {
        "inspect" => &["action", "runId", "index", "lines"],
        "steer" => &["action", "runId", "message", "mode"],
        "interrupt" => &["action", "runId"],
        "stop" => &["action", "runId", "childId"],
        _ => return Err(fail("invalid_args", "unknown subagent action")),
    };
    if body.keys().any(|k| !allowed.contains(&k.as_str())) { return Err(fail("invalid_args", "unknown action parameter")); }
    let run_id = identifier(body.get("runId"))?;
    let method = if action == "inspect" { "status" } else { action };
    if ping["capabilities"][method] != true { return Err(fail("capability-unavailable", "action not advertised")); }
    let mut params = json!({"id":run_id});
    match action {
        "inspect" => {
            params["view"] = json!("transcript");
            let lines = match body.get("lines") { None => 80, Some(value) => value.as_u64().filter(|n| (1..=500).contains(n)).ok_or_else(|| fail("invalid_args", "invalid lines"))? };
            params["lines"] = json!(lines);
            if let Some(value) = body.get("index") { params["index"] = json!(value.as_u64().filter(|n| *n <= 1000).ok_or_else(|| fail("invalid_args", "invalid index"))?); }
        }
        "steer" => {
            let message = body.get("message").and_then(Value::as_str).filter(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 8000).ok_or_else(|| fail("invalid_args", "invalid message"))?;
            params["message"] = json!(message.trim());
            if let Some(value) = body.get("mode") { let mode = value.as_str().filter(|s| matches!(*s, "steer" | "follow_up" | "auto")).ok_or_else(|| fail("invalid_args", "invalid mode"))?; params["mode"] = json!(mode); }
        }
        "stop" => if body.contains_key("childId") { params["childId"] = json!(identifier(body.get("childId"))?); },
        _ => {}
    }
    let result = rpc(&session, method, Some(params), 20)?;
    Ok(json!({"action":action,"runId":run_id,"result":result}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_pi_fake_extension_fleet_whitelist() {
        let Ok(executable) = std::env::var("PI_CLI_BIN") else { eprintln!("skipping: PI_CLI_BIN not set"); return };
        let dir = tempfile::tempdir().unwrap();
        let agent = dir.path().join("agent");
        let cwd = dir.path().join("work");
        let extdir = dir.path().join("pi-subagents");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&extdir).unwrap();
        let marker = dir.path().join("calls");
        let disable = dir.path().join("disable-stop");
        let extension = extdir.join("index.mjs");
        std::fs::write(&extension, format!(r#"
import {{ appendFileSync, existsSync }} from 'node:fs';
export default pi => {{
  pi.registerCommand('fixture-fleet', {{ handler: async () => {{}} }});
  pi.events.on('subagents:rpc:v1:request', req => {{
    appendFileSync({:?}, JSON.stringify(req) + '\n');
    if (req.params?.id === 'hold') return;
    if (req.params?.id === 'foreign') {{
      pi.events.emit('subagents:rpc:v1:reply:' + req.requestId, {{version:1, requestId:req.requestId, success:false, error:{{code:'not_found',message:'not owned'}}}});
      return;
    }}
    const data = req.method === 'ping'
      ? {{version:1, methods:['status','steer','interrupt','stop'], capabilities:{{status:true,steer:true,interrupt:true,stop:!existsSync({:?})}}}}
      : req.method === 'status' ? {{text:'fixture transcript', asyncSnapshot:{{runs:[]}}}} : {{accepted:true}};
    pi.events.emit('subagents:rpc:v1:reply:' + req.requestId, {{version:1, requestId:req.requestId, success:true, data}});
  }});
}};
"#, marker.to_string_lossy(), disable.to_string_lossy())).unwrap();
        let (file, id) = session_host::create_session_file(&dir.path().join("sessions"), &cwd).unwrap();
        let state = std::sync::Arc::new(IpcHostState::new());
        *state.task_agent_dir.lock().unwrap() = Some(agent.clone());
        let config = session_host::SessionSpawnConfig {
            executable, agent_dir: Some(agent), session_dir: None,
            bridge_asset: std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs").canonicalize().unwrap(),
            artifacts_asset: None, chat_asset: None, chat_asset_sha256: None,
            shape: session_host::SessionSpawnShape::Project { tool_args: None },
            initial_model: None, thinking_level: None,
            extra_args: vec!["--extension".into(), extension.to_string_lossy().into_owned()],
        };
        state.registry.start(&id, &file, &id, &cwd, &config).unwrap();
        let status = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"status","op":"agent.subagentsStatus","args":{"session":id}}));
        assert_eq!(status["data"]["available"], true, "{status}");
        for body in [json!({"action":"inspect","runId":"run-1"}), json!({"action":"steer","runId":"run-1","message":"hello"}), json!({"action":"interrupt","runId":"run-1"}), json!({"action":"stop","runId":"run-1"})] {
            let reply = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"action","op":"agent.subagentsAction","args":{"session":id,"body":body}}));
            assert_eq!(reply["ok"], true, "{reply}");
        }
        for body in [json!({"action":"spawn","runId":"x"}), json!({"action":"stop","runId":"x","path":"/tmp"})] {
            let reply = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"refused","op":"agent.subagentsAction","args":{"session":id,"body":body}}));
            assert_eq!(reply["ok"], false, "{reply}");
        }
        let foreign = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"foreign","op":"agent.subagentsAction","args":{"session":id,"body":{"action":"stop","runId":"foreign"}}}));
        assert_eq!(foreign["error"]["code"], "not_found", "{foreign}");
        std::fs::write(&disable, "off").unwrap();
        let refused = crate::pi_ipc::dispatch_envelope(&state, json!({"v":1,"id":"capability","op":"agent.subagentsAction","args":{"session":id,"body":{"action":"stop","runId":"disabled"}}}));
        assert_eq!(refused["error"]["code"], "invalid_args", "{refused}");
        assert_eq!(refused["error"]["reason"], "capability-unavailable", "{refused}");
        std::fs::remove_file(&disable).unwrap();
        let calls = std::fs::read_to_string(&marker).unwrap();
        assert!(!calls.contains("spawn") && !calls.contains("/tmp") && !calls.contains("disabled"), "{calls}");
        for method in ["status", "steer", "interrupt", "stop"] { assert!(calls.contains(&format!("\"method\":\"{method}\"")), "{calls}"); }
        let worker_state = std::sync::Arc::clone(&state);
        let worker_id = id.clone();
        let worker = std::thread::spawn(move || crate::pi_ipc::dispatch_envelope(&worker_state, json!({"v":1,"id":"hold","op":"agent.subagentsAction","args":{"session":worker_id,"body":{"action":"inspect","runId":"hold"}}})));
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while !std::fs::read_to_string(&marker).unwrap().contains("\"id\":\"hold\"") {
            assert!(std::time::Instant::now() < until, "held call did not reach fixture");
            std::thread::sleep(Duration::from_millis(10));
        }
        state.registry.remove(&id, Duration::from_secs(5));
        let result = worker.join().unwrap();
        assert_eq!(result["ok"], false, "child exit must settle the call: {result}");
        assert_eq!(result["error"]["reason"], "session-closed", "{result}");
    }

    #[test]
    fn source_detection_never_guesses_from_tool_names() {
        assert_eq!(source_state(&json!({"tools":[{"name":"Agent"}]}), &json!({})), "unknown");
        assert_eq!(source_state(&json!({"tools":[{"name":"other","sourceInfo":{"path":"/x/pi-subagents/index.js"}}]}), &json!({})), "loaded");
        assert_eq!(source_state(&json!({"tools":[{"name":"Agent","sourceInfo":{"path":"/x/other.js"}}]}), &json!({})), "not-loaded");
    }
}
