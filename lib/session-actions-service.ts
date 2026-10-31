"use client";

/** Session mutations keep the Next route until the static host takes over. */
export async function viewSessionHistory(sessionId: string): Promise<void> {
  const url = new URL(`/api/sessions/${encodeURIComponent(sessionId)}/export?inline=1`, window.location.origin).href;
  const { openExternal } = await import("@/lib/desktop-native");
  await openExternal(url);
}

export async function renameSession(sessionId: string, name: string): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
}
