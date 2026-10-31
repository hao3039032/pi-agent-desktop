/**
 * The IPC-backed models-config read (the static build's alias target for
 * lib/models-config-service.ts): the Models panel's models.json load goes
 * through modelsConfig.get over pi_ipc — the management instance runs the
 * repo's own readRedactedModelsConfig (the same function the Next
 * /api/models-config route serves), so a stored literal apiKey never
 * reaches the frontend on either path.
 *
 * Only the read is IPC today; the panel's Save (the route's PUT) stays on
 * HTTP until its own op lands, and surfaces the honest failure there.
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
