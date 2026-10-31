import { mkdirSync, readFileSync, rmSync } from "fs";
import { dirname, join } from "path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { withScheduledTasksTransaction } from "./transaction-lock";

/**
 * Only one process may fire scheduled tasks. A dev server and the desktop app
 * both read ~/.pi/agent, so without this each would start every task.
 */

export const LEASE_STALE_MS = 90_000;

export interface Lease {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

export interface LeaseInfo extends Lease {
  /** True when the heartbeat is inside the takeover window. */
  fresh: boolean;
  /** True when the OS still reports the owner process. */
  alive: boolean;
}

export function leasePath(dir: string): string {
  return join(dir, "scheduler.lock");
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLease(path: string): Lease | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = JSON.parse(content) as Partial<Lease>;
  if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0 || (parsed.pid ?? 0) > 0xffff_ffff || typeof parsed.heartbeatAt !== "string"
    || Number.isNaN(new Date(parsed.heartbeatAt).getTime())) {
    throw new Error("Invalid scheduler lease");
  }
  return { pid: parsed.pid!, startedAt: String(parsed.startedAt ?? parsed.heartbeatAt), heartbeatAt: parsed.heartbeatAt };
}

/** Read the current owner without trying to acquire its lease. */
export function readLeaseInfo(
  dir: string,
  options: { now?: Date; alive?: (pid: number) => boolean } = {},
): LeaseInfo | null {
  const lease = readLease(leasePath(dir));
  if (!lease) return null;
  const now = options.now ?? new Date();
  const alive = options.alive ?? isPidAlive;
  return {
    ...lease,
    fresh: now.getTime() - new Date(lease.heartbeatAt).getTime() < LEASE_STALE_MS,
    alive: alive(lease.pid),
  };
}

/** Take the lease, or refresh it when this process already holds it. */
export function acquireLease(
  dir: string,
  options: { pid?: number; now?: Date; alive?: (pid: number) => boolean } = {},
): boolean {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? new Date();
  const alive = options.alive ?? isPidAlive;
  const path = leasePath(dir);
  return withScheduledTasksTransaction(dirname(dir), () => {
    const current = readLease(path);
    if (current && current.pid !== pid) {
      const fresh = now.getTime() - new Date(current.heartbeatAt).getTime() < LEASE_STALE_MS;
      if (fresh && alive(current.pid)) return false;
    }
    mkdirSync(dir, { recursive: true });
    const lease: Lease = {
      pid,
      startedAt: current && current.pid === pid ? current.startedAt : now.toISOString(),
      heartbeatAt: now.toISOString(),
    };
    writePrivateFileAtomicSync(path, `${JSON.stringify(lease)}\n`);
    return true;
  });
}

export function releaseLease(dir: string, pid = process.pid): void {
  const path = leasePath(dir);
  withScheduledTasksTransaction(dirname(dir), () => {
    if (readLease(path)?.pid === pid) rmSync(path, { force: true });
  });
}
