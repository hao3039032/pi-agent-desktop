//! A deterministic fake `pi --mode rpc` child for the protocol tests.
//!
//! Behavior is driven by JSON commands on stdin (see tests/mock_protocol.rs);
//! the `MOCK_PI_SCENARIO` env var only selects startup/EOF behavior so the
//! tests stay in control:
//!
//! - unset / `default`: normal loop; exits 0 on stdin EOF;
//! - `no_exit_on_eof`:  keeps running after stdin EOF (grace-kill tests);
//! - `split_hello`:     emits one record split mid-UTF-8 and one write
//!   carrying two records before reading anything;
//! - `answer_then_die`: `slow {delay}` answers, prints the response, then
//!   exits 0 IMMEDIATELY without flushing order guarantees — the client's
//!   exit watcher must still dispatch the buffered response (drain race);
//! - `oversize_line`:   prints one record over the client's stdout cap,
//!   then behaves normally (the cap drops the line, not the stream).
//!
//! Commands (the `type` field of each stdin record):
//! - `get_state`, `echo` (echoes `data.payload`), `notify_send` (emits one
//!   event record then responds), `garbage` (one unparseable line, then
//!   responds), `stderr_big` (>16 KiB stderr line), `stderr_text` (one normal
//!   line), `die {code}`, `slow {delay_ms}` (responds after the delay);
//! - `ask_ui {method?,timeout?}`: emits one `extension_ui_request` and waits
//!   for the matching `extension_ui_response`, then responds with the answer;
//! - `burst_ui {count}`: emits `count` dialog requests without waiting;
//! - `collect_ui`: responds with every `extension_ui_response` received so
//!   far (tests assert what the client actually answered).

use std::io::{BufRead, BufReader, Read, Write};

fn main() {
    let scenario = std::env::var("MOCK_PI_SCENARIO").unwrap_or_else(|_| "default".into());
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());

    if scenario == "startup_ui" {
        let _ = out.write_all(b"{\"type\":\"extension_ui_request\",\"id\":\"startup\",\"method\":\"confirm\",\"title\":\"Continue?\"}\n");
        let _ = out.flush();
    }

    if scenario == "split_hello" {
        // One record split mid-UTF-8 across writes (chunked delivery), then
        // two records in ONE write.
        let record = format!(
            "{{\"type\":\"split_record\",\"text\":\"{}{}{}\"}}",
            "埃", "文", "\u{2028}·\u{2029}"
        );
        let bytes = record.as_bytes();
        for chunk in bytes.chunks(7) {
            let _ = out.write_all(chunk);
            let _ = out.flush();
        }
        let _ = out.write_all(b"\n");
        let _ = out.write_all(b"{\"type\":\"event_one\"}\n{\"type\":\"event_two\"}\n");
        let _ = out.flush();
    }

    if scenario == "oversize_line" {
        // One record beyond the client's 64 MiB stdout cap: dropped whole;
        // the stream continues afterwards.
        let _ = out.write_all(b"{\"type\":\"big\",\"pad\":\"");
        let chunk = "x".repeat(8192);
        for _ in 0..(64 * 1024 / 8 + 2) {
            let _ = out.write_all(chunk.as_bytes());
        }
        let _ = out.write_all(b"\"}\n");
        let _ = out.write_all(b"{\"type\":\"after_big\"}\n");
        let _ = out.flush();
    }

    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut collected: Vec<serde_json::Value> = Vec::new();
    let mut buf = Vec::new();

    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                }
                let Ok(record) = serde_json::from_slice::<serde_json::Value>(&buf) else { continue };
                if !handle(&mut out, record, &mut collected, &mut reader) {
                    return;
                }
            }
            Err(_) => break,
        }
    }

    if scenario == "no_exit_on_eof" {
        std::thread::sleep(std::time::Duration::from_secs(600));
        std::process::exit(7);
    }
}

