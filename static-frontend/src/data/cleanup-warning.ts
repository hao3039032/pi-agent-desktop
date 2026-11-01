import { appNotify } from "../../../lib/notification-store.ts";

/** Cleanup uncertainty does not turn an already-known mutation into a retry. */
export function notifyCleanupWarning(value: unknown): void {
  if (value !== null && typeof value === "object") {
    const warning = (value as Record<string, unknown>).cleanupWarning;
    if (typeof warning === "string" && warning) appNotify.warning({ message: warning, persistent: true });
  }
}
