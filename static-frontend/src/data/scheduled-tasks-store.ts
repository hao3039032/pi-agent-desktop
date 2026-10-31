/**
 * The static app's scheduled-tasks store (the vite alias for
 * `@/hooks/useScheduledTasks`).
 *
 * The Next hook shared one EventSource (`/api/scheduled-tasks/events`) with
 * the scheduler server. The static app has no HTTP server, so that stream
 * would only ever hit the SPA fallback and retry forever (the MIME-error
 * storm). Until the host's scheduler wiring (M4) exposes its own event
 * stream over IPC, this store is list-only and HONEST about it:
 *
 * - the task list comes from the REAL host (`tasks.list` reads the store
 *   the scheduler owns — no client-side reimplementation of the format);
 * - there is no event source, so `runningTaskIds` stays empty and
 *   run-finished notifications do not fire in the static app yet;
 * - `schedulerOwner` stays null (unknown): the host does not report the
 *   lease state through `tasks.list` yet. The UI renders null as
 *   "unknown", not as "owner" — no fake ownership.
 *
 * Each of these gaps disappears when the M4 host ops land; none of them is
 * papered over here.
 */

import { useEffect, useSyncExternalStore } from "react";

import { IpcClient } from "../ipc/client.ts";
import { detectTransport } from "./transport.ts";
import type { ScheduledTaskView } from "../../../lib/scheduled-tasks/types";

// The bound client (app-main binds every domain to the ONE transport before
// the tree mounts; tests inject a MockTransport).
let boundClient: IpcClient | null = null;

export function bindScheduledTasksStore(client: IpcClient): void {
  boundClient = client;
}

function clientForTasks(): IpcClient {
  if (boundClient) return boundClient;
  return new IpcClient(detectTransport().transport);
}

export interface SchedulerOwnerInfo {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  fresh: boolean;
  alive: boolean;
}

export interface ScheduledTasksState {
  tasks: ScheduledTaskView[];
  loaded: boolean;
  error: string | null;
  /** Null (unknown) until the host reports the lease over IPC. */
  schedulerOwner: boolean | null;
  schedulerOwnerInfo: SchedulerOwnerInfo | null;
  /** Task ids with a run in progress. Empty until the host event stream lands. */
  runningTaskIds: ReadonlySet<string>;
}

const INITIAL: ScheduledTasksState = {
  tasks: [],
  loaded: false,
  error: null,
  schedulerOwner: null,
  schedulerOwnerInfo: null,
  runningTaskIds: new Set(),
};

let state = INITIAL;
const listeners = new Set<() => void>();
let loadId = 0;
/** Sessions known to be produced by a scheduled run (each task's latest run). */
const scheduledSessionIds = new Set<string>();

function setState(next: Partial<ScheduledTasksState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export async function refreshScheduledTasks(): Promise<void> {
  const id = ++loadId;
  try {
    const data = await clientForTasks().request<{ tasks: unknown[] }>("tasks.list");
    if (id !== loadId) return;
    for (const task of data.tasks as ScheduledTaskView[]) {
      if (task.lastRun?.sessionId) scheduledSessionIds.add(task.lastRun.sessionId);
    }
    setState({ tasks: data.tasks as ScheduledTaskView[], loaded: true, error: null });
  } catch (error) {
    if (id !== loadId) return;
    setState({ loaded: true, error: error instanceof Error ? error.message : String(error) });
  }
}

/** No event source exists yet (M4). Kept as a no-op for the consumer surface. */
export function onScheduledTaskEvent(): () => void {
  return () => {};
}

/** No event source exists yet (M4). Kept as a no-op for the consumer surface. */
export function retainScheduledTaskStream(): () => void {
  return () => {};
}

export function isScheduledRunSession(sessionId: string): boolean {
  return scheduledSessionIds.has(sessionId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshScheduledTasks();
    // Without an event stream, visibility is the honest refresh trigger
    // (returning to the window re-reads the scheduler's store).
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", onVisible);
      // Invalidate any in-flight load from the retired listener generation.
      loadId++;
    }
  };
}

function onVisible(): void {
  if (document.visibilityState === "visible") void refreshScheduledTasks();
}

export function useScheduledTasks(): ScheduledTasksState {
  useEffect(() => {
    // useSyncExternalStore's subscribe only runs while a component is
    // mounted; nothing else holds the store, so refresh on mount too.
    void refreshScheduledTasks();
  }, []);
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}

/** Totals for the sidebar row (the Next app's exact projection). */
export function summarizeScheduledTasks(tasks: readonly ScheduledTaskView[], running: ReadonlySet<string>) {
  return {
    unread: tasks.reduce((total, task) => total + task.unreadRuns, 0),
    // The static store has no event source yet (M4); a run begun before
    // this window opened still shows on the task itself.
    running: running.size > 0 || tasks.some((task) => task.lastRun?.status === "running"),
    attention: tasks.some((task) => Boolean(task.autoPausedReason)),
  };
}
