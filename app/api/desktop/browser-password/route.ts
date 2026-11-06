import { NextResponse } from "next/server";
import { desktopSessionResponse, isDesktopBootstrapRequest } from "@/lib/desktop-web-auth";
import { hasJsonContentType } from "@/lib/request-security";
import {
  MAX_BROWSER_PASSWORD_LENGTH, MIN_BROWSER_PASSWORD_LENGTH,
  readBrowserPassword, removeBrowserPassword, writeBrowserPassword,
} from "@/lib/browser-password";
import { recordAuthSuccess } from "@/lib/auth-throttle";

export const dynamic = "force-dynamic";

function denied(request: Request): NextResponse | null {
  return isDesktopBootstrapRequest(request) ? null
    : NextResponse.json({ error: "Desktop authorization required" }, { status: 403 });
}

export async function GET(request: Request) {
  const refusal = denied(request);
  if (refusal) return refusal;
  const managed = Boolean(process.env.PI_WEB_PASSWORD);
  try {
    return NextResponse.json({ enabled: managed || Boolean(readBrowserPassword()), managed, corrupt: false }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // Keep recovery available from the native window even if the file is damaged.
    return NextResponse.json({ enabled: true, managed, corrupt: true }, { headers: { "Cache-Control": "no-store" } });
  }
}

export async function PUT(request: Request) {
  const refusal = denied(request);
  if (refusal) return refusal;
  if (process.env.PI_WEB_PASSWORD) return NextResponse.json({ error: "Password is managed by PI_WEB_PASSWORD" }, { status: 409 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "JSON required" }, { status: 415 });
  // Bounded body; a native token is still mandatory before parsing any secret.
  const reader = request.body?.getReader();
  if (!reader) return NextResponse.json({ error: "Password required" }, { status: 400 });
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 8192) { await reader.cancel(); return NextResponse.json({ error: "Body too large" }, { status: 413 }); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  const body = (() => { try { return JSON.parse(text); } catch { return null; } })() as { password?: unknown } | null;
  if (typeof body?.password !== "string" || body.password.length < MIN_BROWSER_PASSWORD_LENGTH || body.password.length > MAX_BROWSER_PASSWORD_LENGTH) {
    return NextResponse.json({ error: "Password must contain 12–1024 characters" }, { status: 400 });
  }
  try {
    writeBrowserPassword(body.password);
    recordAuthSuccess();
    return desktopSessionResponse({ enabled: true, managed: false, corrupt: false });
  } catch {
    return NextResponse.json({ error: "Could not save browser password" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const refusal = denied(request);
  if (refusal) return refusal;
  if (process.env.PI_WEB_PASSWORD) return NextResponse.json({ error: "Password is managed by PI_WEB_PASSWORD" }, { status: 409 });
  try {
    removeBrowserPassword();
    recordAuthSuccess();
    return desktopSessionResponse({ enabled: false, managed: false, corrupt: false });
  } catch {
    return NextResponse.json({ error: "Could not remove browser password" }, { status: 500 });
  }
}
