import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// The route module is loaded with `@/lib/distro/service-config` and
// `@/lib/models-config-store` aliased onto stubs, so no assertion touches the
// real models.json / agent dir. The stub records PUT bodies on globalThis.
const stubDir = await mkdtemp(path.join(tmpdir(), "pi-web-distro-route-"));
const calls = [];
globalThis.__piDistroRouteCalls = calls;
const stubSource = [
  "const calls = globalThis.__piDistroRouteCalls;",
  "export class DistroConfigError extends Error {}",
  "export function readDistroServiceStatus() {",
  "  return { providerId: 'lw', providerName: 'LW', configured: true, baseUrl: 'https://example.test', hasApiKey: true, npmMirror: false };",
  "}",
  "export async function applyDistroServiceConfig(input) {",
  "  calls.push(input);",
  "  if (input.baseUrl === '__invalid__') throw new DistroConfigError('baseUrl must be a valid URL');",
  "  if (input.baseUrl === '__boom__') throw new Error('disk on fire');",
  "  return readDistroServiceStatus();",
  "}",
].join("\n");
const modelsStoreStub = [
  "export class ModelsConfigReadError extends Error {}",
  "export class ModelsConfigWriteError extends Error {}",
  "export function readModelsConfig() { return { providers: {} }; }",
  "export function writeModelsConfig() {}",
].join("\n");
await writeFile(path.join(stubDir, "service-config.mjs"), stubSource);
await writeFile(path.join(stubDir, "models-config-store.mjs"), modelsStoreStub);
test.after(() => rm(stubDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": process.cwd(),
    "@/lib/distro/service-config": path.join(stubDir, "service-config.mjs"),
    "@/lib/models-config-store": path.join(stubDir, "models-config-store.mjs"),
  },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

function put(body, headers = {}) {
  return PUT(new Request("http://127.0.0.1:30141/api/distro", {
    method: "PUT",
    headers: { host: "127.0.0.1", "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }));
}

test.afterEach(() => {
  calls.length = 0;
});

test("an untrusted request is refused before the config is read", async () => {
  const response = await PUT(new Request("http://127.0.0.1:30141/api/distro", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: "https://example.test", apiKey: "k" }),
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);
});

test("a non-JSON content type is refused before the config is read", async () => {
  const response = await put({ baseUrl: "https://example.test" }, { "Content-Type": "text/plain" });
  assert.equal(response.status, 415);
  assert.deepEqual(calls, []);
});

test("an invalid config is a 400 with the reason", async () => {
  const response = await put({ baseUrl: "__invalid__" });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error, /baseUrl must be a valid URL/);
  assert.equal(calls.length, 1);
});

test("a valid request applies the config and returns the status", async () => {
  const response = await put({ baseUrl: "https://example.test", apiKey: "secret" });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.configured, true);
  assert.equal(data.hasApiKey, true);
  assert.deepEqual(calls, [{ baseUrl: "https://example.test", apiKey: "secret" }]);
});

test("an unexpected failure surfaces as 500", async () => {
  const response = await put({ baseUrl: "__boom__" });
  assert.equal(response.status, 500);
  const data = await response.json();
  assert.match(data.error, /disk on fire/);
});

test("GET reports the service status without the key", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ["baseUrl", "configured", "hasApiKey", "npmMirror", "providerId", "providerName"]);
  assert.deepEqual(calls, []);
});
