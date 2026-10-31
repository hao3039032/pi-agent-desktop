/**
 * The IPC-backed models-config service (the static build's alias target for
 * lib/models-config-service.ts): the Models panel's models.json load and
 * save go through modelsConfig.get / modelsConfig.put over pi_ipc — the
 * management instance runs the repo's own readRedactedModelsConfig /
 * saveModelsConfig (the same functions the Next /api/models-config route
 * serves), so a stored literal apiKey never reaches the frontend on either
 * path, and a save that omitted it merges it back on the write.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type { ModelsConfigPayload } from "../../../lib/models-config-service";

let client: IpcClient | null = null;

export function bindModelsConfigService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) throw new Error("the models-config service IPC bridge is not configured (bindModelsConfigService)");
  return client;
}

/** The Models panel's models.json load (the IPC implementation). */
export async function fetchModelsConfig(): Promise<ModelsConfigPayload> {
  try {
    return await ensureClient().request<ModelsConfigPayload>("modelsConfig.get", undefined, { timeoutMs: 60_000 });
  } catch (caught) {
    if (caught instanceof IpcFailure) throw new Error(caught.error.message || "Failed to load models.json");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/**
 * The Models panel's models.json save (the IPC implementation): the whole
 * editor draft as one request — never auto-resent on a timeout (the
 * transport's contract), the panel's own `saving` state blocks a double
 * submit while the write is in flight.
 */
export async function saveModelsConfig(draft: ModelsConfigPayload): Promise<void> {
  try {
    await ensureClient().request<{ success: boolean }>("modelsConfig.put", { config: draft }, { timeoutMs: 60_000 });
  } catch (caught) {
    // Any failure — including the read-refusal reason the host preserves —
    // surfaces as the message the panel's saveError renders, exactly like
    // the HTTP client half did with the route's error body.
    if (caught instanceof IpcFailure) throw new Error(caught.error.message || "Failed to save models.json");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}
