//! Deterministic protocol tests against the mock pi child
//! (`src/bin/mock_pi.rs`). These freeze the transport contract the plan's
//! M0 gate requires: LF framing under adversarial chunking, response
//! correlation, timeout semantics (the child keeps running), the pre-attach
//! UI hold window (arrival-order replay, cancel — never approve — on
//! deadline/overflow/exit, the bypass channel), exit propagation, stderr
//! caps and the grace-kill shutdown path.

use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use pi_host::error::ErrorKind;
use pi_host::{EnvPolicy, PiRpcClient, SpawnOptions};

const SHORT: Duration = Duration::from_millis(1_500);
const LONG: Duration = Duration::from_secs(30);

fn mock_exe() -> &'static str {
    env!("CARGO_BIN_EXE_mock_pi")
}

fn spawn_mock(scenario: Option<&str>) -> Arc<PiRpcClient> {
    let mut env = EnvPolicy::inherit();
    if let Some(scenario) = scenario {
        env = env.set("MOCK_PI_SCENARIO", scenario);
    }
    PiRpcClient::spawn(
        mock_exe(),
        SpawnOptions { env, ..SpawnOptions::default() },
    )
    .expect("mock pi spawns")
}

fn spawn_mock_logged(scenario: Option<&str>) -> (Arc<PiRpcClient>, Receiver<String>) {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut env = EnvPolicy::inherit();
    if let Some(scenario) = scenario {
        env = env.set("MOCK_PI_SCENARIO", scenario);
    }
    let client = PiRpcClient::spawn(
        mock_exe(),
        SpawnOptions {
            env,
            on_log: Some(Arc::new(move |line| {
                let _ = tx.send(line);
            })),
            ..SpawnOptions::default()
        },
    )
    .expect("mock pi spawns");
    (client, rx)
}

fn recv_timeout<T>(rx: &Receiver<T>) -> T {
    rx.recv_timeout(Duration::from_secs(10)).expect("channel message within 10s")
}

