"use client";

/**
 * The font service seam (migration M3): font preferences get/set and
 * installed system fonts enumeration.
 * Client-safe: the Next app keeps HTTP routes (/api/appearance/fonts, /api/desktop/fonts),
 * while the static build aliases this module to static-frontend/src/data/font-service.ts
 * over the typed IPC bridge (appearance.fontsGet, appearance.fontsSet, desktop.fonts).
 */

import { isFontPreferences, type FontPreferences } from "./font-preferences.ts";
import { type InstalledFont } from "./installed-fonts.ts";

/** Read stored font preferences (the Next.js HTTP implementation). */
export async function fetchFontPreferences(): Promise<FontPreferences | null> {
  const response = await fetch("/api/appearance/fonts", {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Could not read fonts");
  const data = (await response.json()) as { fonts?: unknown };
  return isFontPreferences(data.fonts) ? data.fonts : null;
}

/** Save font preferences to settings.json (the Next.js HTTP implementation). */
export async function saveFontPreferences(fonts: FontPreferences): Promise<void> {
  const response = await fetch("/api/appearance/fonts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fonts }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Could not save fonts");
}

/** In the Next.js runtime, the IPC font service is not bound. */
export function isFontServiceBound(): boolean {
  return false;
}

/** In the Next.js runtime, delegation to static service is unavailable. */
export async function listInstalledFontsFromService(): Promise<InstalledFont[]> {
  throw new Error("Font service IPC bridge is only available in the static build");
}

/** List installed system fonts via the service bridge. */
export async function fetchInstalledFonts(): Promise<InstalledFont[]> {
  return listInstalledFontsFromService();
}
