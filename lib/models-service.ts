import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isThinkingLevel } from "./thinking-levels";
import type { DefaultPreferencesEdit } from "./default-preferences";
import type { ModelScopeWarning } from "./model-scope-warnings";

/**
 * The models service seam (migration M3), client half.
 *
 * This module is the CLIENT-SAFE surface the composer consumes (types, the
 * write path's shared validation, the shaped refusals' classes and the HTTP
 * implementations of the calls): it must stay free of server-only imports
 * (the SDK's own graph imports node builtins at module top), because
 * hooks/useAgentSession is "use client" — pulling those in here would drag
 * the SDK into the browser bundle.
 *
 * The composition itself (which models a cwd offers, which is default, the
 * star's writes) lives in lib/models-service.server.ts — the ONE
 * implementation both backends run: the Next route
 * (app/api/models/route.ts) and the management instance's `models.list` op
 * (the esbuild projection in scripts/migration/build-management-modules.mjs
 * bundles that file). A drift between them is a contract break, so the route
 * and the extension op are thin adapters (HTTP/access control on the route,
 * protocol plumbing in the extension), never a second copy of that logic.
 *
 * The static build swaps this module for the IPC implementation
 * (static-frontend/src/data/models-service.ts) — the hook's state handling
 * and error text formatting stay identical either way.
 */

export type SelectedModel = { provider: string; modelId: string };
export type ModelEntry = { id: string; name: string; provider: string };
export type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  defaultThinkingLevel?: string | null;
  savedDefaultThinkingLevel?: string | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  modelError?: string;
  modelScopeWarnings?: ModelScopeWarning[];
};

export type DefaultPreferencesEditRequest =
  | { provider: string; modelId: string }
  | { thinkingLevel: ThinkingLevel };

/** The default-write's shaped refusals (the route answers 409/404 for these). */
export class ProjectScopeShadowError extends Error {
  constructor(public settingsPath: string, public keys: string[]) {
    super(`${settingsPath} sets ${keys.join(", ")} for this project, so a global default would not apply here.`);
  }
}
export class ModelNotAvailableError extends Error {
  constructor(provider: string, modelId: string) {
    super(`Model not available: ${provider}/${modelId}`);
  }
}

/** parseEdit, the write path's shared validation (the route's PUT body and
 *  the management op's args agree through this). */
export function parseDefaultPreferencesEdit(body: {
  provider?: unknown;
  modelId?: unknown;
  thinkingLevel?: unknown;
}): DefaultPreferencesEditRequest | null {
  if (body.provider !== undefined || body.modelId !== undefined) {
    if (typeof body.provider !== "string" || !body.provider) return null;
    if (typeof body.modelId !== "string" || !body.modelId) return null;
  }
  if (body.thinkingLevel !== undefined && !isThinkingLevel(body.thinkingLevel)) return null;
  if (body.provider !== undefined) {
    return { provider: body.provider, modelId: body.modelId as string };
  }
  if (body.thinkingLevel !== undefined) {
    return { thinkingLevel: body.thinkingLevel };
  }
  return null;
}

export type { DefaultPreferencesEdit };

/** The model scope for the composer (the HTTP implementation; no cwd means the server default). */
export async function fetchModelsData(cwd: string, signal?: AbortSignal): Promise<ModelsResponse> {
  const modelsUrl = cwd ? `/api/models?cwd=${encodeURIComponent(cwd)}` : "/api/models";
  const res = await fetch(modelsUrl, signal ? { signal } : undefined);
  if (!res.ok) {
    let detail = "";
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
        detail = body.error;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      // Non-JSON error responses fall back to the HTTP status.
    }
    throw new Error(detail || `Failed to load models (HTTP ${res.status})`);
  }
  const d = await res.json() as ModelsResponse;
  // Older macOS WebViews lack throwIfAborted; still discard cancelled responses.
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  return d;
}

/** The selectors' star: save the global default model/thinking level (the HTTP implementation). */
export async function saveDefaultPreferences(
  edit: DefaultPreferencesEditRequest,
  cwd: string | null,
): Promise<void> {
  const res = await fetch("/api/models/default", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(cwd ? { cwd } : {}), ...edit }),
  });
  if (res.ok) return;
  let detail = "";
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") detail = body.error;
  } catch {
    // Non-JSON error responses fall back to the HTTP status.
  }
  throw new Error(detail || `HTTP ${res.status}`);
}
