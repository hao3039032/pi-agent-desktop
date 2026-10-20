import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import test from "node:test";

const require = createRequire(import.meta.url);
const FileSystemCache = require("next/dist/server/lib/incremental-cache/file-system-cache").default;
const { getRouteCacheKey } = require("next/dist/server/lib/route-cache-key");
const launcher = await readFile(new URL("../desktop/server-launcher.cjs", import.meta.url), "utf8");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-route-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = path.join(root, ".next-desktop", "server");
  const owner = { kind: "APP_PAGE", sourceRoute: "/page" };
  const key = getRouteCacheKey("/", owner);
  const seed = path.join(server, "app", "index");
  const cached = path.join(server, key);
  for (const [file, version] of [[seed, "new-artifact-ui"], [cached, "old-source-only-ui"]]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.html`, `<html>${version}</html>`);
    await writeFile(`${file}.rsc`, version);
    await writeFile(`${file}.meta`, JSON.stringify({ routeCache: { key, owner, isFallback: false } }));
  }
  // A real packaged upgrade: the new build ships its own BUILD_ID while the
  // marker on disk still names the previous one (installer-hooks.nsh deletes
  // the payload on Windows; this path covers installs made before that hook).
  await writeFile(path.join(root, ".next-desktop", "BUILD_ID"), "build-new\n");
  await writeFile(path.join(root, ".next-desktop", ".route-cache-build-id"), "build-old\n");
  await mkdir(path.join(root, "node_modules", "@earendil-works"), { recursive: true });
  await writeFile(path.join(root, "desktop-server.cjs"), launcher);
  const cache = () => new FileSystemCache({
    fs: { ...fs.promises, existsSync: fs.existsSync, readFileSync: fs.readFileSync },
    serverDistDir: server, flushToDisk: false, revalidatedTags: [], maxMemoryCacheSize: 0,
  });
  return { root, server, key, seed, cache };
}

test("launcher clears stale route responses before Next reads the new build seed", async (t) => {
  const { root, server, key, seed, cache } = await fixture(t);
  const context = { kind: "APP_PAGE", isFallback: false, isRoutePPREnabled: false };
  // Reproduce the actual Next failure, not just a string-matching sentinel.
  assert.equal((await cache().get(key, context)).value.html, "<html>old-source-only-ui</html>");
  await writeFile(path.join(root, "server.js"), `
    const fs = require('node:fs'); const path = require('node:path');
    if (fs.existsSync(path.join(__dirname, '.next-desktop/server/route-cache'))) throw Error('stale cache reached Next');
    console.log('seed ready');
  `);
  const run = spawnSync(process.execPath, [path.join(root, "desktop-server.cjs")], {
    env: { ...process.env, PI_WEB_PARENT_PID: String(process.pid) }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /seed ready/);
  assert.equal(fs.existsSync(path.join(server, "route-cache")), false);
  assert.equal(await readFile(`${seed}.html`, "utf8"), "<html>new-artifact-ui</html>");
  assert.equal((await cache().get(key, context)).value.html, "<html>new-artifact-ui</html>");
  assert.equal((await cache().get(key, context)).value.rscData.toString(), "new-artifact-ui");
});

test("distro release verifies the staged HTTP homepage on every platform before bundling", async () => {
  const workflow = await readFile(new URL("../.github/workflows/distro-release.yml", import.meta.url), "utf8");
  const prepare = workflow.indexOf("run: npm run desktop:prepare");
  const verify = workflow.indexOf("run: node scripts/verify-packaged-frontend.mjs");
  const bundle = workflow.indexOf("- name: Build, sign, and upload");
  assert.ok(prepare > 0 && verify > prepare && bundle > verify);
  const step = workflow.slice(workflow.lastIndexOf("- name:", verify), verify);
  assert.doesNotMatch(step, /if:|continue-on-error:/);
});

test("overwrite installs remove generated Next payload as well as stale dependencies", async () => {
  const hooks = await readFile(new URL("../src-tauri/installer-hooks.nsh", import.meta.url), "utf8");
  assert.ok(hooks.includes('RMDir /r "$INSTDIR\\resources\\server\\.next-desktop"'));
  assert.ok(hooks.includes('RMDir /r "$INSTDIR\\resources\\server\\node_modules"'));
  assert.doesNotMatch(hooks, /RMDir.*(?:sessions|\.pi\\agent)/);
  const prepare = await readFile(new URL("./prepare-desktop.mjs", import.meta.url), "utf8");
  assert.match(prepare, /await rm\(join\(serverResourcesDir, "\.next-desktop", "server", "route-cache"\), \{ recursive: true, force: true \}\)/);
});
