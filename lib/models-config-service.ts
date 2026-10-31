/**
 * The models-config service seam (migration M3), client half: the Models
 * panel's models.json load and save. Client-safe by construction (types +
 * the HTTP implementations only); the composition itself — with the
 * literal-key redaction on the read and the literal-key merge on the write
 * — is lib/models-config-service.server.ts's readRedactedModelsConfig /
 * saveModelsConfig, the ONE implementation the Next route
 * (app/api/models-config/route.ts) and the management instance's
 * `modelsConfig.get` / `modelsConfig.put` ops both run.
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

/**
 * The Models panel's models.json save (the HTTP implementation): the whole
 * editor draft. A stored literal apiKey the redacted load never shipped is
 * merged back server-side; an unreadable disk file refuses the save
 * (the route's 409) with its message, exactly like the old inline call.
 */
export async function saveModelsConfig(draft: ModelsConfigPayload): Promise<void> {
  const res = await fetch("/api/models-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  const d = await res.json() as { success?: boolean; error?: string };
  if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
}
