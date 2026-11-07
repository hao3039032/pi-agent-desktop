import { createHmac } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isDesktopApiRequestAllowed } from "./desktop-api-auth.ts";
import { isLocalRequest } from "./remote-access.ts";
import { createWebSessionToken, isValidWebSessionToken } from "./web-auth.ts";

export const DESKTOP_SESSION_COOKIE = "pi_desktop_session";

/** Whether this HTTP server was started by the desktop shell, which sets the token env. */
export function isDesktopServerProcess(): boolean {
  const token = process.env.PI_DESKTOP_API_TOKEN?.trim();
  return Boolean(token && token.length >= 32);
}

function desktopSessionKey(): string | undefined {
  const token = process.env.PI_DESKTOP_API_TOKEN?.trim();
  if (!token || token.length < 32) return undefined;
  // Domain-separated: neither the API token nor a browser cookie is a desktop cookie.
  return createHmac("sha256", token).update("pi-desktop-web-session-v1").digest("hex");
}

export function isDesktopBootstrapRequest(request: Request): boolean {
  return isLocalRequest(request) && isDesktopApiRequestAllowed(request);
}

export function isDesktopWebSession(request: NextRequest): boolean {
  const key = desktopSessionKey();
  return Boolean(key) && isLocalRequest(request)
    && isValidWebSessionToken(request.cookies.get(DESKTOP_SESSION_COOKIE)?.value, key);
}

/** Only call after token authorization; never issue this cookie for a browser password. */
export function desktopSessionResponse(body: unknown): NextResponse {
  const key = desktopSessionKey();
  if (!key) throw new Error("Desktop authorization unavailable");
  const response = NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set({
    name: DESKTOP_SESSION_COOKIE,
    value: createWebSessionToken(key),
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    // The desktop server is HTTP loopback. No Max-Age: this is a session cookie,
    // and a new desktop process token invalidates it at the next cold start.
    secure: false,
  });
  return response;
}
