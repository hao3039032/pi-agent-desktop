//! Task-associated Rust loopback listener for the managed MCP OAuth flow.
use std::{collections::HashSet, sync::Arc, thread, time::Duration};
use management_host::{ManagementInstance, TaskStatus};
use oauth_loopback::hosted::{Callback, HostedListener};
use serde_json::{json, Value};

pub(crate) fn start(instance: Arc<ManagementInstance>, task: String) -> std::io::Result<()> {
    thread::Builder::new().name("mcp-oauth-callback".into()).spawn(move || {
        let mut listener: Option<HostedListener> = None;
        let mut processed = HashSet::new();
        loop {
            let snapshot = match instance.task_snapshot(&task) { Ok(s) => s, Err(_) => break };
            if snapshot.status != TaskStatus::Running || snapshot.cancel_requested { break; }
            let Some(flow) = snapshot.progress else { thread::sleep(Duration::from_millis(20)); continue };
            if matches!(flow.get("phase").and_then(Value::as_str), Some("finishing" | "done" | "failed" | "cancelled" | "expired")) { break; }
            let Some(req) = flow.get("_hostCallback") else { thread::sleep(Duration::from_millis(20)); continue };
            let Some(id) = req.get("id").and_then(Value::as_str).filter(|id| id.len() == 36) else { break };
            let Some(kind) = req.get("kind").and_then(Value::as_str) else { break };
            if processed.contains(id) { thread::sleep(Duration::from_millis(20)); continue; }
            let response = match kind {
                "bind" if listener.is_none() => {
                    let host = req.get("host").and_then(Value::as_str).unwrap_or("");
                    let redirect_host = req.get("redirectHost").and_then(Value::as_str).unwrap_or("");
                    let path = req.get("path").and_then(Value::as_str).unwrap_or("");
                    let port = req.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).filter(|p| *p != 0);
                    if req.get("port").is_some() && port.is_none() { break; }
                    let extra: Vec<String> = req.get("extraPaths").and_then(Value::as_array).map(|v| v.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
                    match HostedListener::bind(host, redirect_host, port, req.get("required").and_then(Value::as_bool).unwrap_or(false), path, &extra) {
                        Ok(bound) => { let uri = bound.redirect_uri.clone(); listener = Some(bound); json!({"id":id,"kind":kind,"ok":true,"redirectUrl":uri}) }
                        Err(_) => json!({"id":id,"kind":kind,"ok":false,"error":"Could not bind OAuth callback"}),
                    }
                }
                "wait" if listener.is_some() => {
                    let state = req.get("state").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 1024);
                    let redirect = req.get("redirectUrl").and_then(Value::as_str).and_then(|s| url::Url::parse(s).ok());
                    let bound = url::Url::parse(&listener.as_ref().unwrap().redirect_uri).ok();
                    let (Some(state), Some(redirect), Some(bound)) = (state, redirect, bound) else { break };
                    if redirect.origin() != bound.origin() || redirect.query().is_some() || redirect.fragment().is_some() { break; }
                    match listener.as_ref().unwrap().poll(state, redirect.path()) {
                        Ok(None) => { thread::sleep(Duration::from_millis(20)); continue; }
                        Ok(Some(Callback::Code { code, iss })) => {
                            let mut answer = json!({"id":id,"kind":kind,"ok":true,"code":code});
                            if let Some(iss) = iss { answer["iss"] = json!(iss); }
                            answer
                        },
                        Ok(Some(Callback::Denied)) => json!({"id":id,"kind":kind,"ok":false,"error":"Authorization denied"}),
                        Err(_) => json!({"id":id,"kind":kind,"ok":false,"error":"OAuth callback failed"}),
                    }
                }
                _ => break,
            };
            processed.insert(id.to_owned());
            let mut input = json!({"action":"hostCallback", "response":response});
            if serde_json::to_vec(&input).map_or(true, |bytes| bytes.len() > 4096) {
                input = json!({"action":"hostCallback", "response":{"id":id,"kind":kind,"ok":false,"error":"OAuth callback exceeds the task input limit"}});
            }
            if instance.submit_task_input(&task, input).is_err() { break; }
        }
    })?;
    Ok(())
}