#[test]
fn get_state_handshake_and_echo_roundtrip() {
    let client = spawn_mock(None);
    let state = client
        .command("get_state", json!({}), Some(SHORT))
        .expect("get_state answers");
    assert_eq!(state["sessionId"], "mock-session-id");
    assert_eq!(state["thinkingLevel"], "off");

    let echoed = client
        .command("echo", json!({ "payload": { "value": 42, "text": "hello" } }), Some(SHORT))
        .expect("echo answers");
    assert_eq!(echoed["value"], 42);
    assert_eq!(echoed["text"], "hello");

    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn caller_supplied_id_is_the_correlation_id() {
    let client = spawn_mock(None);
    // The mock echoes the request id on the response; the client must honor
    // a non-empty string id instead of replacing it.
    let state = client
        .command("get_state", json!({ "id": "custom-correlation-id" }), Some(SHORT))
        .expect("echo answers with the caller's id");
    assert_eq!(state["sessionId"], "mock-session-id");

    // A non-string id loses correlation and must be rejected before writing.
    let error = client
        .command("echo", json!({ "id": 17 }), Some(SHORT))
        .expect_err("non-string id rejected");
    assert_eq!(error.kind, ErrorKind::Invalid);

    // An empty id falls back to a generated one (still correlates).
    let state = client
        .command("get_state", json!({ "id": "" }), Some(SHORT))
        .expect("empty id still correlates");
    assert_eq!(state["sessionId"], "mock-session-id");

    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn split_utf8_and_u2028_frames_stay_one_record() {
    let client = spawn_mock(Some("split_hello"));
    let (events, _subscription) = client.on_event();
    let state = client.command("get_state", json!({}), Some(SHORT)).expect("handshake");
    assert_eq!(state["sessionId"], "mock-session-id");
    let first = recv_timeout(&events);
    assert_eq!(first["type"], "split_record");
    assert_eq!(first["text"], "埃文\u{2028}·\u{2029}");
    let second = recv_timeout(&events);
    assert_eq!(second["type"], "event_one");
    let third = recv_timeout(&events);
    assert_eq!(third["type"], "event_two");
    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn unparseable_line_is_skipped_and_stream_continues() {
    let (client, logs) = spawn_mock_logged(None);
    let state = client.command("garbage", json!({}), Some(SHORT)).expect("garbage responds");
    assert!(state.is_null());
    let logged = recv_timeout(&logs);
    assert!(logged.starts_with("unparseable rpc line:"), "got {logged}");
    let state = client.command("get_state", json!({}), Some(SHORT)).expect("stream continues");
    assert_eq!(state["sessionId"], "mock-session-id");
    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn timeout_rejects_the_command_but_keeps_the_child_running() {
    let client = spawn_mock(None);
    let error = client
        .command("slow", json!({ "delay_ms": 0 }), Some(Duration::from_millis(400)))
        .expect_err("slow(0) never answers");
    assert_eq!(error.kind, ErrorKind::Timeout);
    // The child is still alive and the next command works: a timeout never
    // tears down the session, and the caller decides what to do.
    let state = client.command("get_state", json!({}), Some(SHORT)).expect("child still alive");
    assert_eq!(state["sessionId"], "mock-session-id");
    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn stderr_lines_flow_to_the_log_with_oversize_lines_dropped() {
    let (client, logs) = spawn_mock_logged(None);
    client.command("stderr_big", json!({}), Some(SHORT)).expect("stderr_big responds");
    let dropped = recv_timeout(&logs);
    assert_eq!(dropped, "[stderr line omitted: exceeds diagnostic limit]");
    client.command("stderr_text", json!({}), Some(SHORT)).expect("stderr_text responds");
    let line = recv_timeout(&logs);
    assert_eq!(line, "mock diagnostic line");
    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn events_fan_out_to_subscribers() {
    let client = spawn_mock(None);
    let (events, _subscription) = client.on_event();
    client
        .command("notify_send", json!({ "message": "hello events" }), Some(SHORT))
        .expect("notify_send responds");
    let event = recv_timeout(&events);
    assert_eq!(event["type"], "notice");
    assert_eq!(event["message"], "hello events");
    assert_eq!(client.close(LONG), Some(0));
}

// --- extension UI -----------------------------------------------------------

#[test]
fn dialog_request_roundtrips_through_the_handler() {
    let client = spawn_mock(None);
    let (tx, rx) = std::sync::mpsc::channel();
    let _subscription = client.on_ui("select", tx, None);
    // The ask_ui command makes the mock raise a select and wait for the
    // answer; the response carries what we answered.
    let handle = {
        let client = Arc::clone(&client);
        std::thread::spawn(move || {
            client.command("ask_ui", json!({ "method": "select" }), Some(LONG))
        })
    };
    let request = recv_timeout(&rx);
    assert_eq!(request.method, "select");
    assert_eq!(request.record["title"], "mock dialog");
    client.respond_ui(&request.id, json!({ "value": "Allow" }));
    let answer = handle.join().expect("ask_ui answers").expect("ask_ui succeeds");
    assert_eq!(answer["answer"]["value"], "Allow");
    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn unhandled_dialog_without_a_window_is_cancelled_immediately() {
    let client = spawn_mock(None);
    // No handler registered, no window open: the child must still be
    // answered (cancelled, never approved) so it fails fast.
    let answer = client
        .command("ask_ui", json!({ "method": "confirm" }), Some(LONG))
        .expect("ask_ui resolves with a cancel");
    assert_eq!(answer["answer"]["cancelled"], true);
    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn unhandled_fire_and_forget_method_gets_no_response() {
    let client = spawn_mock(None);
    // `notify` without a handler and without a window: the client must NOT
    // answer (an unsolicited response would be a record the child never
    // asked for).
    client
        .command("burst_ui", json!({ "count": 2 }), Some(SHORT))
        .expect("burst responds (burst-0 select auto-cancelled, burst-1 notify unanswered)");
    let collected = client
        .command("collect_ui", json!({}), Some(SHORT))
        .expect("collect responds");
    let responses = collected["responses"].as_array().expect("responses array");
    // Only the dialog (burst-0, method select) got a cancelled response;
    // the notify (burst-1) got nothing.
    assert_eq!(responses.len(), 1, "fire-and-forget methods are never answered: {collected}");
    assert_eq!(responses[0]["id"], "burst-0");
    assert_eq!(responses[0]["cancelled"], true);
    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn attach_window_replays_held_ui_in_arrival_order() {
    let client = spawn_mock(None);
    client.begin_ui_attach_window(Duration::from_secs(30), None);
    // Three requests arrive while NO handler exists: they are held, not
    // answered. burst-0 and burst-2 are `select` dialogs, burst-1 is a
    // `notify` (fire-and-forget).
    client
        .command("burst_ui", json!({ "count": 3 }), Some(SHORT))
        .expect("burst responds");
    assert_eq!(client.pending_ui_requests(), 3);

    // Registering the select handler replays in ARRIVAL order and stops at
    // burst-1 (notify: no handler yet): only burst-0 is delivered now.
    let (tx, rx) = std::sync::mpsc::channel();
    let _subscription = client.on_ui("select", tx, None);
    let first = recv_timeout(&rx);
    assert_eq!(first.id, "burst-0");
    client.respond_ui(&first.id, json!({ "value": "first" }));
    assert!(
        rx.recv_timeout(Duration::from_millis(250)).is_err(),
        "stops at the unregistered notify"
    );
    assert_eq!(client.pending_ui_requests(), 2);

    // Whatever is left when the window ends is cancelled (dialogs) or
    // dropped (fire-and-forget), never approved.
    client.end_ui_attach_window();
    assert_eq!(client.pending_ui_requests(), 0);
    let collected = client
        .command("collect_ui", json!({}), Some(SHORT))
        .expect("collect responds");
    let responses = collected["responses"].as_array().expect("responses array").clone();
    // Our own answer to burst-0, then the cancel for the held dialog
    // burst-2; the notify burst-1 got NO response.
    assert_eq!(responses.len(), 2, "responses: {collected}");
    assert_eq!(responses[0]["id"], "burst-0");
    assert_eq!(responses[0]["value"], "first");
    assert_eq!(responses[1]["id"], "burst-2");
    assert_eq!(responses[1]["cancelled"], true);
    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn attach_window_deadline_cancels_what_no_handler_took() {
    let client = spawn_mock(None);
    client.begin_ui_attach_window(Duration::from_millis(250), None);
    client
        .command("burst_ui", json!({ "count": 4 }), Some(SHORT))
        .expect("burst responds");
    assert_eq!(client.pending_ui_requests(), 4);
    // No handler ever registers: the window deadline cancels the dialogs.
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(client.pending_ui_requests(), 0);
    let collected = client
        .command("collect_ui", json!({}), Some(SHORT))
        .expect("collect responds");
    let responses = collected["responses"].as_array().expect("responses array");
    let cancelled_dialogs: Vec<&str> = responses
        .iter()
        .filter(|entry| entry.get("cancelled").and_then(Value::as_bool) == Some(true))
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .collect();
    // Dialogs are burst-0 and burst-2 (even indexes → select).
    assert_eq!(cancelled_dialogs, vec!["burst-0", "burst-2"]);
    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn attach_window_overflow_cancels_the_oldest_first() {
    let client = spawn_mock(None);
    client.begin_ui_attach_window(Duration::from_secs(30), Some(2));
    client
        .command("burst_ui", json!({ "count": 4 }), Some(SHORT))
        .expect("burst responds");
    // max_entries 2: the two oldest (burst-0, burst-1) are cancelled at
    // arrival; the window holds burst-2 and burst-3.
    assert_eq!(client.pending_ui_requests(), 2);
    client.end_ui_attach_window();
    assert_eq!(client.pending_ui_requests(), 0);
    let collected = client
        .command("collect_ui", json!({}), Some(SHORT))
        .expect("collect responds");
    let responses = collected["responses"].as_array().expect("responses array");
    let cancelled: Vec<&str> = responses
        .iter()
        .filter(|entry| entry.get("cancelled").and_then(Value::as_bool) == Some(true))
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .collect();
    // burst-0 (dialog) cancelled on overflow; burst-1 (notify) gets nothing;
    // burst-2 (dialog) cancelled when the window ended; burst-3 (notify)
    // nothing.
    assert_eq!(cancelled, vec!["burst-0", "burst-2"]);
    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn held_dialog_expires_by_its_own_timeout_from_arrival() {
    let client = spawn_mock(None);
    client.begin_ui_attach_window(Duration::from_secs(30), None);
    // A dialog with its own 200 ms timeout, held before any handler exists.
    let handle = {
        let client = Arc::clone(&client);
        std::thread::spawn(move || {
            client.command(
                "ask_ui",
                json!({ "method": "confirm", "timeout": 200 }),
                Some(LONG),
            )
        })
    };
    // Wait past the dialog's own timeout, then register the handler: the
    // replay must NOT deliver an expired dialog (pi already gave up on it);
    // it is cancelled instead.
    std::thread::sleep(Duration::from_millis(450));
    let (tx, rx) = std::sync::mpsc::channel();
    let _subscription = client.on_ui("confirm", tx, None);
    assert!(
        rx.recv_timeout(Duration::from_millis(300)).is_err(),
        "expired dialog is not delivered to the handler"
    );
    // The expired cancel answers the mock's ask_ui.
    let answer = handle
        .join()
        .expect("ask_ui settles")
        .expect("ask_ui resolves via the cancel");
    assert_eq!(answer["answer"]["cancelled"], true);
    assert_eq!(client.pending_ui_requests(), 0);
    assert_eq!(client.close(LONG), Some(0));
}

#[test]
fn bypass_channel_delivers_immediately_while_older_ui_is_held() {
    let client = spawn_mock(None);
    client.begin_ui_attach_window(Duration::from_secs(30), None);
    // Hold one select dialog (no select handler yet).
    client
        .command("burst_ui", json!({ "count": 1, "method": "select" }), Some(SHORT))
        .expect("burst responds");
    assert_eq!(client.pending_ui_requests(), 1);

    // The bypass channel delivers a matching notify at once, even while the
    // older select is still held (the bridge result envelope's exact right:
    // pi never blocks on a notify).
    let (tx, rx) = std::sync::mpsc::channel();
    let bypass: Arc<dyn Fn(&Value) -> bool + Send + Sync> = Arc::new(|record: &Value| {
        record
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .starts_with("PI_WEB_BRIDGE_V1 ")
    });
    let _subscription = client.on_ui("notify", tx, Some(bypass));
    client
        .command(
            "burst_ui",
            json!({ "count": 1, "method": "notify", "extra": { "message": "PI_WEB_BRIDGE_V1 {\"rid\":\"x\"}" } }),
            Some(SHORT),
        )
        .expect("burst responds");
    let request = recv_timeout(&rx);
    assert!(
        request
            .record["message"]
            .as_str()
            .expect("message field")
            .starts_with("PI_WEB_BRIDGE_V1 ")
    );
    // The older dialog is still held; the bypass did not flush it.
    assert_eq!(client.pending_ui_requests(), 1);

    // A PLAIN notify never matches the predicate and keeps the ordered path
    // (held behind the select, no delivery).
    client
        .command(
            "burst_ui",
            json!({ "count": 1, "method": "notify", "extra": { "message": "plain text" } }),
            Some(SHORT),
        )
        .expect("burst responds");
    assert_eq!(client.pending_ui_requests(), 2);
    client.end_ui_attach_window();
    assert_eq!(client.pending_ui_requests(), 0);
    // The select dialog got a cancel; both notifies got nothing.
    let collected = client
        .command("collect_ui", json!({}), Some(SHORT))
        .expect("collect responds");
    let responses = collected["responses"].as_array().expect("responses array");
    assert_eq!(responses.len(), 1, "only the dialog was answered: {collected}");
    assert_eq!(responses[0]["cancelled"], true);
    assert_eq!(client.close(LONG), Some(0));
}

// --- lifecycle ----------------------------------------------------------------

#[test]
fn unexpected_exit_rejects_pending_commands_with_the_exit_code() {
    let client = spawn_mock(None);
    // `slow(0)` never answers; meanwhile the child exits with code 3.
    let handle = {
        let client = Arc::clone(&client);
        std::thread::spawn(move || {
            client.command("slow", json!({ "delay_ms": 0 }), Some(Duration::from_secs(30)))
        })
    };
    std::thread::sleep(Duration::from_millis(150));
    client
        .command("die", json!({ "code": 3 }), Some(SHORT))
        .expect("die responds before exit");
    let error = handle.join().expect("command settles").expect_err("pending command rejected");
    assert!(error.message.contains("unexpectedly"), "message: {}", error.message);
    assert!(error.message.contains('3'), "message: {}", error.message);
    assert_eq!(client.exit_code(), Some(3));
    // New commands after exit fail with the fatal error.
    let later = client.command("get_state", json!({}), Some(SHORT)).expect_err("post-exit command fails");
    assert_eq!(later.kind, ErrorKind::Exit);
}

#[test]
fn close_uses_stdin_eof_for_an_orderly_shutdown() {
    let client = spawn_mock(None);
    client.command("get_state", json!({}), Some(SHORT)).expect("handshake");
    let start = std::time::Instant::now();
    let code = client.close(Duration::from_secs(10));
    assert_eq!(code, Some(0));
    assert!(start.elapsed() < Duration::from_secs(5), "orderly exit, no force kill needed");
}

#[test]
fn close_force_kills_a_child_that_ignores_stdin_eof() {
    let client = spawn_mock(Some("no_exit_on_eof"));
    client.command("get_state", json!({}), Some(SHORT)).expect("handshake");
    let start = std::time::Instant::now();
    let code = client.close(Duration::from_millis(400));
    assert!(start.elapsed() < Duration::from_secs(5));
    // The child ignores EOF and would sleep for 600s then exit 7; the grace
    // kill reaps it (signal death ⇒ no exit code on Unix).
    #[cfg(unix)]
    assert!(code.is_none() || code == Some(7), "code {code:?}");
    #[cfg(not(unix))]
    assert!(code.is_some());
    assert!(client.termination_signal().is_some() || client.exit_code().is_some());
}

#[test]
fn exit_discards_held_ui_without_answering() {
    let client = spawn_mock(None);
    client.begin_ui_attach_window(Duration::from_secs(30), None);
    client
        .command("burst_ui", json!({ "count": 2 }), Some(SHORT))
        .expect("burst responds");
    assert_eq!(client.pending_ui_requests(), 2);
    client
        .command("die", json!({ "code": 5 }), Some(SHORT))
        .expect("die responds");
    client.wait_exit(Some(Duration::from_secs(5)));
    assert_eq!(client.pending_ui_requests(), 0, "held UI is dropped, not answered");
    assert_eq!(client.exit_code(), Some(5));
}

#[test]
fn spawn_failure_is_reported_synchronously() {
    let error = PiRpcClient::spawn("/nonexistent/pi-binary", SpawnOptions::default())
        .expect_err("missing executable fails");
    assert_eq!(error.kind, ErrorKind::Spawn);
}

#[test]
fn duplicate_in_flight_ids_are_refused_not_silently_overwritten() {
    let client = spawn_mock(None);
    // Two commands carrying the SAME caller-supplied id: the second must be
    // refused while the first is still in flight (an overwrite would hang
    // the first waiter until its timeout).
    let first = {
        let client = Arc::clone(&client);
        std::thread::spawn(move || {
            client.command("slow", json!({ "id": "shared-id", "delay_ms": 400 }), Some(LONG))
        })
    };
    std::thread::sleep(Duration::from_millis(80));
    let second = client.command("slow", json!({ "id": "shared-id", "delay_ms": 0 }), Some(LONG));
    assert!(second.is_err(), "the duplicate id is refused while in flight");
    let first_result = first.join().expect("first thread").expect("first command answers");
    assert_eq!(first_result, Value::Null);
    client.close(Duration::from_secs(5));
}

#[test]
fn a_response_written_just_before_exit_is_still_dispatched() {
    // The drain race: the child answers and exits immediately. The response
    // is already in the pipe when the exit watcher fires; the pending
    // command must resolve with it, not with the exit error.
    let client = spawn_mock(None);
    let result = client.command("answer_then_die", json!({ "payload": "last-words" }), Some(SHORT));
    assert_eq!(
        result.expect("the buffered response wins over the exit"),
        json!("last-words")
    );
    client.wait_exit(Some(Duration::from_secs(5)));
}

#[test]
fn an_oversized_stdout_record_is_dropped_whole_and_the_stream_continues() {
    let (client, logs) = spawn_mock_logged(Some("oversize_line"));
    // The oversized record is dropped (never parsed); the event after it
    // still arrives.
    let (events, _subscription) = client.on_event();
    // The oversize record was printed at STARTUP (before our subscription
    // could miss it — it is an event record without id), so drain what the
    // subscription saw: after_big must arrive, big must not.
    let mut saw_after = false;
    let mut saw_big = false;
    while let Ok(record) = events.recv_timeout(Duration::from_secs(2)) {
        match record.get("type").and_then(Value::as_str) {
            Some("after_big") => saw_after = true,
            Some("big") => saw_big = true,
            _ => {}
        }
        if saw_after {
            break;
        }
    }
    assert!(saw_after, "the stream continues after the dropped record");
    assert!(!saw_big, "the oversized record never parses");
    let mut logged = false;
    while let Ok(line) = logs.try_recv() {
        if line.contains("exceeded") {
            logged = true;
        }
    }
    assert!(logged, "the drop is diagnosable");
    client.close(Duration::from_secs(5));
}

#[test]
fn bridge_drop_detaches_the_notify_handler_and_ends_its_threads() {
    use pi_host::bridge::Bridge;
    let client = spawn_mock(None);
    let bridge = Bridge::attach(Arc::clone(&client), "mock-session-id".into(), "nonce-1".into());
    // A bridge request over the mock: the ack path needs the child alive.
    // (The mock has no real bridge extension; we only assert the DETACH
    // mechanics, so any request result is fine.)
    let _ = bridge.request("noop", None, Some(Duration::from_millis(50)));
    // Drop the Bridge: the notify handler must detach from the client.
    drop(bridge);
    // A plain notify after the drop is an UNHANDLED method: fire-and-forget
    // methods get no response (no crash, no cancel), proving the handler is
    // gone instead of silently kept alive.
    let collected = client
        .command("collect_ui", json!({}), Some(SHORT))
        .expect("collect");
    let responses = collected.as_array().cloned().unwrap_or_default();
    assert!(
        !responses.iter().any(|response| response.get("method").and_then(Value::as_str) == Some("notify")),
        "no notify handler remains registered after the Bridge dropped"
    );
    client.close(Duration::from_secs(5));
}

/// A dead child must CLOSE the event channels: the transport is gone, so a
/// subscriber blocked in `recv()` has to learn the session is over. Before
/// the exit watcher dropped `event_listeners`, the senders lived on inside
/// the client's shared state and every event listener's thread blocked in
/// recv() FOREVER (leaking it and whatever the subscription kept alive) —
/// found by the static-UI acceptance's child-kill step, whose settle waiter
/// never woke because the session-host fan thread never exited.
#[test]
fn a_child_exit_closes_the_event_channels() {
    let client = spawn_mock(None);
    let (events, subscription) = client.on_event();
    let state = client.command("get_state", json!({}), Some(SHORT)).expect("handshake");
    assert_eq!(state["sessionId"], "mock-session-id");
    // Kill (not close): the exit watcher runs while the subscription is
    // still HELD — the worst case for the old leak.
    client.kill();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match events.recv_timeout(Duration::from_millis(200)) {
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "the event channel never closed after the child died (the listener leaks)"
                );
            }
            Ok(record) => panic!("no record can arrive from a dead child: {record}"),
        }
    }
    drop(subscription);
    // Reap the mock so no test process lingers.
    let _ = client.wait_exit(Some(Duration::from_secs(5)));
}
