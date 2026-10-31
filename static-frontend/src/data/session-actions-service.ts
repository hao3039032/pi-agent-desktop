import { IpcClient, IpcFailure } from "../ipc/client.ts";

let client: IpcClient | null = null;
export function bindSessionActionsService(bound: IpcClient): void { client = bound; }

export async function renameSession(sessionId: string, name: string): Promise<void> {
  if (!client) throw new Error("the session-actions IPC bridge is not configured");
  try {
    await client.request("sessions.rename", { session: sessionId, name }, { timeoutMs: 40_000 });
  } catch (error) {
    if (error instanceof IpcFailure) throw new Error(error.error.message);
    throw error;
  }
}
