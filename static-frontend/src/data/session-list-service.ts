/**
 * The IPC-backed session-list service (the static build's alias target for
 * lib/session-list-service.ts): the catalogue load, the running-set stream
 * and the home directory travel the typed IPC bridge (sessions.list /
 * agent.subscribeRunning / cwd.home over pi_ipc) instead of /api/sessions,
 * /api/agent/running/events and /api/home. Same exported surface, same
 * frame contract, same reconnect discipline as the HTTP version.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type { IpcError, IpcStreamMessage } from "../ipc/protocol.ts";
import type { RunningSetFrame, SessionListPayload } from "../../../lib/session-list-service";

let client: IpcClient | null = null;

export function bindSessionListService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) throw new Error("the session-list service IPC bridge is not configured (bindSessionListService)");
  return client;
}

export async function searchSessions(query: string, _signal?: AbortSignal): Promise<import("../../../lib/session-search").SessionSearchResponse> {
  return ensureClient().request("sessions.search", { query }, { timeoutMs: 30_000 });
}

/**
 * The catalogue over IPC. The host's catalogue always scans (there is no
 * server-side cache to bypass), so `summary`/`force` are accepted for
 * interface parity and answered by the same payload.
 */
export async function fetchSessionList(_options: {
  summary?: boolean;
  force?: boolean;
  signal?: AbortSignal;
} = {}): Promise<SessionListPayload> {
  void _options;
  try {
    return await ensureClient().request<SessionListPayload>("sessions.list", undefined, { timeoutMs: 30_000 });
  } catch (caught) {
    if (caught instanceof IpcFailure) throw new Error(caught.error.message || `HTTP 500`);
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/**
 * The running-set stream over the host channel. The first frame is the
 * observation at subscribe time; every later frame replaces the set. A
 * stream error resubscribes after the same 1.5s the SSE version used (the
 * host relay ends on channel death; a fresh subscription re-snapshots).
 */
export function subscribeRunningSessions(onFrame: (frame: RunningSetFrame) => void, onReset?: () => void): () => void {
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  const subscribe = () => {
    if (disposed) return;
    let active = true;
    let streamId: string | null = null;
    let epoch = 0;
    let seq = 0;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const invalidate = () => {
      if (!active || disposed) return;
      active = false;
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
      onReset?.();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        unsubscribe?.();
        unsubscribe = null;
        subscribe();
      }, 1_500);
    };
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(invalidate, 45_000);
    };
    armWatchdog();
    const close = ensureClient().subscribe<IpcStreamMessage>(
      "agent.subscribeRunning", undefined,
      (message) => {
        if (!active) return;
        const payload = message.payload as { type?: string; runningSessionIds?: string[]; sessionListVersion?: number; resync?: boolean } | undefined;
        if ((message.kind !== "snapshot" && message.kind !== "event") || typeof message.subscriptionId !== "string" || !message.subscriptionId
            || !Number.isSafeInteger(message.seq) || !Number.isSafeInteger(message.epoch) || message.epoch < 1
            || (seq === 0 ? message.kind !== "snapshot" || message.seq !== 1
              : message.kind === "snapshot" || message.subscriptionId !== streamId || message.epoch !== epoch || message.seq !== seq + 1)
            || payload?.type !== "running" || !Array.isArray(payload.runningSessionIds)
            || !payload.runningSessionIds.every((id) => typeof id === "string") || typeof payload.sessionListVersion !== "number") {
          invalidate();
          return;
        }
        streamId = message.subscriptionId;
        epoch = message.epoch;
        seq = message.seq;
        armWatchdog();
        if (payload.resync) onReset?.();
        onFrame({ runningSessionIds: payload.runningSessionIds, sessionListVersion: payload.sessionListVersion });
      },
      (_error: IpcError) => invalidate(),
    );
    unsubscribe = () => { active = false; if (watchdog) clearTimeout(watchdog); watchdog = null; close(); };
    if (!active) unsubscribe();
  };

  subscribe();
  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    unsubscribe?.();
    unsubscribe = null;
  };
}

/** The home directory over IPC (cwd.home → `{ home }`). */
export async function fetchHomeDirectory(): Promise<string | null> {
  try {
    const data = await ensureClient().request<{ home?: string }>("cwd.home", undefined, { timeoutMs: 10_000 });
    return data.home ?? null;
  } catch {
    return null;
  }
}
