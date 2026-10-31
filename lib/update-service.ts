import type { AppUpdatesResponse } from "@/lib/app-update-types";

export async function checkAppUpdates(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<AppUpdatesResponse> {
  const response = await fetch(options.refresh ? "/api/updates?refresh=1" : "/api/updates", { cache: "no-store", signal: options.signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<AppUpdatesResponse>;
}
