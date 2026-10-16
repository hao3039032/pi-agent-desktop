import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { openWidgetWindow } from "@/lib/widget-window";

export const dynamic = "force-dynamic";

/** Matches the widget_code cap the tool schema implies; keeps requests bounded. */
const MAX_WIDGET_CODE_BYTES = 2 * 1024 * 1024;

interface WidgetOpenBody {
  code?: unknown;
  title?: unknown;
  width?: unknown;
  height?: unknown;
  isSVG?: unknown;
}

/**
 * POST { code, title?, width?, height?, isSVG? } — pop a widget out into a
 * native window (glimpseui). Auth follows every other /api route: loopback
 * binding plus the optional web password handled by proxy.ts.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: WidgetOpenBody;
  try {
    body = await req.json() as WidgetOpenBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { code } = body;
  if (typeof code !== "string" || code.length === 0) {
    return NextResponse.json({ error: "code must be a non-empty string" }, { status: 400 });
  }
  if (Buffer.byteLength(code, "utf8") > MAX_WIDGET_CODE_BYTES) {
    return NextResponse.json({ error: "code exceeds the 2MB limit" }, { status: 400 });
  }
  const { title, width, height, isSVG } = body;
  try {
    await openWidgetWindow({
      code,
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof width === "number" && Number.isFinite(width) ? { width } : {}),
      ...(typeof height === "number" && Number.isFinite(height) ? { height } : {}),
      ...(typeof isSVG === "boolean" ? { isSVG } : {}),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
