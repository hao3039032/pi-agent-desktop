import { stat } from "fs/promises";
import { resolve } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  applyEnabledModelsEdit,
  EnabledModelsRefusalError,
  loadEnabledModelsView,
  parseEnabledModelsMutation,
} from "@/lib/enabled-models-service.server";
import type { EnabledModelsView } from "@/lib/enabled-models";

export const dynamic = "force-dynamic";

interface EnabledModelsRequest {
  cwd?: unknown;
  op?: unknown;
  provider?: unknown;
  refs?: unknown;
  renames?: unknown;
  modelRenames?: unknown;
  fullyEnabled?: unknown;
  enabled?: unknown;
}

/**
 * Resolve the cwd whose project settings decide whether the global value is
 * shadowed. It is only read, never written, but it still points at a settings
 * file, so it goes through the same allow-list as `/api/files`.
 */
async function resolveCwd(raw: string | null): Promise<{ cwd: string } | { error: Response }> {
  if (!raw) return { cwd: process.cwd() };
  const cwd = resolve(raw);
  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return { error: Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 }) };
  }
  if (!cwdStat.isDirectory()) {
    return { error: Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 }) };
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { error: Response.json({ error: "Access denied" }, { status: 403 }) };
  }
  return { cwd };
}

// GET /api/models/enabled — the Models panel's switches. The composition
// lives in lib/enabled-models-service.server.ts (the enabledModels seam) —
// the SAME functions the management instance's models.enabledGet /
// models.enabledSet ops run; this route is only the HTTP adapter (request
// parsing + the allow-list).
export async function GET(req: Request) {
  const resolved = await resolveCwd(new URL(req.url).searchParams.get("cwd"));
  if ("error" in resolved) return resolved.error;

  try {
    return Response.json(await loadEnabledModelsView(resolved.cwd));
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

// PUT /api/models/enabled — one serialized mutation of the global
// `enabledModels`. Field validation is the seam's shared parse
// (parseEnabledModelsMutation); the write path is the seam's
// applyEnabledModelsEdit; this route maps the shaped refusals to their 409s.
export async function PUT(req: Request) {
  let body: EnabledModelsRequest;
  try {
    body = await req.json() as EnabledModelsRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseEnabledModelsMutation(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const resolved = await resolveCwd(typeof body.cwd === "string" ? body.cwd : null);
  if ("error" in resolved) return resolved.error;

  try {
    const view: EnabledModelsView = await applyEnabledModelsEdit(resolved.cwd, parsed.mutation);
    return Response.json(view);
  } catch (error) {
    if (error instanceof EnabledModelsRefusalError) {
      return Response.json({ error: error.message, reason: error.reason }, { status: 409 });
    }
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
