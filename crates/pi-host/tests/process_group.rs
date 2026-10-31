#![cfg(target_os = "linux")]

use std::os::unix::fs::PermissionsExt;
use std::time::{Duration, Instant};
use pi_host::{EnvPolicy, PiRpcClient, SpawnOptions};

#[test]
fn kill_live_tree_stops_a_hanging_grandchild_and_never_signals_a_reaped_leader() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("fixture.sh");
    let pidfile = dir.path().join("grandchild.pid");
    std::fs::write(&script, "#!/bin/sh\nsh -c 'sleep 300 & echo $! > \"$1\"; wait' _ \"$FIXTURE_PIDFILE\" &\nwait\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let client = PiRpcClient::spawn(script.to_str().unwrap(), SpawnOptions {
        env: EnvPolicy::inherit().set("FIXTURE_PIDFILE", pidfile.to_str().unwrap()),
        ..SpawnOptions::default()
    }).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let pid: u32 = loop {
        if let Ok(s) = std::fs::read_to_string(&pidfile) {
            if let Ok(pid) = s.trim().parse() { break pid; }
        }
        if Instant::now() >= deadline { client.kill(); panic!("grandchild did not start"); }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(client.kill_live_tree());
    assert!(client.wait_exit(Some(Duration::from_secs(5))));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"));
        if stat.as_ref().map_or(true, |s| s.rsplit_once(") ").is_some_and(|(_, fields)| fields.starts_with('Z'))) { break; }
        assert!(Instant::now() < deadline, "grandchild remained running after group kill");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!client.kill_live_tree(), "must not signal a reaped leader's PID");
}
