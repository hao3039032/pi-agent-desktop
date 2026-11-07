"use client";

import { useSyncExternalStore } from "react";
import { APP_PREF_KEYS, getPrefBool, setPrefBool } from "@/lib/app-prefs";

/**
 * Settings › General › Chat: while the agent runs, the composer's send action
 * either steers the current run at the next receptive moment (default) or
 * queues the message in the editable outbox ("send after completion").
 * Absent storage means the steer default, so existing users are not migrated.
 */
const DEFAULT = false;
const listeners = new Set<() => void>();

export function isQueueWhileRunning(): boolean {
  return getPrefBool(APP_PREF_KEYS.queueWhileRunning, DEFAULT);
}

export function setQueueWhileRunning(next: boolean): void {
  setPrefBool(APP_PREF_KEYS.queueWhileRunning, next);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getServerSnapshot(): boolean {
  return DEFAULT;
}

export function useQueueWhileRunning(): boolean {
  return useSyncExternalStore(subscribe, isQueueWhileRunning, getServerSnapshot);
}
