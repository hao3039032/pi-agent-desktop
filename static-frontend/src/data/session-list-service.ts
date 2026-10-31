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
export function subscribeRunningSessions(onFrame: (frame: RunningSetFrame) => void): () => void {
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  const subscribe = () => {
    if (disposed) return;
    unsubscribe = ensureClient().subscribe<IpcStreamMessage>(
      "agent.subscribeRunning",
      undefined,
      (message) => {
        const payload = message.payload as { type?: string; runningSessionIds?: string[]; sessionListVersion?: number } | undefined;
        if (payload?.type === "running" && Array.isArray(payload.runningSessionIds)) {
          onFrame({
            runningSessionIds: payload.runningSessionIds,
            sessionListVersion: typeof payload.sessionListVersion === "number" ? payload.sessionListVersion : 0,
          });
        }
      },
      (_error: IpcError) => {
        if (disposed) return;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(subscribe, 1_500);
      },
    );
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
