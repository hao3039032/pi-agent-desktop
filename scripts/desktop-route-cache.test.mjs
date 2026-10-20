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
  // Where the launcher dropped the scoped entry, Next's FileSystemCache.get falls
  // back to the build seed (`server/app/index.html`) for a `/$/`-scoped route key,
  // guarded by the seed's own .meta routeCache owner. That legacy path, not the
  // launcher, is what serves the new page here, so an upgrade that stops reading
  // the seed (or changes that guard) fails this assertion for a Next reason.
  const viaSeedFallback = (what) => `served ${what} through Next's legacy /$/ seed fallback`;
  assert.equal((await cache().get(key, context)).value.html, "<html>new-artifact-ui</html>", viaSeedFallback("html"));
  assert.equal(
    (await cache().get(key, context)).value.rscData.toString(),
    "new-artifact-ui",
    viaSeedFallback("RSC payload"),
  );
});

test("the build-id marker is written only after the stale route cache is gone", () => {
  // Reconcile note: the launcher catches and logs a failed delete so the server
  // still starts, which makes this ordering the only protection left. Swap it and
  // a denied delete records the new BUILD_ID without clearing the old page: the
  // next start sees matching ids and serves the previous version forever, with
  // every test in this suite still green.
  const cleared = launcher.indexOf('"route-cache"), { recursive: true, force: true })');
  const marked = launcher.indexOf("writeFileSync(markerPath");
  assert.ok(cleared > 0, "the launcher must drop .next-desktop/server/route-cache");
  assert.ok(marked > 0, "the launcher must record the BUILD_ID it cleared the cache for");
  assert.ok(cleared < marked, "the route-cache delete must come first, so a failing delete leaves the marker unwritten");
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
