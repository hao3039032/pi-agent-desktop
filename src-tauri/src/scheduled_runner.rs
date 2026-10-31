//! One scheduled run on an already-started registry session. The caller owns
//! the durable run record and supplies its session-link transaction.
use serde_json::{json, Value};
use session_host::Session;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct RunOutcome {
    pub status: &'static str,
    pub error: Option<String>,
    pub error_code: Option<&'static str>,
    pub counts_as_failure: bool,
}

fn failure(error: impl Into<String>) -> RunOutcome {
    RunOutcome { status: "failed", error: Some(error.into()), error_code: None, counts_as_failure: true }
}

/// The marker acknowledgement and durable session link are both required
/// before the first prompt. A failed link must never send an untracked run.
pub fn run_session(
    session: &Session,
    marker: Value,
    prompt: &str,
    limit: Duration,
    link_session: impl FnOnce(&str) -> Result<(), String>,
) -> RunOutcome {
    let confirmed = match session.bridge_request("meta.scheduled-run", Some(marker), Some(Duration::from_secs(30))) {
        Ok(value) => value,
        Err(error) => return failure(format!("tagging the session as a scheduled run failed: {error}")),
    };
    if confirmed["entry"] != "scheduled-run" {
        return failure("the scheduled-run marker was not confirmed");
    }
    if let Err(error) = link_session(&session.id) { return failure(format!("recording the scheduled session failed: {error}")); }
    let (subscriber, events) = session.subscribe();
    let result = (|| {
        match session.command("prompt", json!({ "message": prompt }), Some(Duration::from_secs(120))) {
            Err(error) => {
                // A lost acknowledgement does not prove the prompt was rejected.
                // Abort rather than leaving a possibly running child behind.
                let _ = session.command("abort", json!({}), Some(Duration::from_secs(5)));
                return failure(error.to_string());
            }
            Ok(response) if matches!(response["disposition"].as_str(), Some("handled" | "queued")) => {
                return failure("scheduled prompt did not start a new run");
            }
            Ok(_) => {}
        }
        let deadline = Instant::now() + limit;
        let mut last_assistant = Value::Null;
        let mut timed_out = false;
        let mut end = deadline;
        loop {
            let now = Instant::now();
            if now >= end {
                if timed_out {
                    session.shutdown(Duration::from_secs(5));
                    return RunOutcome { status: "aborted", error: Some("Stopped after reaching the time limit".into()), error_code: Some("time-limit"), counts_as_failure: true };
                }
                timed_out = true;
                let _ = session.command("abort", json!({}), Some(Duration::from_secs(5)));
                end = Instant::now() + Duration::from_secs(30);
                continue;
            }
            match events.recv_timeout((end - now).min(Duration::from_secs(1))) {
                Ok(event) => match event["type"].as_str() {
                    Some("message_end") if event["message"]["role"] == "assistant" => last_assistant = event["message"].clone(),
                    Some("agent_settled") => {
                        if timed_out { return RunOutcome { status: "aborted", error: Some("Stopped after reaching the time limit".into()), error_code: Some("time-limit"), counts_as_failure: true }; }
                        return match last_assistant["stopReason"].as_str() {
                            Some("error") => failure(last_assistant["errorMessage"].as_str().unwrap_or("Model request failed")),
                            Some("aborted") => RunOutcome { status: "aborted", error: Some("Stopped by the user".into()), error_code: Some("stopped"), counts_as_failure: false },
                            None => failure("scheduled run settled without an assistant response"),
                            _ => RunOutcome { status: "succeeded", error: None, error_code: None, counts_as_failure: false },
                        };
                    }
                    _ => {}
                },
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if session.wait_for_settle(u64::MAX, Duration::ZERO) == session_host::SettleOutcome::ChildExited {
                        return failure("pi process exited during the scheduled run");
                    }
                },
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return failure("pi process exited during the scheduled run"),
            }
        }
    })();
    session.unsubscribe(subscriber);
    result
}
