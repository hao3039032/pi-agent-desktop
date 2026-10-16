import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// The route module is loaded with `@/lib/widget-window` aliased onto a stub,
// so the 200-path assertions never spawn a real window host. The stub records
// requests on globalThis to share them with this test file.
const stubDir = await mkdtemp(path.join(tmpdir(), "pi-web-widget-route-"));
const calls = [];
globalThis.__piWidgetRouteCalls = calls;
const stubSource = [
  "const calls = globalThis.__piWidgetRouteCalls;",
  "export async function openWidgetWindow(request) {",
  "  calls.push(request);",
  "  if (request.code === '__fail__') throw new Error(\"Glimpse host not found at '/x'. Run 'npm run build:macos'\");",
  "}",
].join("\n");
await writeFile(path.join(stubDir, "widget-window.mjs"), stubSource);
test.after(() => rm(stubDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": process.cwd(),
    "@/lib/widget-window": path.join(stubDir, "widget-window.mjs"),
  },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

function post(body, headers = {}) {
  return POST(new Request("http://127.0.0.1:30141/api/widgets/open", {
    method: "POST",
    headers: { host: "127.0.0.1", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }));
}

test.afterEach(() => {
  calls.length = 0;
});

test("an untrusted request is refused before anything opens", async () => {
  const response = await POST(new Request("http://127.0.0.1:30141/api/widgets/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "<div/>" }),
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);
});

test("missing code, wrong types and oversized code are 400", async () => {
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ code: "" })).status, 400);
  assert.equal((await post({ code: 42 })).status, 400);
  assert.equal((await post("not json{")).status, 400);
  assert.equal((await post({ code: "x".repeat(2 * 1024 * 1024 + 1) })).status, 400, "over 2MB is refused");
  assert.equal((await post({ code: "<div/>" }, { "Content-Type": "text/plain" })).status, 415);
  assert.deepEqual(calls, [], "nothing reached the window host");
});

test("a valid request opens the window and reports ok", async () => {
  const response = await post({
    code: "<svg><rect/></svg>",
    title: "my_widget",
    width: 640,
    height: 480,
    isSVG: true,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(calls, [{
    code: "<svg><rect/></svg>",
    title: "my_widget",
    width: 640,
    height: 480,
    isSVG: true,
  }]);
});

test("optional fields with wrong types are dropped, not fatal", async () => {
  const response = await post({ code: "<div/>", title: 5, width: "wide", height: null, isSVG: "yes" });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ code: "<div/>" }]);
});

test("a window-host failure surfaces as 500 with the reason", async () => {
  const response = await post({ code: "__fail__" });
  assert.equal(response.status, 500);
  const data = await response.json();
  // The stub throws the bare glimpse error; the real openWidgetWindow wraps
  // it as "Could not open the widget window: <glimpse error>" before the
  // route sees it. Both carry the platform fix hint.
  assert.match(data.error, /Glimpse host not found/);
  assert.match(data.error, /build:macos/);
});
