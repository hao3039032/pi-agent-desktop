/**
 * The IPC-backed session-view service (the static build's alias target for
 * lib/session-view-service.ts): the session loop's reads travel the typed
 * IPC bridge (sessions.get / sessions.context / sessions.state over pi_ipc)
 * instead of /api/sessions/* and /api/agent/*. Same exported surface, same
 * status/error contract the hooks consume.
 *
 * Notable mappings:
 * - a host `not_found` maps to status 404 (the load path's delete handling);
 * - the view read keeps the abandon-and-retry-once discipline (a hung IPC
 *   request is as bad as a hung HTTP one); a timeout NEVER auto-resends a
 *   side-effecting op — the view read is read-only, so the retry is safe;
 * - the running-state poll answers null on any failure (the callers keep
 *   polling through transient errors);
 * - renewSessionLease is a no-op here: in the static app the event
 *   subscription itself holds the session's idle lease (the host leases on
 *   subscribe), so there is no separate lease endpoint to renew.
 */

import { IpcClient, IpcFailure, IpcTimeoutError } from "../ipc/client.ts";
import type {
  AgentRunningState,
  SessionContextPageParams,
  SessionViewParams,
  SessionViewResponse,
} from "../../../lib/session-view-service";

let client: IpcClient | null = null;

export function bindSessionViewService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) throw new Error("the session-view IPC bridge is not configured (bindSessionViewService)");
  return client;
}

/** An IPC failure mapped onto the HTTP-shaped status the hook logic reads. */
function failureStatus(failure: IpcFailure): number {
  return failure.error.code === "not_found" ? 404 : 500;
}

function viewArgs(params: SessionViewParams): Record<string, unknown> {
  return {
    ...(params.summaryTree ? { summaryTree: true } : {}),
    ...(params.deferThinking ? { deferThinking: true } : {}),
    ...(params.deferMedia ? { deferMedia: true } : {}),
    ...(params.wholeTurns ? { wholeTurns: true } : {}),
    ...(params.tail !== undefined ? { tail: params.tail } : {}),
  };
}

export async function fetchSessionView(
  sid: string,
  params: SessionViewParams = {},
  options: { shouldRetry?: () => boolean } = {},
): Promise<SessionViewResponse> {
  const args = viewArgs(params);
  const request = () => ensureClient().request("sessions.get", { session: sid, ...args }, { timeoutMs: 20_000 });
  // A read-only view read: a hang (timeout) may be retried once — the host
  // keeps finishing the cold start — and a protocol failure surfaces as the
  // HTTP-shaped status the hook logic reads. A retry never re-sends a
  // side-effecting operation (this one only reads).
  const once = async (): Promise<SessionViewResponse> => {
    try {
      return { status: 200, ok: true, data: await request() };
    } catch (caught) {
      if (caught instanceof IpcFailure) {
        return {
          status: failureStatus(caught),
          ok: false,
          data: null,
          error: caught.error.message,
        };
      }
      throw caught instanceof Error ? caught : new Error(String(caught));
    }
  };
  try {
    return await once();
  } catch (error) {
    if (!(error instanceof IpcTimeoutError)) throw error;
    if (options.shouldRetry && !options.shouldRetry()) throw error;
    return once();
  }
}

export async function fetchSessionContextPage(
  sid: string,
  params: SessionContextPageParams = {},
  _signal?: AbortSignal,
): Promise<{ context: unknown } | null> {
  const args: Record<string, unknown> = {
    ...(params.deferThinking ? { deferThinking: true } : {}),
    ...(params.deferMedia ? { deferMedia: true } : {}),
    ...(params.wholeTurns ? { wholeTurns: true } : {}),
    ...(params.leafId ? { leafId: params.leafId } : {}),
    ...(params.before ? { before: params.before } : {}),
    ...(params.tail !== undefined ? { tail: params.tail } : {}),
  };
  const data = await ensureClient().request<{ context?: unknown }>(
    "sessions.context",
    { session: sid, ...args },
    { timeoutMs: 20_000 },
  );
  return { context: data.context };
}

export async function fetchAgentRunningState(sid: string): Promise<AgentRunningState | null> {
  try {
    return await ensureClient().request<AgentRunningState>(
      "sessions.state",
      { session: sid },
      { timeoutMs: 15_000 },
    );
  } catch {
    // The poll callers keep polling through transient failures.
    return null;
  }
}

export async function createAgentSession(
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  // The create op arrives with the spawn-plan increment; until then the host
  // answers unknown_op and the composer surfaces the honest error instead of
  // a half-created session.
  try {
    const data = await ensureClient().request("sessions.create", body, { timeoutMs: 60_000 });
    return { ok: true, status: 200, data };
  } catch (caught) {
    if (caught instanceof IpcFailure) {
      return { ok: false, status: failureStatus(caught), data: null, error: caught.error.message };
    }
    return {
      ok: false,
      status: 500,
      data: null,
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

export async function renewSessionLease(sid: string): Promise<{ renewed: number } | null> {
  // The host extends the idle lease and answers its live relay count for
  // this session (sessions.lease) — the hook's self-heal survives the
  // transport swap.
  try {
    return await ensureClient().request<{ renewed?: number }>(
      "sessions.lease",
      { session: sid },
      { timeoutMs: 15_000 },
    ).then((data) => ({ renewed: data.renewed ?? 0 }));
  } catch {
    return null;
  }
}
