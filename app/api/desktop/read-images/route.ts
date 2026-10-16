import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { isWindowsAbsolutePath } from "@/lib/file-access";
import { getImageMime } from "@/lib/file-types";
import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  MAX_ATTACHED_IMAGE_SELECTION_BYTES,
} from "@/lib/image-attachments";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { isDesktopApiRequestAllowed } from "@/lib/desktop-api-auth";

export const runtime = "nodejs";

// Must match the composer's cap, otherwise a selection the UI considers valid
// is rejected here after the user already picked the files.
const MAX_FILES = MAX_ATTACHED_IMAGES;
const MAX_PATHS_JSON_BYTES = 64 * 1024;

function resolveAbsolutePath(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const useWindows = isWindowsAbsolutePath(trimmed);
  const resolver = useWindows ? path.win32 : path;
  if (!resolver.isAbsolute(trimmed)) return null;
  return resolver.resolve(trimmed);
}

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
      return NextResponse.json({ error: "No files selected" }, { status: 400 });
    }
    if (body.paths.length > MAX_FILES) {
      return NextResponse.json({ error: `Select at most ${MAX_FILES} images` }, { status: 400 });
    }

    const files: Array<{ name: string; mimeType: string; data: string }> = [];
    let totalBytes = 0;
    for (const rawPath of body.paths) {
      const filePath = resolveAbsolutePath(rawPath);
      if (!filePath) {
        return NextResponse.json({ error: `Invalid path: ${rawPath}` }, { status: 400 });
      }

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(filePath);
      } catch {
        return NextResponse.json({ error: `File not found: ${path.basename(filePath)}` }, { status: 404 });
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return NextResponse.json({ error: `Not a regular file: ${path.basename(filePath)}` }, { status: 400 });
      }
      if (stat.size > MAX_ATTACHED_IMAGE_BYTES) {
        return NextResponse.json(
          { error: `Each image must be ${MAX_ATTACHED_IMAGE_BYTES / (1024 * 1024)}MB or smaller` },
          { status: 413 },
        );
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_ATTACHED_IMAGE_SELECTION_BYTES) {
        return NextResponse.json(
          { error: `Selected images must total ${MAX_ATTACHED_IMAGE_SELECTION_BYTES / (1024 * 1024)}MB or less` },
          { status: 413 },
        );
      }

      const mimeType = getImageMime(filePath);
      if (!mimeType) {
        return NextResponse.json({ error: `Not an image: ${path.basename(filePath)}` }, { status: 400 });
      }

      const data = fs.readFileSync(filePath).toString("base64");
      files.push({
        name: path.basename(filePath),
        mimeType,
        data,
      });
    }

    return NextResponse.json({ files });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Image selection is too large" }, { status: 413 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
