/**
 * The models-config read seam (migration M3), client half: the Models
 * panel's initial `models.json` load. Client-safe by construction (types +
 * the HTTP implementation only); the read itself — with the literal-key
 * redaction — is lib/models-config-store.ts's readRedactedModelsConfig, the
 * ONE composition the Next route (app/api/models-config/route.ts) and the
 * management instance's `modelsConfig.get` op both run.
 *
 * Only the GET lives here today: the panel's Save (PUT) stays a raw route
 * call until its own op lands, so the static build's Save surfaces the
 * honest "no HTTP server" failure instead of pretending to write.
 *
 * The static build swaps this module for the IPC implementation
 * (static-frontend/src/data/models-config-service.ts).
 */

/** models.json as the editor sees it (literal apiKeys redacted server-side). */
export type ModelsConfigPayload = Record<string, unknown> & {
  providers?: Record<string, Record<string, unknown>>;
};

/** The Models panel's models.json load (the HTTP implementation). */
export async function fetchModelsConfig(): Promise<ModelsConfigPayload> {
  const res = await fetch("/api/models-config");
  const d = await res.json() as ModelsConfigPayload & { error?: string };
  if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
  return d;
}
