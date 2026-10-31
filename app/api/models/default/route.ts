import { stat } from "fs/promises";
import { resolve } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  ModelNotAvailableError,
  ProjectScopeShadowError,
  parseDefaultPreferencesEdit,
  saveScopedDefaultPreferences,
} from "@/lib/models-service.server";

export const dynamic = "force-dynamic";

interface DefaultPreferencesRequest {
  cwd?: unknown;
  provider?: unknown;
  modelId?: unknown;
  thinkingLevel?: unknown;
}

/**
 * Save the model and/or reasoning level new sessions start with.
 *
 * Picking a model for one chat is session-scoped, as in the TUI; this is the
 * explicit "save as default" behind the selectors' star. The cwd decides which
 * project settings could shadow the global value and which models are in scope,
 * so it goes through the same allow-list as `/api/models`.
 *
 * The write path itself lives in lib/models-service.server.ts (the models seam) — the
 * SAME function the management instance's models.setDefault op runs; this route
 * is the HTTP adapter (body parsing, the allow-list, the status mapping).
 */
export async function PUT(req: Request) {
  let body: DefaultPreferencesRequest;
  try {
    body = await req.json() as DefaultPreferencesRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const edit = parseDefaultPreferencesEdit(body);
  if (!edit) {
    return Response.json({ error: "Expected provider and modelId, or a valid thinkingLevel" }, { status: 400 });
  }

  const cwd = resolve(typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd());
  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const parsed = await saveScopedDefaultPreferences(cwd, edit);
    return Response.json({
      ok: true,
      ...(parsed.model ? { defaultModel: parsed.model } : {}),
      ...(parsed.thinkingLevel ? { defaultThinkingLevel: parsed.thinkingLevel } : {}),
    });
  } catch (error) {
    if (error instanceof ProjectScopeShadowError) {
      return Response.json({
        error: error.message,
        reason: "project-scope",
        settingsPath: error.settingsPath,
        keys: error.keys,
      }, { status: 409 });
    }
    if (error instanceof ModelNotAvailableError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
