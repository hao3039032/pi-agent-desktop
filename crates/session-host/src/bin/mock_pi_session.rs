//! A deterministic fake `pi --mode rpc` child for the session-host tests.
//!
//! Unlike `pi-host`'s mock_pi (adversarial transport fixtures), this one
//! speaks the SESSION contract: `get_state` answers a configurable session
//! identity, `get_commands` answers a configurable command list (so the
//! handshake's bridge / chat-policy attribution checks run against real
//! answers), and `prompt` can be HELD until the test releases it (the
//! drain/wake interleavings need a child that is mid-delivery on demand).
//!
//! Configuration arrives as ARGUMENTS (per spawn, never process-global env:
//! cargo runs this crate's tests in parallel):
//! - `--mock-session-id <id>`        the sessionId `get_state` reports;
//! - `--mock-commands <base64-json>` the full `get_commands` data value
//!   (`{"commands":[{name,source,sourceInfo:{path}}, ...]}`);
//! - `--mock-prompt-hold`            `prompt` blocks until a
//!   `release_prompt` record arrives on stdin;
//! - `--mock-prompt-hold-past-eof`   like `--mock-prompt-hold`, but the hold
//!   SURVIVES stdin EOF (sleeping through the EOF reads until the host's
//!   grace kill takes the child down): a replacement's `close(grace)` then
//!   delays the held delivery's failure to the kill, giving the
//!   interleaving tests a deterministic window in which the NEW session
//!   starts and queues its own items before the old drain's in-flight
//!   RESULT lands.
//! - `--mock-prompt-events <b64l>`   base64 JSONL records emitted before
//!   each prompt response (agent_start / message_update / agent_settled …);
//! - `--mock-prompt-disposition <d>` the prompt response's disposition
//!   (default "started");
//! - `--mock-prompt-log <path>`       append one line per prompt MESSAGE the
//!   child receives (the drain tests assert exactly which queued messages
//!   reached which child — a replacement child must never see a message
//!   the old child already claimed).

use std::io::{BufRead, BufReader, Write};

fn respond(out: &mut impl Write, id: &serde_json::Value, command: &str, data: serde_json::Value) {
    let record = serde_json::json!({
        "id": id,
        "type": "response",
        "command": command,
        "success": true,
        "data": data,
    });
    emit(out, record);
}
fn emit(out: &mut impl Write, record: serde_json::Value) {
    let _ = serde_json::to_writer(&mut *out, &record);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

fn b64_decode(text: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .unwrap_or_default()
}

struct Config {
    session_id: String,
    commands: serde_json::Value,
    prompt_hold: bool,
    prompt_drop_ack: bool,
    prompt_hold_past_eof: bool,
    stay_after_eof: bool,
    prompt_events: Vec<serde_json::Value>,
    prompt_disposition: String,
    assert_busy_after_prompt: bool,
    prompt_log: Option<std::path::PathBuf>,
    abort_log: Option<std::path::PathBuf>,
}

fn parse_args() -> Config {
    let mut config = Config {
        session_id: "mock-session-id".into(),
        commands: serde_json::json!({ "commands": [] }),
        prompt_hold: false,
        prompt_drop_ack: false,
        prompt_hold_past_eof: false,
        stay_after_eof: false,
        prompt_events: Vec::new(),
        prompt_disposition: "started".into(),
        assert_busy_after_prompt: false,
        prompt_log: None,
        abort_log: None,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--mock-session-id" => {
                if let Some(value) = args.next() {
                    config.session_id = value;
                }
            }
            "--mock-commands" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = serde_json::from_slice(&b64_decode(&value)) {
                        config.commands = parsed;
                    }
                }
            }
            "--mock-prompt-hold" => config.prompt_hold = true,
            "--mock-prompt-drop-ack" => config.prompt_drop_ack = true,
            "--mock-assert-busy-after-prompt" => config.assert_busy_after_prompt = true,
            "--mock-stay-after-eof" => config.stay_after_eof = true,
            "--mock-prompt-hold-past-eof" => {
                config.prompt_hold = true;
                config.prompt_hold_past_eof = true;
            }
            "--mock-prompt-events" => {
                if let Some(value) = args.next() {
                    for line in String::from_utf8_lossy(&b64_decode(&value)).lines() {
                        if let Ok(record) = serde_json::from_str(line) {
                            config.prompt_events.push(record);
                        }
                    }
                }
            }
            "--mock-prompt-disposition" => {
                if let Some(value) = args.next() {
                    config.prompt_disposition = value;
                }
            }
            "--mock-prompt-log" => {
                if let Some(value) = args.next() {
                    config.prompt_log = Some(std::path::PathBuf::from(value));
                }
            }
            "--mock-abort-log" => {
                if let Some(value) = args.next() {
                    config.abort_log = Some(std::path::PathBuf::from(value));
                }
            }
            _ => {}
        }
    }
    config
}

