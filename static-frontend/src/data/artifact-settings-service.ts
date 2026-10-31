/**
 * The IPC-backed artifacts settings service (the static build's alias target for
 * lib/artifact-settings-service.ts): the prompt switch goes through
 * artifacts.settingsGet / artifacts.settingsSet over pi_ipc.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type { ArtifactsSettingsResponse } from "../../../lib/artifact-settings-service";

export type { ArtifactsSettingsResponse };

let client: IpcClient | null = null;

export function bindArtifactsSettingsService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) {
    throw new Error("the artifacts-settings service IPC bridge is not configured (bindArtifactsSettingsService)");
  }
  return client;
}

/** Load artifacts setting over IPC. */
export async function fetchArtifactsSettings(): Promise<ArtifactsSettingsResponse> {
  try {
    const res = await ensureClient().request<{ enabled: boolean }>("artifacts.settingsGet", undefined, { timeoutMs: 15_000 });
    return { enabled: res.enabled !== false };
  } catch (caught) {
    if (caught instanceof IpcFailure || (caught && typeof caught === "object" && (caught as { name?: string }).name === "IpcFailure")) {
      const errObj = (caught as { error?: { message?: string } }).error;
      throw new Error(errObj?.message || (caught as Error).message || "Failed to load artifacts settings");
    }
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Save artifacts setting over IPC. */
export async function saveArtifactsSettings(enabled: boolean): Promise<ArtifactsSettingsResponse> {
  try {
    const res = await ensureClient().request<{ enabled: boolean }>("artifacts.settingsSet", { enabled }, { timeoutMs: 15_000 });
    return { enabled: res.enabled !== false };
  } catch (caught) {
    if (caught instanceof IpcFailure || (caught && typeof caught === "object" && (caught as { name?: string }).name === "IpcFailure")) {
      const errObj = (caught as { error?: { message?: string } }).error;
      throw new Error(errObj?.message || (caught as Error).message || "Failed to save artifacts settings");
    }
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}
