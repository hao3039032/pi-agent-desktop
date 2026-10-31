/**
 * The chat settings service seam (migration M3), client half:
 * chat model, thinking level, custom instructions, and allowed tools.
 *
 * Client-safe by construction (types + the HTTP implementations only);
 * the static build swaps this module for the IPC implementation
 * (static-frontend/src/data/chat-settings-service.ts).
 */

import type { ChatSettings, ChatThinkingLevel } from "./chat-settings-shared";

export type { ChatSettings, ChatThinkingLevel };

export type ChatSettingsPatch = {
  model?: ChatSettings["model"];
  thinkingLevel?: ChatSettings["thinkingLevel"];
  instructions?: string;
  allowedTools?: string[];
  confirmSave?: boolean;
};

export interface ChatSettingsResponse extends ChatSettings {
  instructionsMaxChars: number;
}

/** Load chat settings (HTTP implementation). */
export async function fetchChatSettings(): Promise<ChatSettingsResponse> {
  const res = await fetch("/api/chat-settings", { cache: "no-store" });
  const data = await res.json() as ChatSettingsResponse & { error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data;
}

/** Save chat settings (HTTP implementation). */
export async function saveChatSettings(patch: ChatSettingsPatch): Promise<ChatSettingsResponse> {
  const res = await fetch("/api/chat-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
    cache: "no-store",
  });
  const data = await res.json() as ChatSettingsResponse & { error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data;
}
