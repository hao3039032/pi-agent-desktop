//! Terminal-specific host authorization.
use crate::file_access::AllowedRoots;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Only existing, host-authorized project directories may start a shell.
/// Chat roots and every descendant remain excluded even if separately allowed.
pub fn authorize_cwd(
    roots: &AllowedRoots,
    agent_dir: &Path,
    cwd: &str,
) -> Result<PathBuf, &'static str> {
    if cwd.is_empty() {
        return Err("invalid_args");
    }
    let path = Path::new(cwd);
    if !path.is_absolute() || !roots.is_existing_path_allowed(path) {
        return Err("unauthorized_scope");
    }
    let resolved = std::fs::canonicalize(path).map_err(|_| "unauthorized_scope")?;
    if !resolved.is_dir() {
        return Err("unauthorized_scope");
    }
    for root in [
        crate::session_view::chat_workspace_dir(agent_dir),
        crate::session_view::legacy_chat_workspace_dir(agent_dir),
    ] {
        if let Ok(chat) = std::fs::canonicalize(root) {
            if resolved.starts_with(chat) {
                return Err("unauthorized_scope");
            }
        }
    }
    Ok(resolved)
}

/// Pin the directory and recheck the descriptor's resolved identity before
/// handing it to portable-pty. Subsequent path replacement cannot retarget it.
#[cfg(target_os = "linux")]
pub fn pin_cwd(
    roots: &AllowedRoots,
    agent_dir: &Path,
    cwd: &Path,
) -> Result<std::fs::File, &'static str> {
    use std::os::fd::AsRawFd;
    let (resolved, directory) = roots
        .open_terminal_directory(cwd)
        .ok_or("unauthorized_scope")?;
    let actual = std::fs::canonicalize(format!("/proc/self/fd/{}", directory.as_raw_fd()))
        .map_err(|_| "unauthorized_scope")?;
    if actual != resolved || actual != cwd {
        return Err("unauthorized_scope");
    }
    let actual_text = actual.to_str().ok_or("unauthorized_scope")?;
    authorize_cwd(roots, agent_dir, actual_text)?;
    Ok(directory)
}

const LEASE: Duration = Duration::from_secs(120);
const ACK_TIMEOUT: Duration = Duration::from_secs(15);

struct Relay {
    terminal_id: String,
    stopped: AtomicBool,
    ack: AtomicU64,
    sent: AtomicU64,
}
#[derive(Default)]
struct LeaseState {
    generation: u64,
    deadline: Option<Instant>,
    subscribers: usize,
}

/// Terminal-only relay and lease ownership. At most one unacknowledged frame
/// is in flight per subscriber; retained output stays in the PTY history.
pub struct TerminalStreams {
    host: Arc<pty_host::PtyHost>,
    leases: Arc<Mutex<HashMap<String, LeaseState>>>,
    relays: Arc<Mutex<HashMap<String, Arc<Relay>>>>,
    epoch: u64,
    next_generation: AtomicU64,
}

