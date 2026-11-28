import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { getGlobalSettingsPath, readGlobalSettings, updateGlobalSettings } from "@/lib/global-settings-file";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { TRANSCRIPT_NOTICE_SETTING_KEYS } from "@/lib/transcript-notices";

export const dynamic = "force-dynamic";

// Settings › General's switch for pi's own transcript notices (#1265), in the
// global settings.json under the lock pi's SettingsManager takes: one key per
// notice under `notices` since pi 1.6.1 (cacheMisses, cacheWarming,
// compactionCosts, reasoningDrops; previously the single `showCacheMissNotices`,
// which pi migrates into the four keys and drops on its next save). The switch
// stands for all four together, as the old key did. Off is pi's default, so
// turning it off removes the keys. A project's .pi/settings.json still
// overrides it per key, as in pi.

function noticesOf(settings: Record<string, unknown>): Record<string, unknown> {
  const notices = settings.notices;
  return typeof notices === "object" && notices !== null && !Array.isArray(notices)
    ? (notices as Record<string, unknown>)
    : {};
}

function allOn(settings: Record<string, unknown>): boolean {
  const notices = noticesOf(settings);
  return TRANSCRIPT_NOTICE_SETTING_KEYS.every((key) => {
    // pi 1.7 resolves each key independently: an explicit boolean wins over
    // the legacy switch, which fills only keys the file does not set.
    const value = notices[key];
    return typeof value === "boolean" ? value : settings.showCacheMissNotices === true;
  });
}

async function readEnabled(): Promise<boolean> {
  return readGlobalSettings(getGlobalSettingsPath(), allOn);
}

function errorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

export async function GET() {
  try {
    return NextResponse.json({ enabled: await readEnabled() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  try {
    // Off with no settings file is already pi's default: nothing to create.
    if (!enabled && !existsSync(getGlobalSettingsPath())) return NextResponse.json({ enabled: false });
    await updateGlobalSettings(getGlobalSettingsPath(), (settings) => {
      // The migrated key would otherwise bring every notice back the next
      // time pi loads a file whose `notices` keys were removed.
      delete settings.showCacheMissNotices;
      if (enabled) {
        settings.notices = { ...noticesOf(settings), ...Object.fromEntries(TRANSCRIPT_NOTICE_SETTING_KEYS.map((key) => [key, true])) };
        return;
      }
      const notices = { ...noticesOf(settings) };
      for (const key of TRANSCRIPT_NOTICE_SETTING_KEYS) delete notices[key];
      if (Object.keys(notices).length === 0) delete settings.notices;
      else settings.notices = notices;
    });
    return NextResponse.json({ enabled: await readEnabled() });
  } catch (error) {
    return errorResponse(error);
  }
}
