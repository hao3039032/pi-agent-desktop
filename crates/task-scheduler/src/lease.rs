//! Scheduler lease compatible with `lib/scheduled-tasks/lease.ts`.
//! The transaction gate covers the read/replace and owner-checked release.

use crate::transaction_lock::TransactionLock;
use serde_json::{json, Value};
use std::path::Path;

pub fn acquire<F: Fn(u32) -> bool>(agent_dir: &Path, pid: u32, now_ms: i64, alive: F) -> Result<bool, String> {
    let _guard = TransactionLock::acquire(agent_dir).map_err(|e| e.to_string())?;
    let path = agent_dir.join("scheduled-tasks/scheduler.lock");
    let current = read(&path)?;
    let previous_pid = current.as_ref().and_then(|v| v.get("pid")).and_then(Value::as_u64);
    if let (Some(lease), Some(owner)) = (&current, previous_pid) {
        if owner != pid as u64 {
            let heartbeat = lease.get("heartbeatAt").and_then(Value::as_str).and_then(crate::store::iso_to_ms);
            let fresh = heartbeat.is_some_and(|time| now_ms - time < crate::LEASE_STALE_MS as i64);
            if fresh && u32::try_from(owner).ok().is_some_and(&alive) { return Ok(false); }
        }
    }
    let now = crate::store::ms_to_iso(now_ms);
    let started = current.as_ref().filter(|_| previous_pid == Some(pid as u64))
        .and_then(|v| v.get("startedAt")).and_then(Value::as_str).unwrap_or(&now);
    let content = format!("{}\n", json!({"pid": pid, "startedAt": started, "heartbeatAt": now}));
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?.as_nanos();
    let tmp = path.with_extension(format!("tmp-{}-{nonce}-{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
        if let Err(e) = file.write_all(content.as_bytes()).and_then(|_| file.flush()) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(true)
}

pub fn release(agent_dir: &Path, pid: u32) -> Result<(), String> {
    let _guard = TransactionLock::acquire(agent_dir).map_err(|e| e.to_string())?;
    let path = agent_dir.join("scheduled-tasks/scheduler.lock");
    if read(&path)?.as_ref().and_then(|v| v.get("pid")).and_then(Value::as_u64) == Some(pid as u64) {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn read(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(serde_json::from_str(&text).ok()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typescript_and_rust_contenders_choose_one_owner() {
        let dir = tempfile::tempdir().unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        let output = dir.path().join("typescript-result");
        let now = 1_772_342_220_000_i64;
        let mut child = std::process::Command::new("node")
            .arg(root.join("crates/task-scheduler/tests/fixtures/lease-contender.mjs"))
            .arg(&root).arg(dir.path()).arg(now.to_string()).arg(&output)
            .spawn().unwrap();
        let rust_won = acquire(dir.path(), 456, now, |_| true).unwrap();
        assert!(child.wait().unwrap().success());
        let ts_won = std::fs::read_to_string(output).unwrap() == "true";
        assert_ne!(rust_won, ts_won, "exactly one owner must win");
        let path = dir.path().join("scheduled-tasks/scheduler.lock");
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(stored["pid"], if rust_won { 456 } else { 123 });
    }

    #[test]
    fn legacy_lease_blocks_live_owner_and_preserves_format() {
        let dir = tempfile::tempdir().unwrap();
        let lease_dir = dir.path().join("scheduled-tasks");
        std::fs::create_dir(&lease_dir).unwrap();
        let now = 1_772_342_220_000;
        let stamp = crate::store::ms_to_iso(now);
        let path = lease_dir.join("scheduler.lock");
        std::fs::write(&path, json!({"pid": 123, "startedAt": stamp, "heartbeatAt": stamp}).to_string()).unwrap();
        assert!(!acquire(dir.path(), 456, now + 1000, |_| true).unwrap());
        release(dir.path(), 456).unwrap();
        assert!(path.exists());
        assert!(acquire(dir.path(), 456, now + 90_000, |_| true).unwrap());
        let lease: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(lease["pid"], 456);
        assert!(lease["startedAt"].is_string() && lease["heartbeatAt"].is_string());
        release(dir.path(), 456).unwrap();
        assert!(!path.exists());
    }
}
