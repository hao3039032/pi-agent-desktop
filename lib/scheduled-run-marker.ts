import type { RunTrigger } from "./scheduled-tasks/types";

/**
 * Custom session entry that marks a session as the output of a scheduled run.
 *
 * The single writer is the CLI child: the host asks the bridge extension's
 * `meta.scheduled-run` op to append it through the child's own
 * `pi.appendEntry`, and the run only proceeds once the child confirmed the
 * entry (lib/scheduled-tasks/runner.ts). The host never appends this entry
 * beside a live child. The asset (lib/pi-rpc/assets/pi-web-bridge.mjs)
 * re-validates the payload with the same rules — keep both in step.
 */
export const SCHEDULED_RUN_ENTRY_TYPE = "pi-web:scheduled-run";

/** Mirrors lib/scheduled-tasks/types.ts's MAX_NAME_LENGTH. */
const MAX_TASK_NAME_LENGTH = 120;
/** A run id is a UUID today; printable and short is the contract. */
const MAX_RUN_ID_LENGTH = 128;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const RUN_TRIGGERS: readonly RunTrigger[] = ["schedule", "catch-up", "manual"];

export interface ScheduledRunMarkerData {
  version: 1;
  taskId: string;
  runId: string;
  taskName: string;
  trigger: RunTrigger;
  /** ISO timestamp of the slot the run was scheduled for (catch-up runs). */
  scheduledFor?: string;
}

export function isScheduledRunMarkerData(value: unknown): value is ScheduledRunMarkerData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ScheduledRunMarkerData>;
  if (candidate.version !== 1) return false;
  if (typeof candidate.taskId !== "string" || !UUID_PATTERN.test(candidate.taskId)) return false;
  if (typeof candidate.runId !== "string"
    || candidate.runId.length === 0 || candidate.runId.length > MAX_RUN_ID_LENGTH
    || /[\\/\s]/.test(candidate.runId)) return false;
  if (typeof candidate.taskName !== "string"
    || candidate.taskName.length === 0 || candidate.taskName.length > MAX_TASK_NAME_LENGTH) return false;
  if (typeof candidate.trigger !== "string" || !RUN_TRIGGERS.includes(candidate.trigger as RunTrigger)) return false;
  if (candidate.scheduledFor !== undefined
    && (typeof candidate.scheduledFor !== "string" || !ISO_TIMESTAMP_PATTERN.test(candidate.scheduledFor))) return false;
  return true;
}

/** Same check, but throws the caller can surface. */
export function validateScheduledRunMarkerData(value: unknown): ScheduledRunMarkerData {
  if (!isScheduledRunMarkerData(value)) {
    throw new Error("the scheduled-run marker needs { version: 1, taskId: uuid, runId, taskName, trigger, scheduledFor? }");
  }
  return value;
}
