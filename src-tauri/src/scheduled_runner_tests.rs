//! Regression against a live fake pi child; no provider or user data.
use super::*;
use std::sync::Arc;
use base64::Engine as _;

#[test]
fn rejected_before_start_can_resolve_after_ledger_write() {
    let dir = tempfile::tempdir().unwrap();
    let task_id = "12345678-1234-1234-1234-123456789abc";
    let repo = TaskRepository::new(dir.path());
    repo.mutate(|tasks| { tasks.push(json!({"id":task_id,"name":"fixture","enabled":true,"cwd":"/unused","prompt":"fixture","schedule":{"kind":"manual"}})); Ok(()) }).unwrap();
    repo.mutate_runs(task_id, |runs| { runs.push(json!({"runId":"before-start","taskId":task_id,"status":"running","trigger":"manual"})); Ok(()) }).unwrap();
    let tracker = Arc::new(crate::scheduled_lifecycle::ScheduledLifecycle::default());
    let mut guard = tracker.admit("before-start").unwrap();
    guard.claimed();
    finish_tracked_run(dir.path(), task_id, "before-start", failure("invalid preset"), &mut guard).unwrap();
    drop(guard);
    assert!(tracker.snapshot().unwrap().is_empty());
}

#[test]
fn lost_prompt_ack_does_not_release_lease_after_failed_abort_and_ledger_write() {
    check_prompt_outcome("lost");
}

#[test]
fn uncorrelated_success_does_not_release_lease_after_ledger_write() {
    check_prompt_outcome("settled");
}

#[test]
fn queued_and_handled_prompts_remain_unknown() {
    check_prompt_outcome("queued");
    check_prompt_outcome("handled");
}

fn check_prompt_outcome(mode: &str) {
    let Ok(executable) = std::env::var("SCHEDULER_MOCK_PI") else { eprintln!("skipping: SCHEDULER_MOCK_PI not set"); return };
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let state = Arc::new(IpcHostState::new());
    *state.task_agent_dir.lock().unwrap() = Some(dir.path().to_path_buf());
    let (file, id) = session_host::create_session_file(&dir.path().join("sessions"), &cwd).unwrap();
    let bridge = std::path::Path::new("../lib/pi-rpc/assets/pi-web-bridge.mjs").canonicalize().unwrap();
    let commands = base64::engine::general_purpose::STANDARD.encode(json!({"commands":[{"name":"pi-web:bridge","source":"extension","sourceInfo":{"path":bridge}}]}).to_string());
    let abort_log = dir.path().join("abort.log");
    let mut extra_args = vec!["--mock-session-id".into(), id.clone(), "--mock-commands".into(), commands, "--mock-abort-log".into(), abort_log.to_string_lossy().into_owned()];
    match mode {
        "lost" => extra_args.push("--mock-prompt-drop-ack".into()),
        "settled" => {
            let events = json!([{ "type": "message_end", "message": { "role": "assistant", "stopReason": "stop" } }, { "type": "agent_settled" }]);
            extra_args.extend(["--mock-prompt-events".into(), base64::engine::general_purpose::STANDARD.encode(events.to_string())]);
        },
        "queued" | "handled" => extra_args.extend(["--mock-prompt-disposition".into(), mode.into()]),
        _ => panic!("unknown fixture mode"),
    }
    let config = session_host::SessionSpawnConfig {
        executable, agent_dir: Some(dir.path().to_path_buf()), session_dir: None,
        bridge_asset: bridge, artifacts_asset: None, chat_asset: None, chat_asset_sha256: None,
        shape: session_host::SessionSpawnShape::Project { tool_args: None }, initial_model: None,
        thinking_level: None, extra_args,
    };
    struct Cleanup(Arc<Session>);
    impl Drop for Cleanup { fn drop(&mut self) { self.0.shutdown(Duration::ZERO); } }
    let child = Cleanup(state.registry.start(&id, &file, &id, &cwd, &config).unwrap());
    let task_id = "12345678-1234-1234-1234-123456789abc";
    let repo = TaskRepository::new(dir.path());
    repo.mutate(|tasks| { tasks.push(json!({"id":task_id,"name":"fixture","enabled":true,"cwd":cwd,"prompt":"fixture","schedule":{"kind":"manual"}})); Ok(()) }).unwrap();
    repo.mutate_runs(task_id, |runs| { runs.push(json!({"runId":"run-1","taskId":task_id,"status":"running","trigger":"manual"})); Ok(()) }).unwrap();
    state.start_scheduler().unwrap();
    let lock = dir.path().join("scheduled-tasks/scheduler.lock");
    let ready = Instant::now() + Duration::from_secs(3);
    while !state.scheduler_owner.load(std::sync::atomic::Ordering::SeqCst) { assert!(Instant::now() < ready); std::thread::sleep(Duration::from_millis(5)); }
    let mut tracking = state.scheduled_lifecycle.admit("run-1").unwrap();
    tracking.claimed();
    tracking.set_session(&id).unwrap();
    let marker = json!({"version":1,"taskId":task_id,"runId":"run-1","taskName":"fixture","trigger":"manual"});
    // In lost-ACK mode the fake consumes the prompt, drops its ACK and
    // rejects abort while continuing to serve get_state.
    let outcome = run_session_with_timeouts(&child.0, marker, "hello", Duration::from_secs(1), |_| Ok(()), || {}, Duration::from_millis(60), Duration::from_millis(200));
    assert_eq!(outcome.prompt_result, if mode == "settled" { PromptResult::Uncorrelated } else { PromptResult::Unknown });
    assert_eq!(outcome.controlled_writer, ControlledWriter::Unconfirmed);
    if mode == "lost" { assert_eq!(std::fs::read_to_string(&abort_log).unwrap(), "abort rejected"); }
    assert!(child.0.command("get_state", json!({}), Some(Duration::from_secs(1))).is_ok());
    finish_tracked_run(dir.path(), task_id, "run-1", outcome, &mut tracking).unwrap();
    assert_eq!(repo.runs(task_id).unwrap()[0]["status"], if mode == "settled" { "succeeded" } else { "failed" });
    drop(tracking);
    state.stop_scheduler();
    assert!(lock.exists(), "failed UI history is not proof that the writer stopped");
    let report = state.shutdown_scheduler_until(Instant::now() + Duration::from_millis(80));
    assert!(!report.stopped, "{report:?}");
    let expected_prompt = if mode == "settled" { "prompt=Uncorrelated" } else { "prompt=Unknown" };
    assert!(report.active_unknown.iter().any(|item| item.contains("run-1") && item.contains("ledger=written") && item.contains(expected_prompt) && item.contains("writer=Unconfirmed")), "{report:?}");
}
