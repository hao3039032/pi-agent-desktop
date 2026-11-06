import { NextResponse } from "next/server";
import { desktopSessionResponse, isDesktopBootstrapRequest } from "@/lib/desktop-web-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isDesktopBootstrapRequest(request)) {
    return NextResponse.json({ error: "Desktop authorization required" }, { status: 403 });
  }
  return desktopSessionResponse({ ok: true });
}
