/**
 * The IPC-backed models service (the static build's alias target for
 * lib/models-service.ts): the model selector's scope and the selectors' star
 * travel the typed IPC bridge (models.list / models.setDefault over pi_ipc →
 * the management instance's projection of the repo's own
 * lib/models-service.server.ts)
 * instead of the HTTP routes. Same exported surface and error-text contract
 * (the composer surfaces `error.message` directly, exactly like the HTTP
 * detail strings the old responses carried).
 *
 * The empty-cwd fallback: the HTTP client omitted the query parameter and the
 * NEXT SERVER answered with its own process.cwd() — a scope the desktop host
 * has no equivalent of. The composer calls this before any workspace is picked
 * (fresh boot), and the workspace the app bootstraps into is the chat root, so
 * that is the honest stand-in (fetched through the workspace service, cached
 * for the call's lifetime).
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type {
  DefaultPreferencesEditRequest,
  ModelsResponse,
} from "../../../lib/models-service";
import { fetchChatWorkspaceRoot } from "./workspace-service.ts";

let client: IpcClient | null = null;

export function bindModelsService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) throw new Error("the models service IPC bridge is not configured (bindModelsService)");
  return client;
}

function toError(caught: unknown, fallback: string): Error {
  if (caught instanceof IpcFailure) return new Error(caught.error.message || fallback);
  return caught instanceof Error ? caught : new Error(String(caught));
}

let cachedFallbackCwd: string | null = null;

/** The chat root standing in for the HTTP server's process.cwd() default scope. */
async function resolveFallbackCwd(): Promise<string> {
  if (cachedFallbackCwd === null) {
    cachedFallbackCwd = await fetchChatWorkspaceRoot();
  }
  return cachedFallbackCwd;
}

/** The model scope for the composer (the IPC implementation). */
export async function fetchModelsData(cwd: string, signal?: AbortSignal): Promise<ModelsResponse> {
  void signal; // the transport's timeout owns cancellation; the hook discards late results
  try {
    const scopeCwd = cwd || (await resolveFallbackCwd());
    return await ensureClient().request<ModelsResponse>("models.list", { cwd: scopeCwd }, { timeoutMs: 60_000 });
  } catch (caught) {
    throw toError(caught, "Failed to load models");
  }
}

/** The selectors' star: save the global default model/thinking level (the IPC implementation). */
export async function saveDefaultPreferences(
  edit: DefaultPreferencesEditRequest,
  cwd: string | null,
): Promise<void> {
  try {
    const scopeCwd = cwd || (await resolveFallbackCwd());
    await ensureClient().request(
      "models.setDefault",
      { cwd: scopeCwd, ...edit },
      { timeoutMs: 60_000 },
    );
  } catch (caught) {
    throw toError(caught, "Failed to save the default");
  }
}
