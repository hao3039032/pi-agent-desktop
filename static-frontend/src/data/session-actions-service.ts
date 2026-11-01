import { IpcClient, IpcFailure } from "../ipc/client.ts";

let client: IpcClient | null = null;
export function bindSessionActionsService(bound: IpcClient): void { client = bound; }

export async function autoNameSession(sessionId: string, signal?: AbortSignal): Promise<{ title?: string; error?: string }> {
  if (!client) throw new Error("the session-actions IPC bridge is not configured");
  if (signal?.aborted) throw signal.reason;
  try {
    const { task } = await client.request<{ task: string }>("sessions.autoName", { session: sessionId }, { timeoutMs: 70_000 });
    for (;;) {
      if (signal?.aborted) {
        await client.request("sessions.autoNameCancel", { session: sessionId, task }, { timeoutMs: 15_000 });
        throw new Error("Session title generation cancelled");
      }
      // A status request can perform the rename. Await its answer even after
      // cancellation: abandoning it could misreport a completed rename.
      const result = await client.request<{ status?: string; title?: string }>("sessions.autoNameStatus", { session: sessionId, task }, { timeoutMs: 100_000 });
      if (result.title) return result;
      if (result.status !== "running") throw new Error("Invalid title task status");
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  } catch (error) {
    if (error instanceof IpcFailure) throw new Error(error.error.message);
    throw error;
  }
}

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
