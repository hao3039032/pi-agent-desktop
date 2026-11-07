import { NextResponse, type NextRequest } from "next/server";
import { getWebPassword, type WebPassword } from "@/lib/browser-password";
import { isDesktopBootstrapRequest, isDesktopWebSession, isDesktopServerProcess } from "@/lib/desktop-web-auth";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
  isListeningBeyondLoopback,
} from "@/lib/request-security";
import {
  isRemoteAccessHost,
  isLocalRequest,
  isTailscaleFunnelRequest,
  isRemoteAccessRequestAuthorized,
  readRemoteAccessConfig,
} from "@/lib/remote-access";
import { readRelayMark } from "@/lib/relay/mark";
import {
  isValidWebSessionToken,
  isValidBasicAuthorization,
  isWebPasswordEnabled,
  PI_WEB_SESSION_COOKIE,
} from "@/lib/web-auth";

function tooManyAttempts(retryAfterMs: number): NextResponse {
  return new NextResponse("Too many failed attempts", {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds(retryAfterMs)),
    },
  });
}

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  // Tailscale Funnel puts this port on the public internet. Without a web password
  // that is a shell for anyone, so refuse it however the Host header reads.
  if (isTailscaleFunnelRequest(request)) {
    let enabled = false;
    try { enabled = isWebPasswordEnabled(); } catch { /* Unreadable credentials fail closed. */ }
    if (!enabled) return new NextResponse("Pi refuses Tailscale Funnel (public) traffic. Use tailscale serve, which keeps it inside your tailnet.", {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // A paired phone's request, replayed from 127.0.0.1 by the relay connector after
  // its Noise session authenticated the device key. Host and Origin are the
  // connector's own, and device keys take the place of the web password. A mark
  // this process did not issue is refused outright.
  const relayMark = readRelayMark(request);
  if (relayMark === "forged") {
    return isApiRequest
      ? NextResponse.json({ error: "Untrusted relay request" }, { status: 403 })
      : new NextResponse("Untrusted relay request", { status: 403 });
  }
  if (relayMark) return NextResponse.next();

  if (!isTrustedRequest) {
    // The tailnet name from Settings › Remote access, reached without a Tailscale user:
    // Funnel (public) traffic, a tagged device, or a login that is not on the list.
    const remoteAccess = readRemoteAccessConfig();
    if (remoteAccess && isRemoteAccessHost(request, remoteAccess)
      && !isRemoteAccessRequestAuthorized(request, remoteAccess)) {
      return new NextResponse("Remote access needs a signed-in Tailscale device that is allowed in Pi's settings.", {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  // The Rust shell checks this non-secret instance id before creating its
  // WebView (and keeps probing it). It conveys no authentication privilege.
  if (request.nextUrl.pathname === "/api/desktop/identity"
    && (request.method === "GET" || request.method === "HEAD")
    && isLocalRequest(request)) return NextResponse.next();

  // Only native-token authenticated bootstrap/settings calls bypass the browser
  // password. Host, Origin and relay checks above still apply.
  const desktopEndpoint = request.nextUrl.pathname === "/api/desktop/auth"
    || request.nextUrl.pathname === "/api/desktop/browser-password";
  if (desktopEndpoint && isDesktopBootstrapRequest(request)) return NextResponse.next();
  if (isDesktopWebSession(request)) {
    return request.nextUrl.pathname === "/login"
      ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }

  let password: WebPassword | undefined;
  try { password = getWebPassword(); }
  catch {
    // The minimal login page can bootstrap the native window for local recovery.
    // No browser business API is opened if credentials cannot be read.
    if (request.nextUrl.pathname === "/login") return NextResponse.next();
    if (!isApiRequest) return NextResponse.redirect(new URL("/login", request.url));
    return NextResponse.json({ error: "Browser authentication configuration is unavailable" }, { status: 503 });
  }
  if (!isWebPasswordEnabled(password)) {
    // The desktop's "Allow network access" preference binds beyond loopback at
    // startup. Without a usable password that hands the whole app to anyone on
    // the network, so remote requests are refused — pages and API alike — until
    // a browser password is saved (settings require it before enabling; this
    // also covers a password removed while the preference is already on).
    // Local requests keep every path, including saving the password from the
    // native window; relay-marked traffic authenticated earlier is untouched.
    if (isDesktopServerProcess() && isListeningBeyondLoopback() && !isLocalRequest(request)) {
      return new NextResponse("Save a browser password before allowing network access.", {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (request.nextUrl.pathname === "/login") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  let authenticated = isValidWebSessionToken(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value, password);
  const authorization = isApiRequest ? request.headers.get("authorization") : null;
  if (!authenticated && authorization && /^Basic\s/i.test(authorization)) {
    // Every Basic header is a password guess, so it shares the login form's
    // throttle; otherwise any API path (or GET /api/web-auth) answers guesses
    // at full speed. While blocked even the right password is refused, or the
    // answer would leak. A success does not reset the counter: Basic clients
    // authenticate on every request, and each reset would hand an interleaved
    // guesser a fresh short block.
    const retryAfterMs = getAuthRetryAfterMs();
    if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);
    authenticated = isValidBasicAuthorization(authorization, password);
    if (!authenticated) recordAuthFailure();
  }
  if (request.nextUrl.pathname === "/login") {
    return authenticated
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }
  if (request.nextUrl.pathname === "/api/web-auth") return NextResponse.next();

  if (!authenticated) {
    if (!isApiRequest) {
      const loginUrl = new URL("/login", request.url);
      if (request.nextUrl.search) {
        loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
      }
      return NextResponse.redirect(loginUrl);
    }
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/login", "/api/:path*"] };
