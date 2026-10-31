/**
 * The IPC-backed font service (the static build's alias target for
 * lib/font-service.ts): font preferences read/write and installed
 * system font enumeration travel the typed IPC bridge
 * (appearance.fontsGet, appearance.fontsSet, desktop.fonts over pi_ipc)
 * instead of /api/appearance/fonts and /api/desktop/fonts.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import { isFontPreferences, type FontPreferences } from "../../../lib/font-preferences";
import { normalizeInstalledFonts, type InstalledFont } from "../../../lib/installed-fonts";

let client: IpcClient | null = null;

export function bindFontService(bound: IpcClient): void {
  client = bound;
}

export function isFontServiceBound(): boolean {
  return client !== null;
}

function ensureClient(): IpcClient {
  if (client === null) {
    throw new Error("the font service IPC bridge is not configured (bindFontService)");
  }
  return client;
}

function toError(failure: IpcFailure, fallback: string): Error {
  return new Error(failure.error.message || fallback);
}

/** Read stored font preferences (the IPC implementation). */
export async function fetchFontPreferences(): Promise<FontPreferences | null> {
  try {
    const data = await ensureClient().request<{ fonts?: unknown }>(
      "appearance.fontsGet",
      undefined,
      { timeoutMs: 10_000 },
    );
    return isFontPreferences(data.fonts) ? data.fonts : null;
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Could not read fonts");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Save font preferences to settings.json (the IPC implementation). */
export async function saveFontPreferences(fonts: FontPreferences): Promise<void> {
  try {
    await ensureClient().request<{ fonts?: unknown }>(
      "appearance.fontsSet",
      { fonts },
      { timeoutMs: 10_000 },
    );
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Could not save fonts");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** List installed system fonts (the IPC implementation). */
export async function listInstalledFontsFromService(): Promise<InstalledFont[]> {
  try {
    const data = await ensureClient().request<{ fonts?: unknown }>(
      "desktop.fonts",
      undefined,
      { timeoutMs: 25_000 },
    );
    const fonts = normalizeInstalledFonts(data.fonts);
    if (!fonts.length) throw new Error("No installed fonts found");
    return fonts;
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Could not read installed fonts");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** In the static build, fetchInstalledFonts routes to listInstalledFontsFromService. */
export async function fetchInstalledFonts(): Promise<InstalledFont[]> {
  return listInstalledFontsFromService();
}
