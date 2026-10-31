"use client";

/**
 * The session-view service seam (migration M2): the data calls the session
 * loop makes — reading a session's view (GET /api/sessions/[id]), paging its
 * context, polling its state, creating a session (POST /api/agent/new) and
 * renewing its lease — live here so the static build can swap them for the
 * typed IPC bridge through a vite alias, exactly like lib/agent-client.ts.
 * The Next app keeps HTTP until M5; the static build aliases this module to
 * static-frontend/src/data/session-view-service.ts.
 *
 * The Next implementation preserves the EXACT requests the hooks made
 * (URL shapes, params, retry discipline) — moving a call here must not
 * change behavior.
 */

import { fetchWithRetry } from "./fetch-timeout";

export interface SessionViewParams {
  force?: boolean;
  /** `tree=summary`: the body-free navigation tree the chat view loads. */
  summaryTree?: boolean;
  deferThinking?: boolean;
  deferMedia?: boolean;
  wholeTurns?: boolean;
  tail?: number;
}

export interface SessionContextPageParams {
  leafId?: string | null;
  before?: string | null;
  tail?: number;
  wholeTurns?: boolean;
  deferThinking?: boolean;
  deferMedia?: boolean;
}

export interface AgentRunningState {
  running: boolean;
  state?: {
    model?: { provider: string; id: string };
    thinkingLevel?: string;
    isStreaming?: boolean;
    isPromptRunning?: boolean;
    isBashRunning?: boolean;
    isCompacting?: boolean;
    streamingMessage?: unknown;
    queuedMessages?: unknown;
    contextUsage?: unknown;
    systemPrompt?: string;
    systemPromptStatus?: string;
    extensionStatuses?: unknown;
    extensionWidgets?: unknown;
    routedModel?: unknown;
    cacheWarming?: unknown;
    autoCompactionEnabled?: boolean;
    autoRetryEnabled?: boolean;
    steeringMode?: string;
    followUpMode?: string;
    [key: string]: unknown;
  };
}

/** One session view read. `status` keeps the hook's 404 handling intact. */
export interface SessionViewResponse {
  status: number;
  ok: boolean;
  data: unknown | null;
  error?: string;
}

function viewUrl(sid: string, params: SessionViewParams): string {
  const search = new URLSearchParams();
  if (params.deferThinking) search.set("deferThinking", "1");
  if (params.deferMedia) search.set("deferMedia", "1");
  if (params.summaryTree) search.set("tree", "summary");
  if (params.wholeTurns) search.set("wholeTurns", "1");
  if (params.force) search.set("force", "1");
  if (params.tail !== undefined) search.set("tail", String(params.tail));
  return `/api/sessions/${encodeURIComponent(sid)}?${search}`;
}

/**
 * The session view (GET /api/sessions/[id]) with the hung-request retry the
 * session load depends on (lib/fetch-timeout): abandon a hang, retry once
 * against the (still finishing) server. `shouldRetry` drops a retry that has
 * become pointless (the user switched away).
 */
export async function fetchSessionView(
  sid: string,
  params: SessionViewParams = {},
  options: { shouldRetry?: () => boolean } = {},
): Promise<SessionViewResponse> {
  const res = await fetchWithRetry(viewUrl(sid, params), { shouldRetry: options.shouldRetry });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { status: res.status, ok: false, data: null, error: body?.error ?? `HTTP ${res.status}` };
  }
  return { status: res.status, ok: true, data: await res.json() };
}

function contextUrlParams(params: SessionContextPageParams): URLSearchParams {
  const search = new URLSearchParams();
  if (params.deferThinking) search.set("deferThinking", "1");
  if (params.deferMedia) search.set("deferMedia", "1");
  if (params.wholeTurns) search.set("wholeTurns", "1");
  if (params.leafId) search.set("leafId", params.leafId);
  if (params.before) search.set("before", params.before);
  if (params.tail !== undefined) search.set("tail", String(params.tail));
  return search;
}

/** The context page (GET /api/sessions/[id]/context): branch reads and paging. */
export async function fetchSessionContextPage(
  sid: string,
  params: SessionContextPageParams = {},
  signal?: AbortSignal,
): Promise<{ context: unknown } | null> {
  const url = `/api/sessions/${encodeURIComponent(sid)}/context?${contextUrlParams(params)}`;
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { context: unknown };
}

/**
 * The running-state poll (GET /api/agent/[id] and /api/sessions/[id]/state —
 * the same contract). Null answers a transport failure; the callers keep
 * polling through transient errors.
 */
export async function fetchAgentRunningState(sid: string): Promise<AgentRunningState | null> {
  const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as AgentRunningState;
}

/** POST /api/agent/new — a brand-new session (ensure_session or the first command). */
export async function createAgentSession(
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  const res = await fetch("/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      data: null,
      error: typeof parsed?.error === "string" ? parsed.error : `HTTP ${res.status}`,
    };
  }
  return { ok: true, status: res.status, data: parsed };
}

/** POST /api/agent/[id]/lease — renew the selected session's liveness lease.
 *  `renewed` counts the live event connections the server still holds for
 *  the session; 0 while the caller believes it is attached is the hook's
 *  self-heal trigger. */
export async function renewSessionLease(sid: string): Promise<{ renewed: number } | null> {
  try {
    const res = await fetch(`/api/agent/${encodeURIComponent(sid)}/lease`, {
      method: "POST",
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as { renewed?: number } & Record<string, unknown> as { renewed: number };
  } catch {
    return null;
  }
}
