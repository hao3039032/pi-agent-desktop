import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

/** Shared with the Rust host. Never reclaim an uncertain owner automatically. */
export function withScheduledTasksTransaction<T>(agentDir: string, action: () => T): T {
  const dir = join(agentDir, "scheduled-tasks");
  const lock = join(dir, "transaction.lock");
  mkdirSync(dir, { recursive: true });
  const ownerFile = join(lock, "owner");
  const token = randomUUID();
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lock);
      try {
        writeFileSync(ownerFile, token, { flag: "wx", mode: 0o600 });
      } catch (error) {
        try { unlinkSync(ownerFile); } catch { /* no owner file */ }
        rmdirSync(lock);
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Scheduled tasks transaction is busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    if (readFileSync(ownerFile, "utf8") !== token) throw new Error("Scheduled tasks transaction lock ownership changed");
    unlinkSync(ownerFile);
    rmdirSync(lock);
  }
}
