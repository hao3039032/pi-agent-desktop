import { IpcClient, IpcFailure } from "../ipc/client.ts";

let client: IpcClient | null = null;
export function bindSessionActionsService(bound: IpcClient): void { client = bound; }

export async function viewSessionHistory(sessionId: string): Promise<void> {
  if (!client) throw new Error("the session-actions IPC bridge is not configured");
  const result = await client.request<{ path: string }>("sessions.export", { session: sessionId }, { timeoutMs: 70_000 });
  const { openPathNative } = await import("@/lib/desktop-native");
  await openPathNative(result.path);
}

export async function deleteSession(sessionId: string, trashChatFolder: boolean): Promise<void> {
  if (!client) throw new Error("the session-actions IPC bridge is not configured");
  try {
    await client.request("sessions.delete", { session: sessionId, trashChatFolder }, { timeoutMs: 40_000 });
  } catch (error) {
    if (error instanceof IpcFailure) throw new Error(error.error.message);
    throw error;
  }
}

export async function renameSession(sessionId: string, name: string): Promise<void> {
  if (!client) throw new Error("the session-actions IPC bridge is not configured");
  try {
    await client.request("sessions.rename", { session: sessionId, name }, { timeoutMs: 40_000 });
  } catch (error) {
    if (error instanceof IpcFailure) throw new Error(error.error.message);
    throw error;
  }
}
