/**
 * The static app's scheduled-tasks store. One retained host IPC stream
 * delivers changes to the page, sidebar and notification hook.
 */

import { useEffect, useSyncExternalStore } from "react";

import { IpcClient } from "../ipc/client.ts";
import { detectTransport } from "./transport.ts";
import type { ScheduledTaskEvent, ScheduledTaskView } from "../../../lib/scheduled-tasks/types";

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
  /** Task ids with a run in progress observed by this window. */
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
let streamRefs = 0;
let stopStream: (() => void) | null = null;
let streamError: string | null = null;
const eventHandlers = new Set<(event: ScheduledTaskEvent) => void>();
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
    setState({ tasks: data.tasks as ScheduledTaskView[], loaded: true, error: streamError });
  } catch (error) {
    if (id !== loadId) return;
    setState({ loaded: true, error: error instanceof Error ? error.message : String(error) });
  }
}

export function onScheduledTaskEvent(handler: (event: ScheduledTaskEvent) => void): () => void {
  eventHandlers.add(handler);
  return () => { eventHandlers.delete(handler); };
}

export function retainScheduledTaskStream(): () => void {
  streamRefs += 1;
  if (streamRefs === 1) {
    stopStream = clientForTasks().subscribe<ScheduledTaskEvent>("tasks.subscribeEvents", undefined, (frame) => {
      if (frame.kind !== "event" || !frame.payload || typeof frame.payload.type !== "string") return;
      streamError = null;
      const event = frame.payload;
      const running = new Set(state.runningTaskIds);
      if (event.type === "run_started") {
        running.add(event.taskId);
        if (event.sessionId) scheduledSessionIds.add(event.sessionId);
      } else if (event.type === "run_finished") {
        running.delete(event.taskId);
        if (event.sessionId) scheduledSessionIds.add(event.sessionId);
      }
      setState({ runningTaskIds: running, ...(event.type === "scheduler_owner" ? { schedulerOwner: event.owner } : {}) });
      for (const handler of eventHandlers) handler(event);
      void refreshScheduledTasks();
    }, (error) => { streamError = error.message; setState({ error: streamError }); });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    streamRefs -= 1;
    if (streamRefs === 0) { stopStream?.(); stopStream = null; streamError = null; }
  };
}

export function isScheduledRunSession(sessionId: string): boolean {
  return scheduledSessionIds.has(sessionId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshScheduledTasks();
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
    // A run begun before this window opened still shows on the task itself.
    running: running.size > 0 || tasks.some((task) => task.lastRun?.status === "running"),
    attention: tasks.some((task) => Boolean(task.autoPausedReason)),
  };
}
