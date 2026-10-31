"use client";

/**
 * The workspace service seam (migration M3): the path-selection calls the
 * shell, the project picker and the chats settings make — the hidden chat
 * workspace root (GET /api/chat-workspace), cwd validation (POST
 * /api/cwd/validate) and the scratch default cwd (POST /api/default-cwd) —
 * live here so the static build can swap them for the typed IPC bridge
 * through a vite alias, exactly like lib/session-view-service.ts. The Next
 * app keeps HTTP until M5.
 *
 * The Next implementation preserves the EXACT requests the callers made —
 * moving a call here must not change behavior (error text included: the
 * pickers surface `error.message` to the user).
 */

import type { SessionWorkspaceKind } from "./types";

export interface ValidatedCwd {
  success: true;
  cwd: string;
  projectRoot: string | null;
  projectKey: string | null;
  workspaceKind?: SessionWorkspaceKind;
}

/**
 * The hidden cwd used by non-project chats, created on demand
 * (GET /api/chat-workspace → `{ cwd }`). Rejects with the route's error.
 */
export async function fetchChatWorkspaceRoot(options: { signal?: AbortSignal } = {}): Promise<string> {
  const res = await fetch("/api/chat-workspace", {
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
  if (!res.ok || !data.cwd) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.cwd;
}

/**
 * Validate a candidate workspace before the UI selects it (POST
 * /api/cwd/validate). Rejects with the route's error text (the pickers
 * show it directly). The host-side grant (the file allow-list) happens on
 * the server/host, never here.
 */
export async function validateWorkspaceCwd(
  cwd: string,
  options: { signal?: AbortSignal } = {},
): Promise<ValidatedCwd> {
  const res = await fetch("/api/cwd/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const data = await res.json().catch(() => ({})) as Partial<ValidatedCwd> & { error?: string };
  if (!res.ok || data.error || !data.cwd) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data as ValidatedCwd;
}

/**
 * Create ~/pi-cwd/&lt;local YYYYMMDD&gt; on demand (POST /api/default-cwd).
 * The caller then selects the path through validateWorkspaceCwd like any
 * other directory — never directly.
 */
export async function createDefaultWorkspaceCwd(): Promise<string> {
  const res = await fetch("/api/default-cwd", { method: "POST" });
  const data = await res.json().catch(() => ({})) as { cwd?: string; error?: string };
  if (!res.ok || !data.cwd) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.cwd;
}
