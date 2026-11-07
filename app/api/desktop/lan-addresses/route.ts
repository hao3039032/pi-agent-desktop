import { NextResponse } from "next/server";
import { isDesktopBootstrapRequest } from "@/lib/desktop-web-auth";
import { desktopLanAddressStatus } from "@/lib/lan-addresses";

export const dynamic = "force-dynamic";

/**
 * Which of this computer's addresses the running server can be reached on, for
 * the desktop settings' LAN URL list. Local + desktop token only, like the
 * other /api/desktop routes: the answer names this machine's network adapters
 * and must not go to a remote browser.
 */
export async function GET(request: Request) {
  if (!isDesktopBootstrapRequest(request)) {
    return NextResponse.json({ error: "Desktop authorization required" }, { status: 403 });
  }
  return NextResponse.json(
    desktopLanAddressStatus(request.headers.get("host")),
    { headers: { "Cache-Control": "no-store" } },
  );
}
