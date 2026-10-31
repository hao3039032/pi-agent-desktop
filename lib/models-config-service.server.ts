import { readModelsConfig, writeModelsConfig } from "./models-config-store";
import { mergeStoredLiteralApiKeys } from "./models-config-redaction";

// Server callers get the whole seam surface from one module (the read and
// the write compositions, and the shared refusal).
export { ModelsConfigReadError, readRedactedModelsConfig } from "./models-config-store";

/**
 * The models-config service seam (migration M3), server half: the ONE
 * composition behind PUT /api/models-config. Both backends run this exact
 * module — the Next route (app/api/models-config/route.ts) and the
 * management instance's `modelsConfig.put` op (the esbuild projection in
 * scripts/migration/build-management-modules.mjs bundles this file). A
 * drift between them is a contract break, so the route and the extension
 * op are thin adapters, never a second copy of this logic.
 *
 * The layers underneath are unchanged: readModelsConfig/writeModelsConfig
 * (lib/models-config-store.ts — pi's read leniency, the read refusal,
 * cost normalization, the blank-row sanitize, the private atomic write)
 * and the literal-key merge (lib/models-config-redaction.ts).
 */
export function saveModelsConfig(payload: Record<string, unknown>): void {
  const existing = readModelsConfig();
  const incomingProviders = (payload.providers ?? {}) as Record<string, Record<string, unknown>>;
  const existingProviders = (existing.providers ?? {}) as Record<string, Record<string, unknown>>;
  // The client never sees stored literal apiKeys (the read redacts them),
  // so an incoming provider that omits the field must keep the stored
  // value while the user edits unrelated settings. An explicit apiKey
  // (even "") wins. A disk file this panel could not read throws
  // ModelsConfigReadError and is never replaced.
  writeModelsConfig({
    ...payload,
    providers: mergeStoredLiteralApiKeys(incomingProviders, existingProviders),
  });
}
