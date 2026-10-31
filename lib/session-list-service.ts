"use client";

/**
 * The session-list service seam (migration M2): the catalogue calls the
 * sidebar, the shell and the mention palette make — the list load (GET
 * /api/sessions with its summary/force modes), the running-set stream (GET
 * /api/agent/running/events) and the home directory (GET /api/home) — live
 * here so the static build can swap them for the typed IPC bridge through a
 * vite alias, exactly like lib/session-view-service.ts. The Next app keeps
 * HTTP until M5.
 *
 * The Next implementation preserves the EXACT requests the callers made
 * (URL shapes, query modes, reconnect discipline) — moving a call here must
 * not change behavior.
 */

export interface SessionListPayload {
  sessions: import("./types").SessionInfo[];
  sessionListVersion: number;
  runningSessionIds?: string[];
  completionNotificationSuppressedSessionIds?: string[];
  chatWorkspaceCwd?: string | null;
}

export async function searchSessions(query: string, signal?: AbortSignal): Promise<import("./session-search").SessionSearchResponse> {
  const res = await fetch(`/api/sessions/search?${new URLSearchParams({ q: query })}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as import("./session-search").SessionSearchResponse;
}

/** One frame of the running-set stream (the SSE data payload). */
export interface RunningSetFrame {
  runningSessionIds: string[];
  sessionListVersion: number;
}

function sessionListUrl(summary: boolean, force: boolean): string {
  if (summary) return "/api/sessions?summary=1";
  if (force) return "/api/sessions?force=1";
  return "/api/sessions";
}

/**
 * Load the session catalogue. `summary` paints from header/stat metadata
 * without parsing every transcript; `force` bypasses the server's scan
 * cache. Both arrive as the same payload shape.
 */
export async function fetchSessionList(options: {
  summary?: boolean;
  force?: boolean;
  signal?: AbortSignal;
} = {}): Promise<SessionListPayload> {
  const res = await fetch(sessionListUrl(options.summary === true, options.force === true), {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json() as SessionListPayload;
}

/**
 * Subscribe to the running-session-id set. The first frame is the current
 * set; every later frame replaces it. Reconnects after a stall (the local
 * server can restart; EventSource alone may hang), re-subscribes when the
 * page becomes visible again, and returns a disposer that closes the
 * stream.
 */
export function subscribeRunningSessions(
  onFrame: (frame: RunningSetFrame) => void,
): () => void {
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    source?.close();
    source = new EventSource("/api/agent/running/events");
    source.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as { type?: string; runningSessionIds?: string[]; sessionListVersion?: number };
        if (data.type === "running" && Array.isArray(data.runningSessionIds)) {
          onFrame({
            runningSessionIds: data.runningSessionIds,
            sessionListVersion: typeof data.sessionListVersion === "number" ? data.sessionListVersion : 0,
          });
        }
      } catch {
        // ignore malformed frames
      }
    };
    source.onerror = () => {
      // Force a fresh connection after prolonged failures; EventSource alone
      // can stall after local server restarts in the desktop shell.
      if (source?.readyState === EventSource.CLOSED) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1_500);
      }
    };
  };

  connect();
  const onVisible = () => {
    if (document.visibilityState === "visible") connect();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", connect);

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", connect);
    source?.close();
  };
}

/** The user's home directory (GET /api/home). */
export async function fetchHomeDirectory(): Promise<string | null> {
  const res = await fetch("/api/home");
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({})) as { home?: string };
  return data.home ?? null;
}
