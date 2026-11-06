import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const dir = mkdtempSync(join(tmpdir(), "pi-browser-auth-"));
const keys = ["PI_CODING_AGENT_DIR", "PI_WEB_PASSWORD", "PI_DESKTOP_API_TOKEN", "PI_WEB_HOSTNAME"];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_DESKTOP_API_TOKEN = "a".repeat(64);
process.env.PI_WEB_HOSTNAME = "0.0.0.0";
delete process.env.PI_WEB_PASSWORD;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const store = await jiti.import("./browser-password.ts");
const auth = await jiti.import("./web-auth.ts");
const { proxy } = await jiti.import("../proxy.ts");
const bootstrap = await jiti.import("../app/api/desktop/auth/route.ts");
const settings = await jiti.import("../app/api/desktop/browser-password/route.ts");
const login = await jiti.import("../app/api/web-auth/route.ts");
const { recordAuthSuccess } = await jiti.import("./auth-throttle.ts");
const { isCredentialPath } = await jiti.import("./credential-paths.ts");
const nativeHeaders = { "x-pi-desktop-token": "a".repeat(64) };

function req(path, { method = "GET", headers = {}, body } = {}) {
  return new NextRequest(`http://127.0.0.1:38471${path}`, {
    method, headers: { host: "127.0.0.1:38471", "x-forwarded-for": "127.0.0.1", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function cookie(response) { return response.headers.get("set-cookie").split(";", 1)[0]; }
beforeEach(() => { store.removeBrowserPassword(); delete process.env.PI_WEB_PASSWORD; recordAuthSuccess(); });
after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } rmSync(dir, { recursive: true, force: true }); recordAuthSuccess(); });

test("stored password is salted/private and resets revoke old cookies even for the same password", () => {
  const password = "a long new password";
  store.writeBrowserPassword(password);
  const first = store.readBrowserPassword();
  assert.equal(readFileSync(store.browserPasswordPath(), "utf8").includes(password), false);
  assert.equal(isCredentialPath(store.browserPasswordPath()), true, "custom agent directory still protects the verifier");
  if (process.platform !== "win32") assert.equal(statSync(store.browserPasswordPath()).mode & 0o777, 0o600);
  assert.equal(auth.isValidWebPassword(password), true);
  assert.equal(auth.isValidWebPassword("wrong"), false);
  assert.equal(auth.isValidBasicAuthorization(`Basic ${Buffer.from(`pi:${password}`).toString("base64")}`), true);
  const token = auth.createWebSessionToken(first);
  assert.equal(auth.isValidWebSessionToken(token), true);
  store.writeBrowserPassword(password);
  assert.notDeepEqual(store.readBrowserPassword(), first);
  assert.equal(auth.isValidWebSessionToken(token), false);
});

test("ordinary local and LAN browsers require login; native token issues a separate desktop cookie", async () => {
  store.writeBrowserPassword("a long new password");
  assert.equal(proxy(req("/")).status, 307);
  assert.equal(proxy(req("/api/sessions")).status, 401);
  assert.equal(proxy(req("/api/desktop/identity")).status, 200, "pre-WebView startup/health probe stays reachable");
  assert.equal(proxy(req("/api/desktop/identity", { headers: { host: "192.168.1.2:38471", "x-forwarded-for": "192.168.1.50" } })).status, 401);
  assert.equal(proxy(req("/api/sessions", { headers: { host: "192.168.1.2:38471", "x-forwarded-for": "192.168.1.50" } })).status, 401);
  const request = req("/api/desktop/auth", { method: "POST", headers: nativeHeaders });
  assert.equal(proxy(request).status, 200);
  const result = await bootstrap.POST(request);
  assert.equal(result.status, 200);
  assert.match(result.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(result.headers.get("set-cookie"), /SameSite=strict/i);
  const desktopCookie = cookie(result);
  assert.equal(proxy(req("/", { headers: { cookie: desktopCookie } })).status, 200);
  assert.equal(proxy(req("/login", { headers: { cookie: desktopCookie } })).status, 307);
  assert.equal(proxy(req("/api/sessions", { headers: { cookie: desktopCookie, origin: "http://evil.test" } })).status, 403);
  assert.equal(proxy(req("/api/sessions", { headers: { cookie: `pi_web_session=${desktopCookie.split("=")[1]}` } })).status, 401);
  const nativeStatus = await login.GET(req("/api/web-auth", { headers: { cookie: desktopCookie } }));
  assert.deepEqual(await nativeStatus.json(), { enabled: false, authenticated: true, desktop: true });
  assert.equal(proxy(req("/api/sessions", { headers: { host: "192.168.1.2:38471", "x-forwarded-for": "192.168.1.50", cookie: desktopCookie } })).status, 401);
  process.env.PI_DESKTOP_API_TOKEN = "b".repeat(64);
  assert.equal(proxy(req("/api/sessions", { headers: { cookie: desktopCookie } })).status, 401);
  process.env.PI_DESKTOP_API_TOKEN = "a".repeat(64);
});

test("bootstrap and password management reject browsers, foreign origins, forwarded and relay requests", async () => {
  for (const headers of [{}, { "x-pi-desktop-token": "wrong" }, { ...nativeHeaders, origin: "http://evil.test" }, { ...nativeHeaders, "x-forwarded-for": "192.168.1.50" }, { ...nativeHeaders, "x-pi-relay-mark": "fake" }, { ...nativeHeaders, "tailscale-user-login": "user@example.com" }]) {
    assert.equal((await bootstrap.POST(req("/api/desktop/auth", { method: "POST", headers }))).status, 403);
    assert.equal((await settings.GET(req("/api/desktop/browser-password", { headers }))).status, 403);
    assert.equal((await settings.DELETE(req("/api/desktop/browser-password", { method: "DELETE", headers }))).status, 403);
  }
});

test("native reset immediately revokes browser sessions and works without the old password", async () => {
  store.writeBrowserPassword("old browser password");
  const loggedIn = await login.POST(req("/api/web-auth", { method: "POST", headers: { "content-type": "application/json" }, body: { password: "old browser password" } }));
  assert.equal(loggedIn.status, 200);
  const browserCookie = cookie(loggedIn);
  assert.equal(proxy(req("/api/sessions", { headers: { cookie: browserCookie } })).status, 200);
  assert.equal((await settings.PUT(req("/api/desktop/browser-password", { method: "PUT", headers: { cookie: browserCookie, "content-type": "application/json" }, body: { password: "attacker password" } }))).status, 403);
  const reset = await settings.PUT(req("/api/desktop/browser-password", { method: "PUT", headers: { ...nativeHeaders, "content-type": "application/json" }, body: { password: "new browser password" } }));
  assert.equal(reset.status, 200);
  assert.equal(proxy(req("/api/sessions", { headers: { cookie: browserCookie } })).status, 401);
  assert.equal(proxy(req("/api/sessions", { headers: { cookie: cookie(reset) } })).status, 200);
  assert.equal(auth.isValidWebPassword("new browser password"), true);
  assert.equal(auth.isValidWebPassword("old browser password"), false);
});

test("corrupt password config fails closed but native recovery remains reachable", async () => {
  store.writeBrowserPassword("valid browser password");
  writeFileSync(store.browserPasswordPath(), "{bad json");
  assert.throws(() => store.getWebPassword());
  assert.equal(proxy(req("/api/sessions")).status, 503);
  assert.equal(proxy(req("/")).status, 307);
  assert.equal(proxy(req("/login")).status, 200);
  assert.equal(proxy(req("/api/desktop/identity")).status, 200, "a corrupt password must not prevent the shell from reaching recovery UI");
  const request = req("/api/desktop/auth", { method: "POST", headers: nativeHeaders });
  assert.equal(proxy(request).status, 200);
  const result = await bootstrap.POST(request);
  assert.equal(proxy(req("/", { headers: { cookie: cookie(result) } })).status, 200);
  const status = await settings.GET(req("/api/desktop/browser-password", { headers: nativeHeaders }));
  assert.equal((await status.json()).corrupt, true);
  assert.equal((await settings.DELETE(req("/api/desktop/browser-password", { method: "DELETE", headers: nativeHeaders }))).status, 200);
  assert.equal(proxy(req("/")).status, 200);
});

test("environment password takes precedence and cannot be overwritten from settings", async () => {
  process.env.PI_WEB_PASSWORD = "operator password";
  store.writeBrowserPassword("stored browser password");
  assert.equal(auth.isValidWebPassword("operator password"), true);
  assert.equal(auth.isValidWebPassword("stored browser password"), false);
  const request = req("/api/desktop/browser-password", { method: "DELETE", headers: nativeHeaders });
  assert.equal((await settings.DELETE(request)).status, 409);
  assert.equal((await settings.PUT(req("/api/desktop/browser-password", { method: "PUT", headers: nativeHeaders }))).status, 409);
});

test("settings reject malformed/oversized input and never return verifier material", async () => {
  const path = "/api/desktop/browser-password";
  assert.equal((await settings.PUT(req(path, { method: "PUT", headers: nativeHeaders, body: { password: "valid browser password" } }))).status, 415);
  const headers = { ...nativeHeaders, "content-type": "application/json" };
  for (const password of ["short", "x".repeat(1025), null]) {
    assert.equal((await settings.PUT(req(path, { method: "PUT", headers, body: { password } }))).status, 400);
  }
  assert.equal((await settings.PUT(req(path, { method: "PUT", headers, body: { password: "x".repeat(9000) } }))).status, 413);
  store.writeBrowserPassword("valid browser password");
  assert.deepEqual(await (await settings.GET(req(path, { headers: nativeHeaders }))).json(), { enabled: true, managed: false, corrupt: false });
});

test("password limits are enforced and guesses share existing throttle", async () => {
  assert.throws(() => store.writeBrowserPassword("short"));
  assert.throws(() => store.writeBrowserPassword("x".repeat(1025)));
  store.writeBrowserPassword("valid browser password");
  const basic = (password) => ({ authorization: `Basic ${Buffer.from(`pi:${password}`).toString("base64")}` });
  assert.equal(proxy(req("/api/sessions", { headers: basic("wrong") })).status, 401);
  assert.equal(proxy(req("/api/sessions", { headers: basic("valid browser password") })).status, 429);
  assert.equal((await login.POST(req("/api/web-auth", { method: "POST", headers: { "content-type": "application/json" }, body: { password: "valid browser password" } }))).status, 429);
});
