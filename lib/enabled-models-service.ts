import type { EnabledModelsView, ProviderRename } from "./enabled-models";

/**
 * The enabledModels service seam (migration M3), client half.
 *
 * This module is the CLIENT-SAFE surface the Models panel consumes (the
 * mutation type, the write path's shared validation, the shaped refusal and
 * the HTTP implementations of the two calls): it must stay free of
 * server-only imports (the SDK's own graph imports node builtins at module
 * top), because components/EnabledModelsSection is a "use client" module —
 * pulling those in here would drag the SDK into the browser bundle.
 *
 * The composition itself (which models exist, which settings file decides,
 * every minimal edit, the resync repair) lives in
 * lib/enabled-models-service.server.ts — the ONE implementation both
 * backends run: the Next route (app/api/models/enabled/route.ts) and the
 * management instance's `models.enabledGet` / `models.enabledSet` ops (the
 * esbuild projection in scripts/migration/build-management-modules.mjs
 * bundles that file). A drift between them is a contract break, so the
 * route and the extension ops are thin adapters (HTTP/access control on the
 * route, protocol plumbing in the extension), never a second copy of that
 * logic. The edit engine and the SDK resolver adapter underneath it are
 * lib/enabled-models.ts and lib/enabled-models-runtime.ts, unchanged.
 *
 * The static build swaps this module for the IPC implementation
 * (static-frontend/src/data/enabled-models-service.ts) — the panel's
 * state handling, serialization queue and failure keys stay identical.
 */

/** What a switch/bulk action asks the write path to do (PUT /api/models/enabled's `op` union). */
export type EnabledModelsMutation =
  | { op: "models"; refs: string[]; enabled: boolean }
  | { op: "provider"; provider: string; enabled: boolean }
  | { op: "clear" }
  | { op: "prune" }
  | {
      op: "resync";
      renames: ProviderRename[];
      modelRenames: ProviderRename[];
      fullyEnabled: string[];
    };

/**
 * The write path's shaped refusals (the route answers 409 for these; the
 * management protocol carries them as the `last_model` / `project_scope`
 * codes). `reason` is the value both the HTTP body and the panel's
 * FAILURE_KEYS use.
 */
export class EnabledModelsRefusalError extends Error {
  constructor(
    public readonly reason: "last-model" | "project-scope",
    message: string,
  ) {
    super(message);
    this.name = "EnabledModelsRefusalError";
  }
}

/** A `{ from, to }` pair list as the route's PUT body accepts it. */
function renamePairs(value: unknown): ProviderRename[] | null {
  if (!Array.isArray(value)) return null;
  const renames: ProviderRename[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { from, to } = entry as Record<string, unknown>;
    if (typeof from !== "string" || typeof to !== "string" || !from || !to) return null;
    renames.push({ from, to });
  }
  return renames;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value as string[];
}

/**
 * parseEnabledModelsMutation, the write path's shared validation: the route's
 * PUT body and the management op's args agree through this (the Rust host
 * mirrors the same closed shape host-side before the op is ever called).
 * Field errors keep the route's exact texts so clients see one vocabulary.
 */
export function parseEnabledModelsMutation(body: {
  op?: unknown;
  provider?: unknown;
  refs?: unknown;
  renames?: unknown;
  modelRenames?: unknown;
  fullyEnabled?: unknown;
  enabled?: unknown;
  cwd?: unknown;
}): { ok: true; mutation: EnabledModelsMutation } | { ok: false; error: string } {
  const op = body.op;
  if (op !== "models" && op !== "provider" && op !== "clear" && op !== "prune" && op !== "resync") {
    return { ok: false, error: "Invalid op" };
  }
  if (op === "models" || op === "provider") {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, error: "enabled must be a boolean" };
    }
  }
  if (body.cwd !== undefined && typeof body.cwd !== "string") {
    return { ok: false, error: "Invalid cwd" };
  }
  if (op === "resync") {
    const renames = renamePairs(body.renames);
    const modelRenames = renamePairs(body.modelRenames ?? []);
    const fullyEnabled = stringArray(body.fullyEnabled ?? []);
    if (!renames || !modelRenames || !fullyEnabled) {
      return { ok: false, error: "Invalid resync payload" };
    }
    return { ok: true, mutation: { op, renames, modelRenames, fullyEnabled } };
  }
  if (op === "provider") {
    if (typeof body.provider !== "string" || !body.provider) {
      return { ok: false, error: "provider is required" };
    }
    return { ok: true, mutation: { op, provider: body.provider, enabled: body.enabled === true } };
  }
  if (op === "models") {
    const requested = stringArray(body.refs);
    if (!requested) return { ok: false, error: "refs must be an array of strings" };
    return { ok: true, mutation: { op, refs: requested, enabled: body.enabled === true } };
  }
  return { ok: true, mutation: { op } };
}

async function failureFromBody(res: Response, fallback: string): Promise<Error> {
  let detail = "";
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      detail = body.error;
    }
    if (
      body && typeof body === "object" && "reason" in body
      && (body.reason === "last-model" || body.reason === "project-scope")
    ) {
      return new EnabledModelsRefusalError(body.reason, detail);
    }
  } catch {
    // Non-JSON error responses fall back to the HTTP status.
  }
  return new Error(detail || fallback);
}

/** The panel's switches read (the HTTP implementation; no cwd means the server default). */
export async function fetchEnabledModelsView(
  cwd?: string | null,
  signal?: AbortSignal,
): Promise<EnabledModelsView> {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
  const res = await fetch(`/api/models/enabled${query}`, signal ? { signal } : undefined);
  if (!res.ok) throw await failureFromBody(res, `HTTP ${res.status}`);
  const data = await res.json() as EnabledModelsView & { error?: string };
  if (data.error) throw new Error(data.error);
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  return data;
}

/** One serialized switch/bulk/resync write; resolves with the fresh view (the HTTP implementation). */
export async function applyEnabledModelsEdit(
  mutation: EnabledModelsMutation,
  cwd?: string | null,
): Promise<EnabledModelsView> {
  const res = await fetch("/api/models/enabled", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...mutation, ...(cwd ? { cwd } : {}) }),
  });
  if (!res.ok) throw await failureFromBody(res, `HTTP ${res.status}`);
  const data = await res.json() as EnabledModelsView & { error?: string };
  if (data.error) throw new Error(data.error);
  return data;
}