impl TerminalStreams {
    pub fn new(host: Arc<pty_host::PtyHost>) -> Self {
        let leases = Arc::new(Mutex::new(HashMap::<String, LeaseState>::new()));
        let weak_host = Arc::downgrade(&host);
        let weak_leases = Arc::downgrade(&leases);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let (Some(host), Some(leases)) = (weak_host.upgrade(), weak_leases.upgrade()) else {
                break;
            };
            let mut leases = leases.lock().unwrap();
            leases.retain(|id, lease| {
                if lease.subscribers == 0
                    && lease
                        .deadline
                        .is_some_and(|deadline| Instant::now() >= deadline)
                {
                    host.close(id);
                    false
                } else {
                    true
                }
            });
        });
        Self {
            host,
            leases,
            relays: Arc::new(Mutex::new(HashMap::new())),
            epoch: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            next_generation: AtomicU64::new(1),
        }
    }
    pub fn reuse(&self, id: &str, cwd: &Path) -> Result<bool, String> {
        let mut leases = self.leases.lock().unwrap();
        if !self.host.reuse(id, cwd)? {
            return Ok(false);
        }
        let lease = leases.entry(id.to_string()).or_insert_with(|| LeaseState {
            generation: self.next_generation.fetch_add(1, Ordering::Relaxed),
            ..Default::default()
        });
        if lease.subscribers == 0 {
            lease.deadline = Some(Instant::now() + LEASE);
        }
        Ok(true)
    }
    pub fn create(
        &self,
        id: &str,
        cwd: &Path,
        options: pty_host::PtyOptions,
    ) -> Result<(), String> {
        let mut leases = self.leases.lock().unwrap();
        self.host.create(id, Some(cwd), options)?;
        let lease = leases.entry(id.to_string()).or_insert_with(|| LeaseState {
            generation: self.next_generation.fetch_add(1, Ordering::Relaxed),
            ..Default::default()
        });
        if lease.subscribers == 0 {
            lease.deadline = Some(Instant::now() + LEASE);
        }
        Ok(())
    }
    pub fn close(&self, id: &str) -> bool {
        let relays = self.relays.lock().unwrap();
        for relay in relays.values().filter(|relay| relay.terminal_id == id) {
            relay.stopped.store(true, Ordering::SeqCst);
        }
        let mut leases = self.leases.lock().unwrap();
        leases.remove(id);
        self.host.close(id)
    }
    pub fn ack(&self, id: &str, seq: u64) -> bool {
        let relays = self.relays.lock().unwrap();
        let Some(relay) = relays.get(id) else {
            return false;
        };
        if seq != relay.sent.load(Ordering::SeqCst) || seq == 0 {
            return false;
        }
        relay.ack.fetch_max(seq, Ordering::SeqCst);
        true
    }
    pub fn unsubscribe(&self, id: &str) -> bool {
        let Some(relay) = self.relays.lock().unwrap().get(id).cloned() else {
            return false;
        };
        relay.stopped.store(true, Ordering::SeqCst);
        true
    }
    pub fn subscribe(
        &self,
        id: &str,
        subscription: String,
        cursor: u64,
        send: impl Fn(Value) -> bool + Send + 'static,
    ) -> Result<(), String> {
        let relay = Arc::new(Relay {
            terminal_id: id.to_string(),
            stopped: AtomicBool::new(false),
            ack: AtomicU64::new(0),
            sent: AtomicU64::new(0),
        });
        let terminal;
        let generation;
        {
            let mut relays = self.relays.lock().unwrap();
            if relays.len() >= 64 {
                return Err("too many terminal subscriptions".into());
            }
            let mut leases = self.leases.lock().unwrap();
            terminal = self
                .host
                .get(id)
                .ok_or_else(|| format!("no terminal {id}"))?;
            let lease = leases.entry(id.to_string()).or_insert_with(|| LeaseState {
                generation: self.next_generation.fetch_add(1, Ordering::Relaxed),
                ..Default::default()
            });
            generation = lease.generation;
            if lease.subscribers >= 4 {
                return Err("too many subscribers for terminal".into());
            }
            lease.deadline = None;
            lease.subscribers += 1;
            relays.insert(subscription.clone(), relay.clone());
        }
        let relays = Arc::clone(&self.relays);
        let leases = Arc::clone(&self.leases);
        let id = id.to_string();
        let cleanup_id = id.clone();
        let cleanup_subscription = subscription.clone();
        let epoch = self.epoch;
        let started = std::thread::Builder::new().name(format!("terminal-{subscription}")).spawn(move || {
            let mut cursor = cursor;
            let mut seq = 0;
            let mut first = true;
            let mut heartbeat = Instant::now();
            let mut last_ack = Instant::now();
            let mut disconnected = false;
            loop {
                if relay.stopped.load(Ordering::SeqCst) { break; }
                // Observe EOF before reading history so the last reader write
                // cannot race an empty read followed by a premature exit frame.
                let exit = if terminal.output_closed() { terminal.wait_exit(Duration::ZERO) } else { None };
                let outcome = terminal.read_since(cursor);
                let (next, text, reset) = match outcome {
                    pty_host::ReadOutcome::Suffix { cursor, text } => (cursor, text, false),
                    pty_host::ReadOutcome::Reset { cursor, text } => (cursor, text, true),
                };
                if !first && text.is_empty() && exit.is_none() && heartbeat.elapsed() < Duration::from_secs(15) {
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                seq += 1;
                let payload = if !first && text.is_empty() && exit.is_some() {
                    json!({"kind": "exit", "exitCode": exit.flatten()})
                } else {
                    json!({"kind": if reset { "reset" } else { "suffix" }, "cursor": next, "output": text})
                };
                let is_exit = payload["kind"] == "exit";
                let kind = if first { "snapshot" } else if reset { "reset" } else { "event" };
                relay.sent.store(seq, Ordering::SeqCst);
                if !send(json!({"subscriptionId": subscription, "epoch": epoch, "seq": seq, "kind": kind, "payload": payload})) { disconnected = true; break; }
                let sent = Instant::now();
                while relay.ack.load(Ordering::SeqCst) < seq && !relay.stopped.load(Ordering::SeqCst) && sent.elapsed() < ACK_TIMEOUT {
                    std::thread::sleep(Duration::from_millis(50));
                }
                if relay.stopped.load(Ordering::SeqCst) { break; }
                if relay.ack.load(Ordering::SeqCst) < seq {
                    disconnected = true;
                    let _ = send(json!({"subscriptionId": subscription, "epoch": epoch, "seq": seq + 1, "kind": "reset", "payload": {"kind": "disconnected"}}));
                    break;
                }
                last_ack = Instant::now();
                if is_exit { break; }
                first = false;
                cursor = next;
                heartbeat = Instant::now();
            }
            relays.lock().unwrap().remove(&subscription);
            let mut all = leases.lock().unwrap();
            if let Some(lease) = all.get_mut(&id).filter(|lease| lease.generation == generation) {
                lease.subscribers = lease.subscribers.saturating_sub(1);
                if lease.subscribers == 0 {
                    lease.deadline = Some(if disconnected { last_ack + LEASE } else { Instant::now() + LEASE });
                }
            }
        });
        if let Err(error) = started {
            self.relays.lock().unwrap().remove(&cleanup_subscription);
            if let Some(lease) = self
                .leases
                .lock()
                .unwrap()
                .get_mut(&cleanup_id)
                .filter(|lease| lease.generation == generation)
            {
                lease.subscribers = lease.subscribers.saturating_sub(1);
                if lease.subscribers == 0 {
                    lease.deadline = Some(Instant::now() + LEASE);
                }
            }
            return Err(format!("terminal relay failed: {error}"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn terminal_stream_ack_cancel_and_expiry() {
        use std::sync::mpsc;
        let host = Arc::new(pty_host::PtyHost::new());
        let streams = TerminalStreams::new(host.clone());
        let dir = tempfile::tempdir().unwrap();
        streams
            .create("t", dir.path(), pty_host::PtyOptions::default())
            .unwrap();
        let (tx, rx) = mpsc::channel();
        streams
            .subscribe("t", "sub".into(), 0, move |frame| tx.send(frame).is_ok())
            .unwrap();
        let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(first["kind"], "snapshot");
        let pty = host.get("t").unwrap();
        pty.write_input(b"echo stream-test-marker\n").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "no second frame before ACK"
        );
        assert!(!streams.ack("sub", 2), "future ACK rejected");
        assert!(streams.ack("sub", 1));
        let next = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(next["seq"], 2);
        assert!(streams.unsubscribe("sub"));
        let deadline = Instant::now() + Duration::from_secs(5);
        while streams.relays.lock().unwrap().contains_key("sub") {
            assert!(Instant::now() < deadline, "cancel reaps the relay");
            std::thread::sleep(Duration::from_millis(20));
        }
        streams
            .leases
            .lock()
            .unwrap()
            .get_mut("t")
            .unwrap()
            .deadline = Some(Instant::now());
        while host.get("t").is_some() {
            assert!(Instant::now() < deadline, "expired terminal reaped");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(pty.write_input(b"late\n").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn terminal_unacknowledged_frame_disconnects_and_reaps_relay() {
        use std::sync::mpsc;
        let host = Arc::new(pty_host::PtyHost::new());
        let streams = TerminalStreams::new(host.clone());
        let dir = tempfile::tempdir().unwrap();
        streams
            .create("slow", dir.path(), pty_host::PtyOptions::default())
            .unwrap();
        let (tx, rx) = mpsc::channel();
        streams
            .subscribe("slow", "unacked".into(), 0, move |frame| {
                tx.send(frame).is_ok()
            })
            .unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap()["kind"],
            "snapshot"
        );
        let reset = rx
            .recv_timeout(ACK_TIMEOUT + Duration::from_secs(5))
            .unwrap();
        assert_eq!(reset["kind"], "reset");
        assert_eq!(reset["payload"]["kind"], "disconnected");
        let deadline = Instant::now() + Duration::from_secs(3);
        while streams.relays.lock().unwrap().contains_key("unacked") {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(20));
        }
        let leases = streams.leases.lock().unwrap();
        let remaining = leases["slow"]
            .deadline
            .unwrap()
            .saturating_duration_since(Instant::now());
        assert!(
            remaining < LEASE - Duration::from_secs(10),
            "lease begins from the last ACK"
        );
        drop(leases);
        streams.close("slow");
    }

    #[cfg(unix)]
    #[test]
    fn terminal_stream_replays_reset_then_reports_exit_code() {
        use std::sync::mpsc;
        let host = Arc::new(pty_host::PtyHost::new());
        let streams = TerminalStreams::new(host.clone());
        let dir = tempfile::tempdir().unwrap();
        streams
            .create("reset", dir.path(), pty_host::PtyOptions::default())
            .unwrap();
        let pty = host.get("reset").unwrap();
        pty.write_input(b"printf '%0135000d' 0\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while pty.cursor() <= pty_host::HISTORY_LIMIT_UNITS as u64 {
            assert!(Instant::now() < deadline, "large output arrives");
            std::thread::sleep(Duration::from_millis(10));
        }
        let (tx, rx) = mpsc::channel();
        streams
            .subscribe("reset", "replay".into(), 0, move |frame| {
                tx.send(frame).is_ok()
            })
            .unwrap();
        let frame = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(frame["kind"], "snapshot");
        assert_eq!(frame["payload"]["kind"], "reset");
        assert!(
            frame["payload"]["output"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .count()
                <= pty_host::HISTORY_LIMIT_UNITS
        );
        assert!(streams.ack("replay", 1));
        pty.write_input(b"exit 7\n").unwrap();
        loop {
            let frame = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            let seq = frame["seq"].as_u64().unwrap();
            assert!(streams.ack("replay", seq));
            if frame["payload"]["kind"] == "exit" {
                assert_eq!(frame["payload"]["exitCode"], 7);
                break;
            }
        }
        streams.close("reset");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn terminal_pinned_directory_survives_parent_swap_without_fd_leak() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let agent = dir.path().join("agent");
        let parent = dir.path().join("project");
        let cwd = parent.join("work");
        let moved = dir.path().join("moved");
        let chat = agent.join("chats/folder");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(chat.join("work")).unwrap();
        std::fs::write(cwd.join("marker"), "SAFE_PROJECT_MARKER\n").unwrap();
        std::fs::write(chat.join("work/marker"), "CHAT_MARKER\n").unwrap();
        let mut roots = AllowedRoots::new();
        roots.add(dir.path());
        let authorized = authorize_cwd(&roots, &agent, cwd.to_str().unwrap()).unwrap();
        let normal_handle = pin_cwd(&roots, &agent, &authorized).unwrap();
        let normal_host = pty_host::PtyHost::new();
        let normal = normal_host
            .create(
                "normal",
                Some(&authorized),
                pty_host::PtyOptions {
                    cwd_handle: Some(normal_handle),
                    ..Default::default()
                },
            )
            .unwrap();
        normal
            .write_input(b"pwd -P; printf '<%s>\\n' \"$PWD\"; exit 0\n")
            .unwrap();
        assert_eq!(normal.wait_exit(Duration::from_secs(10)), Some(Some(0)));
        let until = Instant::now() + Duration::from_secs(5);
        while !normal.output_closed() {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(10));
        }
        let normal_output = match normal.read_since(0) {
            pty_host::ReadOutcome::Suffix { text, .. }
            | pty_host::ReadOutcome::Reset { text, .. } => text,
        };
        assert!(
            normal_output.contains(&format!("<{}>", authorized.display())),
            "{normal_output:?}"
        );
        normal_host.close("normal");
        // A swap before opening the anchor is refused.
        std::fs::rename(&parent, &moved).unwrap();
        symlink(&chat, &parent).unwrap();
        assert!(pin_cwd(&roots, &agent, &authorized).is_err());
        std::fs::remove_file(&parent).unwrap();
        std::fs::rename(&moved, &parent).unwrap();
        // A swap after pinning cannot retarget the child.
        let handle = pin_cwd(&roots, &agent, &authorized).unwrap();
        std::fs::rename(&parent, &moved).unwrap();
        symlink(&chat, &parent).unwrap();
        let host = pty_host::PtyHost::new();
        let pty = host
            .create(
                "pinned",
                Some(&authorized),
                pty_host::PtyOptions {
                    cwd_handle: Some(handle),
                    ..Default::default()
                },
            )
            .unwrap();
        pty.write_input(
            b"pwd -P; cat marker; for f in /proc/$$/fd/*; do readlink \"$f\"; done; exit 0\n",
        )
        .unwrap();
        assert_eq!(pty.wait_exit(Duration::from_secs(10)), Some(Some(0)));
        let until = Instant::now() + Duration::from_secs(5);
        while !pty.output_closed() {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = match pty.read_since(0) {
            pty_host::ReadOutcome::Suffix { text, .. }
            | pty_host::ReadOutcome::Reset { text, .. } => text,
        };
        assert!(output.contains("SAFE_PROJECT_MARKER"), "{output:?}");
        assert!(!output.contains("CHAT_MARKER"), "{output:?}");
        assert!(
            output.contains(&moved.join("work").display().to_string()),
            "{output:?}"
        );
        // Only pwd prints this directory: no inherited fd points back at it.
        assert_eq!(
            output
                .matches(&moved.join("work").display().to_string())
                .count(),
            1,
            "{output:?}"
        );
        host.close("pinned");
    }

    #[test]
    fn authorized_projects_only_not_chat_descendants_or_symlink_aliases() {
        let dir = tempfile::tempdir().unwrap();
        let agent = dir.path().join("agent");
        let project = dir.path().join("project");
        let chat = agent.join("chats/folder/nested");
        let legacy = agent.join("chat-workspace/nested");
        for path in [&project, &chat, &legacy] {
            std::fs::create_dir_all(path).unwrap();
        }
        let mut roots = AllowedRoots::new();
        roots.add(dir.path());
        assert!(authorize_cwd(&roots, &agent, project.to_str().unwrap()).is_ok());
        for path in [agent.join("chats"), chat, legacy] {
            assert_eq!(
                authorize_cwd(&roots, &agent, path.to_str().unwrap()),
                Err("unauthorized_scope")
            );
        }
        assert_eq!(authorize_cwd(&roots, &agent, ""), Err("invalid_args"));
        assert_eq!(
            authorize_cwd(&roots, &agent, "/"),
            Err("unauthorized_scope")
        );
        #[cfg(unix)]
        {
            let alias = project.join("alias");
            std::os::unix::fs::symlink(agent.join("chats"), &alias).unwrap();
            assert_eq!(
                authorize_cwd(&roots, &agent, alias.to_str().unwrap()),
                Err("unauthorized_scope")
            );
        }
    }
}
