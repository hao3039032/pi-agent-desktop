/**
 * The IPC-backed chat settings service (the static build's alias target for
 * lib/chat-settings-service.ts): chat settings go through
 * chats.settingsGet / chats.settingsSet over pi_ipc.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type {
  ChatSettings,
  ChatSettingsPatch,
  ChatSettingsResponse,
} from "../../../lib/chat-settings-service";

export type { ChatSettings, ChatSettingsPatch, ChatSettingsResponse };

let client: IpcClient | null = null;

export function bindChatSettingsService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) {
    throw new Error("the chat-settings service IPC bridge is not configured (bindChatSettingsService)");
  }
  return client;
}

/** Load chat settings over IPC. */
export async function fetchChatSettings(): Promise<ChatSettingsResponse> {
  try {
    return await ensureClient().request<ChatSettingsResponse>("chats.settingsGet", undefined, { timeoutMs: 15_000 });
  } catch (caught) {
    if (caught instanceof IpcFailure || (caught && typeof caught === "object" && (caught as { name?: string }).name === "IpcFailure")) {
      const errObj = (caught as { error?: { message?: string } }).error;
      throw new Error(errObj?.message || (caught as Error).message || "Failed to load chat settings");
    }
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Save chat settings over IPC. */
export async function saveChatSettings(patch: ChatSettingsPatch): Promise<ChatSettingsResponse> {
  try {
    return await ensureClient().request<ChatSettingsResponse>("chats.settingsSet", patch as unknown as Record<string, unknown>, { timeoutMs: 15_000 });
  } catch (caught) {
    if (caught instanceof IpcFailure || (caught && typeof caught === "object" && (caught as { name?: string }).name === "IpcFailure")) {
      const errObj = (caught as { error?: { message?: string } }).error;
      throw new Error(errObj?.message || (caught as Error).message || "Failed to save chat settings");
    }
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}
