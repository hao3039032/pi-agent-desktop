/**
 * The IPC-backed enabledModels service (the static build's alias target for
 * lib/enabled-models-service.ts): the Models panel's switches travel the
 * typed IPC bridge (models.enabledGet / models.enabledSet over pi_ipc → the
 * management instance's projection of the repo's own
 * lib/enabled-models-service.server.ts) instead of the HTTP route. Same
 * exported surface and refusal contract — the panel's FAILURE_KEYS map the
 * `reason` of EnabledModelsRefusalError, so the protocol's `last_model` /
 * `project_scope` codes translate back into that exact shape here.
 *
 * The empty-cwd fallback mirrors the models service: the HTTP client omitted
 * the query parameter and the NEXT SERVER answered with its own
 * process.cwd(); the workspace the static app bootstraps into (the chat
 * root) is the honest stand-in, fetched through the workspace service and
 * cached for the call's lifetime.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import {
  EnabledModelsRefusalError,
  type EnabledModelsMutation,
} from "../../../lib/enabled-models-service";
import type { EnabledModelsView } from "../../../lib/enabled-models";
import { fetchChatWorkspaceRoot } from "./workspace-service.ts";

let client: IpcClient | null = null;

export function bindEnabledModelsService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) throw new Error("the enabledModels service IPC bridge is not configured (bindEnabledModelsService)");
  return client;
}

function toError(caught: unknown, fallback: string): Error {
  if (caught instanceof IpcFailure) {
    // The write path's shaped refusals ride the protocol's `reason` field
    // (the HTTP 409 body's reason, verbatim); the hook maps it exactly like
    // it mapped the HTTP response.
    const reason = caught.error.reason;
    if (reason === "last-model" || reason === "project-scope") {
      return new EnabledModelsRefusalError(reason, caught.error.message);
    }
    return new Error(caught.error.message || fallback);
  }
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

/** The panel's switches read (the IPC implementation). */
export async function fetchEnabledModelsView(
  cwd?: string | null,
  signal?: AbortSignal,
): Promise<EnabledModelsView> {
  void signal; // the transport's timeout owns cancellation; the hook discards late results
  try {
    const scopeCwd = cwd || (await resolveFallbackCwd());
    return await ensureClient().request<EnabledModelsView>("models.enabledGet", { cwd: scopeCwd }, { timeoutMs: 60_000 });
  } catch (caught) {
    throw toError(caught, "Failed to load the enabled models");
  }
}

/** One serialized switch/bulk/resync write (the IPC implementation). */
export async function applyEnabledModelsEdit(
  mutation: EnabledModelsMutation,
  cwd?: string | null,
): Promise<EnabledModelsView> {
  try {
    const scopeCwd = cwd || (await resolveFallbackCwd());
    return await ensureClient().request<EnabledModelsView>(
      "models.enabledSet",
      { cwd: scopeCwd, ...mutation },
      { timeoutMs: 60_000 },
    );
  } catch (caught) {
    throw toError(caught, "Failed to update the enabled models");
  }
}

// The seam's client half re-exports so aliased imports stay one binding per
// build (instanceof works identically in Next and the static app).
export {
  EnabledModelsRefusalError,
  parseEnabledModelsMutation,
} from "../../../lib/enabled-models-service";
export type { EnabledModelsMutation } from "../../../lib/enabled-models-service";
