import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-cache-miss-notices-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

const settingsPath = path.join(agentDir, "settings.json");

function put(body, headers = { host: "localhost", "Content-Type": "application/json" }) {
  return PUT(new Request("http://localhost/api/cache-miss-notices", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

const NOTICE_KEYS = ["cacheMisses", "cacheWarming", "compactionCosts", "reasoningDrops"];
const allOn = { cacheMisses: true, cacheWarming: true, compactionCosts: true, reasoningDrops: true };

test("switches pi's transcript notices in the global settings, keeping other keys", async () => {
  assert.deepEqual(await (await GET()).json(), { enabled: false });
  // Off without a settings file is pi's default already: no file appears.
  assert.deepEqual(await (await put({ enabled: false })).json(), { enabled: false });
  await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });

  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  const on = await put({ enabled: true });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { enabled: true });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", notices: allOn });
  assert.deepEqual(await (await GET()).json(), { enabled: true });

  // Off is pi's default: the keys go, and nothing empty is left behind.
  const off = await put({ enabled: false });
  assert.deepEqual(await off.json(), { enabled: false });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m" });
});

test("a file pi has not rewritten since 1.6.0 is moved off showCacheMissNotices onto the keys pi reads now", async () => {
  // pi migrated an old switch into the four keys on load; until it saves, the
  // file still says showCacheMissNotices, which the switch reports as on.
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m", showCacheMissNotices: true }));
  assert.deepEqual(await (await GET()).json(), { enabled: true });
  const off = await put({ enabled: false });
  assert.deepEqual(await off.json(), { enabled: false });
  // Left behind, the old key would bring every notice back on pi's next load.
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m" });

  // A partial choice made in pi's own /settings reads as off here, and the
  // switch sets all four keys, as the old single key did.
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m", notices: { cacheMisses: true } }));
  assert.deepEqual(await (await GET()).json(), { enabled: false });
  assert.deepEqual(await (await put({ enabled: true })).json(), { enabled: true });
  const saved = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(saved, { defaultModel: "m", notices: allOn });
  assert.deepEqual(Object.keys(saved.notices).sort(), [...NOTICE_KEYS].sort());
});

test("explicit notice booleans take precedence over the legacy switch in both directions", async () => {
  await writeFile(settingsPath, JSON.stringify({
    showCacheMissNotices: true,
    notices: { ...allOn, cacheMisses: false },
  }));
  assert.deepEqual(await (await GET()).json(), { enabled: false }, "one explicit false wins over legacy true");

  await writeFile(settingsPath, JSON.stringify({
    showCacheMissNotices: false,
    notices: allOn,
  }));
  assert.deepEqual(await (await GET()).json(), { enabled: true }, "explicit true values win over legacy false");

  await writeFile(settingsPath, JSON.stringify({
    showCacheMissNotices: true,
    notices: { ...allOn, cacheMisses: undefined },
  }));
  assert.deepEqual(await (await GET()).json(), { enabled: true }, "a missing key still falls back to legacy true");
});

test("refuses what is not a boolean, a foreign origin and a non-JSON body", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  assert.equal((await put({ enabled: "yes" })).status, 400);
  assert.equal((await put("{")).status, 400);
  assert.equal((await put({ enabled: true }, { host: "localhost", "Content-Type": "text/plain" })).status, 415);
  assert.equal((await put({ enabled: true }, { host: "localhost", origin: "https://evil.example", "Content-Type": "application/json" })).status, 403);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m" });
});