fn main() {
    let config = parse_args();
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    let mut buf = Vec::new();
    let mut prompt_admitted = false;

    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) if config.stay_after_eof => std::thread::sleep(std::time::Duration::from_millis(20)),
            Ok(0) => break,
            Ok(_) => {
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                }
                let Ok(record) = serde_json::from_slice::<serde_json::Value>(&buf) else { continue };
                let type_ = record.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let id = record.get("id").cloned().unwrap_or(serde_json::Value::Null);
                match type_ {
                    "get_state" => {
                        respond(&mut out, &id, "get_state", serde_json::json!({
                            "sessionId": config.session_id,
                            "sessionFile": "/mock/session.jsonl",
                            "thinkingLevel": "off",
                            "isStreaming": false,
                            "isCompacting": false,
                        }));
                    }
                    "get_commands" => {
                        respond(&mut out, &id, "get_commands", config.commands.clone());
                    }
                    "get_session_stats" => {
                        respond(&mut out, &id, "get_session_stats", serde_json::json!({}));
                    }
                    "set_model" => {
                        respond(&mut out, &id, "set_model", serde_json::Value::Null);
                    }
                    "interrupt" => {
                        emit(&mut out, serde_json::json!({ "type": "agent_settled" }));
                        respond(&mut out, &id, "interrupt", serde_json::Value::Null);
                    }
                    "prompt" => {
                        if let Some(message) = record.get("message").and_then(|value| value.as_str()).filter(|message| message.starts_with("/pi-web:bridge ")) {
                            use base64::Engine as _;
                            let parts: Vec<_> = message.split_whitespace().collect();
                            if parts.len() == 3 {
                                if let Ok(payload) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[2]) {
                                    if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&payload) {
                                        if payload["op"] == "meta.scheduled-run" {
                                            respond(&mut out, &id, "prompt", serde_json::json!({"disposition":"handled"}));
                                            let envelope = serde_json::json!({"sid":config.session_id,"rid":parts[1],"nonce":payload["nonce"],"ok":true,"result":{"entry":"scheduled-run"}});
                                            emit(&mut out, serde_json::json!({"type":"extension_ui_request","id":"fixture-notify","method":"notify","message":format!("PI_WEB_BRIDGE_V1 {envelope}")}));
                                            continue;
                                        }
                                        if payload["op"] == "tree.assertIdle" {
                                            respond(&mut out, &id, "prompt", serde_json::json!({"disposition":"handled"}));
                                            let envelope = if config.assert_busy_after_prompt && prompt_admitted {
                                                serde_json::json!({"sid":config.session_id,"rid":parts[1],"nonce":payload["nonce"],"ok":false,"error":"session is busy"})
                                            } else {
                                                serde_json::json!({"sid":config.session_id,"rid":parts[1],"nonce":payload["nonce"],"ok":true,"result":{}})
                                            };
                                            emit(&mut out, serde_json::json!({"type":"extension_ui_request","id":"fixture-notify","method":"notify","message":format!("PI_WEB_BRIDGE_V1 {envelope}")}));
                                            continue;
                                        }
                                    }
                                }
                            }
                        }
                        prompt_admitted = true;
                        if let Some(log) = &config.prompt_log {
                            use std::io::Write as _;
                            // The host's command record is FLAT: the
                            // message sits at the top level beside `type`.
                            let message = record
                                .get("message")
                                .and_then(|message| message.as_str())
                                .unwrap_or("");
                            if let Ok(mut file) = std::fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(log)
                            {
                                let _ = writeln!(file, "{message}");
                            }
                        }
                        if config.prompt_drop_ack { continue; }
                        if config.prompt_hold {
                            // Hold the delivery mid-flight until the test
                            // releases it (answering get_state probes read
                            // while held, collecting everything else).
                            let mut held = Vec::new();
                            loop {
                                held.clear();
                                match reader.read_until(b'\n', &mut held) {
                                    Ok(0) => {
                                        // EOF: the host began the orderly
                                        // shutdown. A plain hold ends here
                                        // (the delivery fails at once); the
                                        // past-eof hold keeps sleeping
                                        // through it so only the grace KILL
                                        // ends the child — the failure of
                                        // the held delivery is then delayed
                                        // to the kill, after the grace
                                        // window the test relies on.
                                        if !config.prompt_hold_past_eof {
                                            return;
                                        }
                                        std::thread::sleep(std::time::Duration::from_millis(50));
                                        continue;
                                    }
                                    Ok(_) => {
                                        if held.last() == Some(&b'\n') {
                                            held.pop();
                                        }
                                        let Ok(inner) =
                                            serde_json::from_slice::<serde_json::Value>(&held)
                                        else {
                                            continue;
                                        };
                                        match inner.get("type").and_then(|v| v.as_str()) {
                                            Some("release_prompt") => {
                                                // Answer the release command itself (the
                                                // test's command() awaits it), then end
                                                // the hold.
                                                respond(
                                                    &mut out,
                                                    inner.get("id").unwrap_or(&serde_json::Value::Null),
                                                    "release_prompt",
                                                    serde_json::Value::Null,
                                                );
                                                break;
                                            }
                                            Some("get_state") => {
                                                respond(
                                                    &mut out,
                                                    inner.get("id").unwrap_or(&serde_json::Value::Null),
                                                    "get_state",
                                                    serde_json::json!({
                                                        "sessionId": config.session_id,
                                                        "sessionFile": "/mock/session.jsonl",
                                                        "thinkingLevel": "off",
                                                        "isStreaming": false,
                                                        "isCompacting": false,
                                                    }),
                                                );
                                            }
                                            _ => {}
                                        }
                                    }
                                    Err(_) => return,
                                }
                            }
                        }
                        for record in &config.prompt_events {
                            // A configured array is a compact event LIST; the
                            // host's fan-out wants one record per line.
                            match record {
                                serde_json::Value::Array(list) => {
                                    for item in list {
                                        emit(&mut out, item.clone());
                                    }
                                }
                                other => emit(&mut out, other.clone()),
                            }
                        }
                        respond(&mut out, &id, "prompt", serde_json::json!({
                            "disposition": config.prompt_disposition,
                        }));
                    }
                    _ => {
                        if type_ == "abort" {
                            if let Some(path) = &config.abort_log { let _ = std::fs::write(path, "abort rejected"); }
                        }
                        // An unknown command is an explicit failure, not a
                        // hang: the handshake's error paths stay observable.
                        let record = serde_json::json!({
                            "id": id,
                            "type": "response",
                            "command": type_,
                            "success": false,
                            "error": format!("mock_pi_session does not implement '{type_}'"),
                        });
                        emit(&mut out, record);
                    }
                }
            }
            Err(_) => break,
        }
    }
}
