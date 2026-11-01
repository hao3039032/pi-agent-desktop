import { IpcClient, IpcFailure } from "../ipc/client.ts";
import { notifyCleanupWarning } from "./cleanup-warning.ts";
import type { ChatAccessState, ContinuedChat } from "../../../lib/chat-session-service.ts";
export type { ChatAccessState, ContinuedChat } from "../../../lib/chat-session-service.ts";

let client: IpcClient | null = null;
export function bindChatSessionService(bound: IpcClient): void { client = bound; }

async function request<T>(op: string, args: Record<string, unknown>): Promise<T> {
  if (!client) throw new Error("the chat-session IPC bridge is not configured");
  try {
    const result = await client.request<T>(op, args, { timeoutMs: 40_000 });
    notifyCleanupWarning(result);
    return result;
  } catch (error) {
    if (error instanceof IpcFailure) throw new Error(error.error.message);
    throw error;
  }
}

export function getChatAccess(sessionId: string): Promise<ChatAccessState> {
  return request("sessions.chatAccessGet", { session: sessionId });
}

export async function setChatAccess(sessionId: string, unlocked: boolean): Promise<void> {
  await request("sessions.chatAccessSet", { session: sessionId, unlocked });
}

export function continueChatInProject(sessionId: string, cwd: string): Promise<ContinuedChat> {
  return request("sessions.continueInProject", { session: sessionId, cwd });
}
