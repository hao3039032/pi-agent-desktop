import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

// The proxy reads Settings › Remote access from the agent dir on every request.
const agentDir = mkdtempSync(join(tmpdir(), "pi-remote-proxy-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPassword = process.env.PI_WEB_PASSWORD;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_WEB_PASSWORD;
mkdirSync(join(agentDir, "pi-web"), { recursive: true });
writeFileSync(join(agentDir, "pi-web", "settings.json"), JSON.stringify({
  version: 1,
  remoteAccess: { hostname: "mac.tail1234.ts.net", logins: ["me@example.com"] },
}));
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { proxy } = await jiti.import("../proxy.ts");

const passes = (response) => response.status === 200 && response.headers.get("x-middleware-next") === "1";
const request = (path, headers) => new NextRequest(`http://127.0.0.1:38471${path}`, { headers });
const TAILNET = { Host: "mac.tail1234.ts.net" };
const ME = { "Tailscale-User-Login": "me@example.com" };

test("an allowed tailnet user reaches pages and APIs", () => {
  assert.ok(passes(proxy(request("/", { ...TAILNET, ...ME }))));
  assert.ok(passes(proxy(request("/api/agent/tasks", { ...TAILNET, ...ME }))));
});

test("the tailnet name without an allowed Tailscale user is refused", () => {
  assert.equal(proxy(request("/api/agent/tasks", TAILNET)).status, 403);
  assert.equal(proxy(request("/", TAILNET)).status, 403);
  assert.equal(proxy(request("/api/agent/tasks", { ...TAILNET, "Tailscale-User-Login": "guest@example.com" })).status, 403);
});

test("Funnel (public) traffic is refused whatever Host it carries", () => {
  for (const host of ["mac.tail1234.ts.net", "127.0.0.1:38471", "localhost"]) {
    const response = proxy(request("/api/agent/tasks", { Host: host, ...ME, "Tailscale-Funnel-Request": "?1" }));
    assert.equal(response.status, 403, host);
  }
});

test("a cross-site page on the phone cannot drive the API through the tailnet name", () => {
  const response = proxy(new NextRequest("http://127.0.0.1:38471/api/agent/x", {
    method: "POST",
    headers: { ...TAILNET, ...ME, Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  }));
  assert.equal(response.status, 403);
});

test("local requests keep working", () => {
  assert.ok(passes(proxy(request("/api/agent/tasks", { Host: "localhost:38471" }))));
});

// Serve routes by TLS SNI and forwards the client's Host as is, and Next keeps the
// X-Forwarded-For that Serve set (the visitor's tailnet address). A loopback-bound
// server never sees another machine directly, so a non-loopback XFF means a proxy.
test("a tailnet device spoofing a loopback or IP Host through Serve is refused", () => {
  for (const host of ["127.0.0.1:38471", "localhost", "100.101.102.103", "[::1]:38471"]) {
    const response = proxy(request("/api/agent/tasks", { Host: host, "X-Forwarded-For": "100.64.0.7" }));
    assert.equal(response.status, 403, host);
  }
  // A tagged device: no identity header at all.
  assert.equal(proxy(request("/api/agent/tasks", { Host: "mac.tail1234.ts.net", "X-Forwarded-For": "fd7a:115c:a1e0::9" })).status, 403);
});

test("an operator-listed host does not bypass the Tailscale check for the tailnet name", () => {
  process.env.PI_WEB_ALLOWED_HOSTS = "mac.tail1234.ts.net";
  try {
    assert.equal(proxy(request("/api/agent/tasks", { ...TAILNET, "X-Forwarded-For": "100.64.0.7" })).status, 403);
    assert.ok(passes(proxy(request("/api/agent/tasks", { ...TAILNET, ...ME, "X-Forwarded-For": "100.64.0.7" }))));
  } finally {
    delete process.env.PI_WEB_ALLOWED_HOSTS;
  }
});

test("this computer's own requests still pass (Next sets XFF to the loopback socket)", () => {
  assert.ok(passes(proxy(request("/api/agent/tasks", { Host: "127.0.0.1:38471", "X-Forwarded-For": "127.0.0.1" }))));
  assert.ok(passes(proxy(request("/api/agent/tasks", { Host: "localhost:38471", "X-Forwarded-For": "::1" }))));
});

// --- The desktop's "Allow network access" without a usable browser password ---

const savedDesktopEnv = {
  token: process.env.PI_DESKTOP_API_TOKEN,
  hostname: process.env.PI_WEB_HOSTNAME,
  allowed: process.env.PI_WEB_ALLOWED_HOSTS,
};
function restoreDesktopEnv() {
  for (const [name, value] of Object.entries({ PI_DESKTOP_API_TOKEN: savedDesktopEnv.token, PI_WEB_HOSTNAME: savedDesktopEnv.hostname, PI_WEB_ALLOWED_HOSTS: savedDesktopEnv.allowed })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
const REMOTE_LAN = { Host: "192.168.1.20:38471" };

test("a network-listening desktop server without a password refuses remote requests, local ones keep working", () => {
  try {
    process.env.PI_DESKTOP_API_TOKEN = "t".repeat(48);
    process.env.PI_WEB_HOSTNAME = "0.0.0.0";
    delete process.env.PI_WEB_ALLOWED_HOSTS;
    for (const path of ["/", "/api/agent/tasks", "/login"]) {
      assert.equal(proxy(request(path, REMOTE_LAN)).status, 403, path);
    }
    // This computer keeps every path, including saving the password from the native window.
    assert.ok(passes(proxy(request("/api/agent/tasks", { Host: "127.0.0.1:38471" }))));
    assert.ok(passes(proxy(request("/", { Host: "localhost:38471" }))));
  } finally {
    restoreDesktopEnv();
  }
});

test("a non-desktop server keeps the operator's no-password policy on the same bind", () => {
  try {
    delete process.env.PI_DESKTOP_API_TOKEN;
    process.env.PI_WEB_HOSTNAME = "0.0.0.0";
    delete process.env.PI_WEB_ALLOWED_HOSTS;
    assert.ok(passes(proxy(request("/api/agent/tasks", REMOTE_LAN))));
    assert.ok(passes(proxy(request("/", REMOTE_LAN))));
  } finally {
    restoreDesktopEnv();
  }
});

test("a saved browser password restores the normal authentication paths on the desktop bind", () => {
  const verifier = join(agentDir, "pi-web", "browser-password.json");
  writeFileSync(verifier, JSON.stringify({ version: 1, salt: "a".repeat(32), hash: "b".repeat(64) }));
  try {
    process.env.PI_DESKTOP_API_TOKEN = "t".repeat(48);
    process.env.PI_WEB_HOSTNAME = "0.0.0.0";
    delete process.env.PI_WEB_ALLOWED_HOSTS;
    assert.equal(proxy(request("/api/agent/tasks", REMOTE_LAN)).status, 401, "remote API requests are asked to authenticate");
    const page = proxy(request("/", REMOTE_LAN));
    assert.equal(page.status, 307, "remote pages are sent to the login form");
    assert.ok(page.headers.get("location")?.endsWith("/login"), "redirects to the login form");
    // Local browsers share the same password rule (unchanged); the native window
    // authenticated earlier through its desktop session cookie.
    assert.equal(proxy(request("/api/agent/tasks", { Host: "127.0.0.1:38471" })).status, 401);
  } finally {
    restoreDesktopEnv();
    rmSync(verifier, { force: true });
  }
});
