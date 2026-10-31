//! Cross-process transaction gate shared with the transitional TypeScript store.
//! An abandoned gate is never reclaimed automatically: a paused writer must
//! not be mistaken for a dead one and allowed to overwrite a later transaction.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub struct TransactionLock {
    path: PathBuf,
    token: String,
}

impl TransactionLock {
    pub fn acquire(agent_dir: &Path) -> std::io::Result<Self> {
        let dir = agent_dir.join("scheduled-tasks");
        std::fs::create_dir_all(&dir)?;
        let lock = dir.join("transaction.lock");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match std::fs::create_dir(&lock) {
                Ok(()) => {
                    use std::io::Write;
                    use std::sync::atomic::{AtomicU64, Ordering};
                    static NEXT: AtomicU64 = AtomicU64::new(0);
                    let token = format!("{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
                    let owner = lock.join("owner");
                    let mut options = std::fs::OpenOptions::new();
                    options.write(true).create_new(true);
                    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
                    let result = options.open(&owner).and_then(|mut file| file.write_all(token.as_bytes()));
                    if let Err(error) = result {
                        let _ = std::fs::remove_file(&owner);
                        let _ = std::fs::remove_dir(&lock);
                        return Err(error);
                    }
                    return Ok(Self { path: lock, token });
                },
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

impl Drop for TransactionLock {
    fn drop(&mut self) {
        let owner = self.path.join("owner");
        if std::fs::read_to_string(&owner).ok().as_deref() == Some(&self.token) {
            if std::fs::remove_file(owner).is_ok() {
                let _ = std::fs::remove_dir(&self.path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn crashed_typescript_owner_leaves_gate_closed_and_data_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::write(&data, "unchanged").unwrap();
        let module = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../lib/scheduled-tasks/transaction-lock.ts").canonicalize().unwrap();
        let script = "const {withScheduledTasksTransaction} = await import(process.argv[1]); withScheduledTasksTransaction(process.argv[2], () => process.exit(0));";
        let status = Command::new("node").args(["--input-type=module", "-e", script])
            .arg(module).arg(dir.path()).status().unwrap();
        assert!(status.success());
        assert!(TransactionLock::acquire(dir.path()).is_err());
        assert_eq!(std::fs::read_to_string(data).unwrap(), "unchanged");
    }

    #[test]
    fn typescript_and_rust_serialize_cross_process_transactions() {
        let dir = tempfile::tempdir().unwrap();
        let counter = dir.path().join("counter");
        std::fs::write(&counter, "0").unwrap();
        let module = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../lib/scheduled-tasks/transaction-lock.ts")
            .canonicalize().unwrap();
        let script = r#"
          const { withScheduledTasksTransaction } = await import(process.argv[1]);
          const fs = await import('node:fs');
          for (let i = 0; i < 50; i++) withScheduledTasksTransaction(process.argv[2], () => {
            const n = Number(fs.readFileSync(process.argv[3], 'utf8'));
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
            fs.writeFileSync(process.argv[3], String(n + 1));
          });
        "#;
        let mut child = Command::new("node").args(["--input-type=module", "-e", script])
            .arg(module).arg(dir.path()).arg(&counter).spawn().unwrap();
        for _ in 0..50 {
            let _lock = TransactionLock::acquire(dir.path()).unwrap();
            let n: u32 = std::fs::read_to_string(&counter).unwrap().parse().unwrap();
            std::thread::sleep(Duration::from_millis(2));
            std::fs::write(&counter, (n + 1).to_string()).unwrap();
        }
        assert!(child.wait().unwrap().success());
        assert_eq!(std::fs::read_to_string(counter).unwrap(), "100");
    }
}
