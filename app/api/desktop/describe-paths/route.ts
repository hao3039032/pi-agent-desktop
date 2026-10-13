import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { isWindowsAbsolutePath } from "@/lib/file-access";
import { getImageMime } from "@/lib/file-types";
import { MAX_IMPORT_FILES } from "@/lib/file-upload";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { isDesktopApiRequestAllowed } from "@/lib/desktop-api-auth";

export const runtime = "nodejs";

// A single OS drag can contain many items, but only the import step has a
// per-file cap — align with it (MAX_IMPORT_FILES) so a classified drop is
// never wider than what `/api/files?type=import` accepts.
const MAX_PATHS = MAX_IMPORT_FILES;
const MAX_PATHS_JSON_BYTES = 64 * 1024;

function resolveAbsolutePath(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const useWindows = isWindowsAbsolutePath(trimmed);
  const resolver = useWindows ? path.win32 : path;
  if (!resolver.isAbsolute(trimmed)) return null;
  return resolver.resolve(trimmed);
}

/**
 * Describe absolute paths dragged onto the desktop window so the UI can route
 * them: directories become absolute-path mentions, image files become
 * attachments, other files are copied into the project. Like the other
 * desktop-only endpoints, arbitrary absolute paths are accepted because they
 * were provided by the OS drag/drop in the packaged shell, guarded by the
 * per-process desktop token.
 */
export async function POST(request: NextRequest) {
  if (!isDesktopApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Desktop authorization required" }, { status: 403 });
  }

  try {
    const body = await parseJsonWithinLimit(request, MAX_PATHS_JSON_BYTES) as { paths?: unknown } | null;
    if (!Array.isArray(body?.paths) || !body.paths.every((item) => typeof item === "string")) {
      return NextResponse.json({ error: "paths must be an array of strings" }, { status: 400 });
    }
    if (body.paths.length === 0) {
      return NextResponse.json({ error: "No paths given" }, { status: 400 });
    }
    if (body.paths.length > MAX_PATHS) {
      return NextResponse.json({ error: `At most ${MAX_PATHS} paths` }, { status: 400 });
    }

    const items = body.paths.map((rawPath) => {
      const resolved = resolveAbsolutePath(rawPath);
      if (!resolved) return { path: rawPath, kind: "other" as const };
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(resolved);
      } catch {
        return { path: resolved, kind: "missing" as const };
      }
      // Symlinks are refused by the read-images and import endpoints alike;
      // reporting them as "other" keeps that policy visible to the drop flow.
      if (stat.isSymbolicLink()) return { path: resolved, kind: "other" as const };
      if (stat.isDirectory()) return { path: resolved, kind: "directory" as const };
      if (!stat.isFile()) return { path: resolved, kind: "other" as const };
      return {
        path: resolved,
        kind: "file" as const,
        imageMime: getImageMime(resolved) ?? undefined,
        size: stat.size,
      };
    });

    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Path list is too large" }, { status: 413 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