/// Handle one record; returns false when the mock should exit.
fn handle<W: Write, R: Read>(
    out: &mut W,
    record: serde_json::Value,
    collected: &mut Vec<serde_json::Value>,
    reader: &mut BufReader<R>,
) -> bool {
    let type_ = record.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let id = record.get("id").cloned().unwrap_or(serde_json::Value::Null);

    match type_ {
        "extension_ui_response" => {
            collected.push(record);
            true
        }
        "get_state" => {
            respond(out, &id, "get_state", serde_json::json!({
                "sessionId": "mock-session-id",
                "sessionFile": "/mock/session.jsonl",
                "thinkingLevel": "off",
                "isStreaming": false,
                "isCompacting": false,
            }));
            true
        }
        "answer_then_die" => {
            // Write the response, close stdout, and exit at once: the bytes
            // are in the pipe while the process is already gone.
            let payload = record.get("payload").cloned().unwrap_or(serde_json::Value::Null);
            respond(out, &id, "answer_then_die", payload);
            let _ = out.flush();
            drop(out);
            use std::io::Write as _;
            let _ = std::io::stdout().flush();
            std::process::exit(0);
        }
        "echo" => {
            let payload = record.get("payload").cloned().unwrap_or(serde_json::Value::Null);
            respond(out, &id, "echo", payload);
            true
        }
        "notify_send" => {
            let message = record.get("message").and_then(|v| v.as_str()).unwrap_or("");
            emit(out, serde_json::json!({ "type": "notice", "message": message }));
            respond(out, &id, "notify_send", serde_json::Value::Null);
            true
        }
        "slow" => {
            let delay = record.get("delay_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            if delay > 0 {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                respond(out, &id, "slow", serde_json::Value::Null);
            }
            // delay 0: never responds (the timeout fixture).
            true
        }
        "garbage" => {
            let _ = out.write_all(b"<<<this is not json>>>\n");
            let _ = out.flush();
            respond(out, &id, "garbage", serde_json::Value::Null);
            true
        }
        "stderr_big" => {
            let stderr = std::io::stderr();
            let mut stderr = stderr.lock();
            let _ = stderr.write_all(&vec![b'x'; 20_000]);
            let _ = stderr.write_all(b"\n");
            let _ = stderr.flush();
            respond(out, &id, "stderr_big", serde_json::Value::Null);
            true
        }
        "stderr_text" => {
            let stderr = std::io::stderr();
            let mut stderr = stderr.lock();
            let _ = stderr.write_all(b"mock diagnostic line\n");
            let _ = stderr.flush();
            respond(out, &id, "stderr_text", serde_json::Value::Null);
            true
        }
        "die" => {
            let code = record.get("code").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            respond(out, &id, "die", serde_json::Value::Null);
            let _ = out.flush();
            std::process::exit(code);
        }
        "ask_ui" => {
            let method = record.get("method").and_then(|v| v.as_str()).unwrap_or("select").to_string();
            let ui_id = format!("ui-{}", uuid::Uuid::new_v4());
            let mut request = serde_json::json!({
                "type": "extension_ui_request",
                "id": ui_id,
                "method": method,
                "title": "mock dialog",
            });
            if let Some(timeout) = record.get("timeout").and_then(|v| v.as_u64()) {
                request["timeout"] = serde_json::json!(timeout);
            }
            emit(out, request);
            // Wait for the matching response (collecting everything else).
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => return false,
                    Ok(_) => {
                        if line.last() == Some(&b'\n') {
                            line.pop();
                        }
                        let Ok(inner) = serde_json::from_slice::<serde_json::Value>(&line) else { continue };
                        if inner.get("type").and_then(|v| v.as_str()) == Some("extension_ui_response") {
                            let is_match = inner.get("id").and_then(|v| v.as_str()) == Some(ui_id.as_str());
                            collected.push(inner.clone());
                            if is_match {
                                respond(out, &id, "ask_ui", serde_json::json!({ "answer": inner }));
                                return true;
                            }
                        }
                    }
                    Err(_) => return false,
                }
            }
        }
        "burst_ui" => {
            let count = record.get("count").and_then(|v| v.as_u64()).unwrap_or(1);
            let method_override = record.get("method").and_then(|v| v.as_str()).map(str::to_string);
            let extra = record.get("extra").cloned().unwrap_or(serde_json::Value::Null);
            for index in 0..count {
                let method = method_override
                    .clone()
                    .unwrap_or_else(|| if index % 2 == 0 { "select".into() } else { "notify".to_string() });
                let mut request = serde_json::json!({
                    "type": "extension_ui_request",
                    "id": format!("burst-{index}"),
                    "method": method,
                    "title": format!("mock burst {index}"),
                });
                if let Some(fields) = extra.as_object() {
                    for (key, value) in fields {
                        request[key] = value.clone();
                    }
                }
                emit(out, request);
            }
            respond(out, &id, "burst_ui", serde_json::Value::Null);
            true
        }
        "collect_ui" => {
            respond(out, &id, "collect_ui", serde_json::json!({ "responses": collected.clone() }));
            true
        }
        _ => true,
    }
}

fn respond<W: Write>(out: &mut W, id: &serde_json::Value, command: &str, data: serde_json::Value) {
    let record = serde_json::json!({
        "id": id,
        "type": "response",
        "command": command,
        "success": true,
        "data": data,
    });
    emit(out, record);
}

fn emit<W: Write>(out: &mut W, record: serde_json::Value) {
    let _ = serde_json::to_writer(&mut *out, &record);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}
