import { stat } from "fs/promises";
import { resolve } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { loadScopedModelsData } from "@/lib/models-service.server";

export const dynamic = "force-dynamic";

// GET /api/models  body: none, ?cwd= selects the model scope (default: the
// server process cwd). The answer's composition lives in lib/models-service.server.ts
// (the models seam) — the SAME function the management instance's models.list
// op runs; this route is only the HTTP adapter (request parsing + the
// allow-list, then the cached composition).
export async function GET(req: Request) {
  const requestedCwd = new URL(req.url).searchParams.get("cwd") || process.cwd();
  const cwd = resolve(requestedCwd);

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

  return Response.json(await loadScopedModelsData(cwd));
}
