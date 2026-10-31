/**
 * The IPC-backed tool settings service (the static build's alias target for
 * lib/tool-settings-service.ts): presets, Code mode, PowerShell, and inline
 * budget settings go through tools.settingsGet / tools.settingsSet over pi_ipc.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type {
  ToolSettingsChange,
  ToolSettingsResponse,
} from "../../../lib/tool-settings-service";
import { ToolSettingsError } from "../../../lib/tool-settings-service";

export type { ToolSettingsChange, ToolSettingsResponse };
export { ToolSettingsError };

let client: IpcClient | null = null;

export function bindToolSettingsService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) {
    throw new Error("the tool-settings service IPC bridge is not configured (bindToolSettingsService)");
  }
  return client;
}

/** Load tool settings over IPC. */
export async function fetchToolSettings(): Promise<ToolSettingsResponse> {
  try {
    return await ensureClient().request<ToolSettingsResponse>("tools.settingsGet", undefined, { timeoutMs: 15_000 });
  } catch (caught) {
    if (caught instanceof IpcFailure || (caught && typeof caught === "object" && (caught as { name?: string }).name === "IpcFailure")) {
      const errObj = (caught as { error?: { message?: string; reason?: string } }).error;
      const reason = errObj?.reason;
      throw new ToolSettingsError(errObj?.message || (caught as Error).message || "Failed to load tool settings", reason as any);
    }
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Apply tool settings change over IPC. */
export async function saveToolSettings(change: ToolSettingsChange): Promise<ToolSettingsResponse> {
  try {
    return await ensureClient().request<ToolSettingsResponse>("tools.settingsSet", change as unknown as Record<string, unknown>, { timeoutMs: 15_000 });
  } catch (caught) {
    if (caught instanceof IpcFailure || (caught && typeof caught === "object" && (caught as { name?: string }).name === "IpcFailure")) {
      const errObj = (caught as { error?: { message?: string; reason?: string } }).error;
      const reason = errObj?.reason;
      throw new ToolSettingsError(errObj?.message || (caught as Error).message || "Failed to save tool settings", reason as any);
    }
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}
