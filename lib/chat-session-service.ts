"use client";

export interface ChatAccessState {
  chat: boolean;
  folder: string | null;
  unlocked: boolean;
  available: boolean;
}

export interface ContinuedChat {
  sessionId: string;
  path: string | null;
  cwd: string;
  chatFolder: string | null;
}

export async function getChatAccess(sessionId: string): Promise<ChatAccessState> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/chat-access`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as ChatAccessState;
}

export async function setChatAccess(sessionId: string, unlocked: boolean): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/chat-access`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unlocked }),
  });
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
}

export async function continueChatInProject(sessionId: string, cwd: string): Promise<ContinuedChat> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/continue-in-project`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }),
  });
  const data = await response.json().catch(() => ({})) as Partial<ContinuedChat> & { error?: string };
  if (!response.ok || !data.sessionId) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as ContinuedChat;
}
