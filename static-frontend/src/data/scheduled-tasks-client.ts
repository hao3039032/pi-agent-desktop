import { IpcClient } from "../ipc/client.ts";
import { detectTransport } from "./transport.ts";
import { refreshScheduledTasks } from "./scheduled-tasks-store.ts";
import type { CronPreview, TaskInput } from "../../../lib/scheduled-tasks/client";
import type { ScheduledRun, ScheduledTaskView } from "../../../lib/scheduled-tasks/types";

export type { CronPreview, TaskInput };

export class ScheduledApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly key?: string;
  readonly params?: Record<string, string | number>;
  constructor(message: string, status: number, code?: string, key?: string, params?: Record<string, string | number>) {
    super(message);
    this.name = "ScheduledApiError";
    this.status = status;
    this.code = code;
    this.key = key;
    this.params = params;
  }
}

let client: IpcClient | null = null;
export function bindScheduledTasksClient(value: IpcClient): void { client = value; }
function request<T>(op: string, args?: Record<string, unknown>): Promise<T> {
  return (client ??= new IpcClient(detectTransport().transport)).request<T>(op, args);
}
async function mutation<T>(op: string, args: Record<string, unknown>): Promise<T> {
  const result = await request<T>(op, args);
  void refreshScheduledTasks();
  return result;
}
export const scheduledApi = {
  list: () => request<{ tasks: ScheduledTaskView[]; scheduler: { owner: boolean; ownerInfo: null } }>("tasks.list"),
  create: (input: TaskInput) => mutation<{ task: ScheduledTaskView }>("tasks.create", { input }),
  update: (id: string, patch: TaskInput) => mutation<{ task: ScheduledTaskView }>("tasks.update", { id, patch }),
  remove: (id: string) => mutation<{ success: true }>("tasks.delete", { id }),
  run: (id: string) => mutation<{ run: ScheduledRun }>("tasks.run", { id }),
  runs: (id: string, options: { before?: string; limit?: number } = {}) => request<{ runs: ScheduledRun[]; hasMore: boolean }>("tasks.runs", { id, ...options }),
  markSeen: (id: string, runId: string) => mutation<{ run: ScheduledRun }>("tasks.markSeen", { id, runId }),
  preview: (expr: string, timezone?: string) => request<CronPreview>("tasks.previewCron", { expr, ...(timezone ? { timezone } : {}) }),
  takeoverScheduler: () => mutation<{ owner: boolean }>("tasks.takeover", {}),
};
export function apiErrorText(error: unknown, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (error instanceof ScheduledApiError && error.key) return t(error.key, error.params);
  return error instanceof Error ? error.message : String(error);
}
