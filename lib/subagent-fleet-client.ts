"use client";

import type { PiSubagentsStatusView } from "./pi-subagents-view";

export async function fetchSubagentFleet(sessionId: string, signal?: AbortSignal): Promise<PiSubagentsStatusView> {
  const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/subagents`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as PiSubagentsStatusView;
}

export async function sendSubagentFleetAction(sessionId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ error?: string; reason?: string }> {
  const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/subagents`, {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json() as { error?: string; reason?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
