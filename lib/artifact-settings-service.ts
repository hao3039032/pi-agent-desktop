/**
 * The artifacts settings service seam (migration M3), client half:
 * prompt switch for artifacts.
 *
 * Client-safe by construction (types + the HTTP implementations only);
 * the static build swaps this module for the IPC implementation
 * (static-frontend/src/data/artifact-settings-service.ts).
 */

export interface ArtifactsSettingsResponse {
  enabled: boolean;
}

/** Load artifacts prompt setting (HTTP implementation). */
export async function fetchArtifactsSettings(): Promise<ArtifactsSettingsResponse> {
  const res = await fetch("/api/artifacts/settings");
  const data = await res.json() as ArtifactsSettingsResponse & { error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return { enabled: data.enabled !== false };
}

/** Save artifacts prompt setting (HTTP implementation). */
export async function saveArtifactsSettings(enabled: boolean): Promise<ArtifactsSettingsResponse> {
  const res = await fetch("/api/artifacts/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
    cache: "no-store",
  });
  const data = await res.json() as ArtifactsSettingsResponse & { error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return { enabled: data.enabled !== false };
}
