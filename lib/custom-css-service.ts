/**
 * The custom-css service seam (migration M3), client half:
 * user custom stylesheet read and ensure/create.
 *
 * Client-safe by construction (types + the HTTP implementations only);
 * the static build swaps this module for the IPC implementation
 * (static-frontend/src/data/custom-css-service.ts).
 */

export interface CustomCssGetResult {
  css: string;
  path?: string;
}

export interface CustomCssSetResult {
  path: string;
  created: boolean;
}

/** Load custom stylesheet text (HTTP implementation). */
export async function fetchCustomCss(): Promise<CustomCssGetResult> {
  const res = await fetch("/api/custom-css", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const css = await res.text();
  return { css };
}

/** Ensure user stylesheet exists on disk and return its path (HTTP implementation). */
export async function ensureCustomCss(): Promise<CustomCssSetResult> {
  const res = await fetch("/api/custom-css", { method: "POST" });
  if (!res.ok) throw new Error("Could not open stylesheet");
  const data = await res.json() as { path?: string; created?: boolean; error?: string };
  if (!data.path) throw new Error(data.error ?? "Missing stylesheet path");
  return { path: data.path, created: data.created === true };
}
