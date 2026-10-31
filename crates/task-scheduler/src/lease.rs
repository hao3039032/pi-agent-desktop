//! Scheduler lease compatible with `lib/scheduled-tasks/lease.ts`.
//! The transaction gate covers the read/replace and owner-checked release.

use crate::transaction_lock::TransactionLock;
use serde_json::{json, Value};
use std::path::Path;

/// Read the legacy-compatible lease without changing ownership.
pub fn info<F: Fn(u32) -> bool>(agent_dir: &Path, now_ms: i64, alive: F) -> Result<Option<Value>, String> {
    let path = agent_dir.join("scheduled-tasks/scheduler.lock");
    let Some(mut lease) = read(&path)? else { return Ok(None) };
    let Some(pid) = lease["pid"].as_u64().and_then(|value| u32::try_from(value).ok()) else { return Ok(None) };
    let Some(heartbeat) = lease["heartbeatAt"].as_str().map(str::to_string) else { return Ok(None) };
    let fresh = crate::store::iso_to_ms(&heartbeat).is_some_and(|time| now_ms.saturating_sub(time) < crate::LEASE_STALE_MS as i64);
    if lease["startedAt"].as_str().is_none() { lease["startedAt"] = json!(heartbeat); }
    lease["fresh"] = json!(fresh);
    lease["alive"] = json!(alive(pid));
    Ok(Some(lease))
}

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
        .and_then(|v| v.get("startedAt").or_else(|| v.get("heartbeatAt")))
        .and_then(Value::as_str).unwrap_or(&now);
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
        Ok(text) => {
            let value: Value = serde_json::from_str(&text).map_err(|error| format!("invalid scheduler lease: {error}"))?;
            if !value.get("pid").and_then(Value::as_u64).is_some_and(|pid| pid > 0 && u32::try_from(pid).is_ok())
                || value.get("heartbeatAt").and_then(Value::as_str).and_then(crate::store::iso_to_ms).is_none() {
                return Err("invalid scheduler lease fields".into());
            }
            Ok(Some(value))
        },
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
    fn damaged_lease_is_not_claimed_or_removed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("scheduled-tasks")).unwrap();
        let path = dir.path().join("scheduled-tasks/scheduler.lock");
        std::fs::write(&path, "{broken").unwrap();
        assert!(acquire(dir.path(), 456, 1000, |_| true).is_err());
        assert!(release(dir.path(), 456).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{broken");
        for pid in [0_u64, u32::MAX as u64 + 1] {
            std::fs::write(&path, json!({ "pid": pid, "heartbeatAt": "2026-03-01T05:17:00.000Z" }).to_string()).unwrap();
            assert!(acquire(dir.path(), 456, 1_772_342_220_000, |_| true).is_err());
        }
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
