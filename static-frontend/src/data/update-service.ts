import type { AppUpdatesResponse } from "../../../lib/app-update-types";
import { IpcClient, IpcFailure } from "../ipc/client.ts";

let client: IpcClient | null = null;
export function bindUpdateService(bound: IpcClient): void { client = bound; }
export async function checkAppUpdates(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<AppUpdatesResponse> {
  if (!client) throw new Error("the update service IPC bridge is not configured");
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    const result = await client.request<AppUpdatesResponse>("updates.check", { refresh: options.refresh === true }, { timeoutMs: 60_000 });
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return result;
  } catch (error) {
    if (error instanceof IpcFailure) throw new Error(error.error.message || "Update check failed");
    throw error;
  }
}
