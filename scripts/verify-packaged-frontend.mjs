#!/usr/bin/env node
// Release gate: exercise the staged launcher with an old route response and
// verify that HTTP serves the new build's page/chunks, not just files on disk.
// Uses a throwaway home, no user sessions, no browser and no model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPiDistributionManifest } from "./pi-cli-distribution.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const resources = join(root, "src-tauri", "resources");
const server = join(resources, "server");
const dist = join(server, ".next-desktop", "server");
const cacheDir = join(dist, "route-cache");
const node = [
  join(resources, "node", "node.exe"),
  join(resources, "node", "node"),
  join(resources, "Pi Agent Server.app", "Contents", "MacOS", "node"),
].find(existsSync);
assert.ok(node, "Run desktop:prepare first");
assert.equal(existsSync(cacheDir), false, "A package must not ship runtime route-cache");

// The pi CLI ships as a distribution, not a lone executable: the archive's
// resources (photon_rs_bg.wasm on darwin/linux, theme/) belong in the package
// too. The manifest prepare-desktop wrote is the checklist — a pruned tree or
// a resource left behind in the runner's temp dir fails here.
const piResources = join(resources, "pi");
const piManifest = readPiDistributionManifest(piResources);
if (piManifest) {
  assert.ok(
    existsSync(join(piResources, piManifest.binary)),
    `Packaged pi binary is missing: resources/pi/${piManifest.binary}`,
  );
  const missing = piManifest.files.filter((file) => !existsSync(join(piResources, ...file.split("/"))));
  assert.deepEqual(missing, [], `Packaged pi distribution is missing ${missing.length} file(s)`);
  assert.ok(piManifest.files.length >= 1);
  // Release context: the distribution must be the archive's whole tree
  // (complete: true), not the executable-only fallback. Dev trees without
  // PI_DESKTOP_REQUIRE_PI keep the fallback.
  if (process.env.PI_DESKTOP_REQUIRE_PI === "1") {
    assert.equal(
      piManifest.complete,
      true,
      "PI_DESKTOP_REQUIRE_PI=1: the packaged pi distribution is not complete (manifest.complete is not true)",
    );
  }
  console.log(`OK: packaged pi distribution has ${piManifest.files.length} file(s) from the release archive.`);
} else if (existsSync(piResources)) {
  throw new Error("resources/pi exists without a distribution manifest: re-run desktop:prepare");
} else {
  console.log("No packaged pi CLI in this tree (desktop:prepare ran without one).");
}
const seed = await readFile(join(dist, "app", "index.html"), "utf8");
const scripts = [...new Set([...seed.matchAll(/<script\b[^>]*\bsrc="([^"#]+)"/g)].map((match) => match[1]))];
assert.ok(scripts.some((src) => /\/app\/page-[^/]+\.js/.test(src)), "Missing homepage chunk in build seed");
const require = createRequire(join(server, "server.js"));
const { getRouteCacheKey } = require("next/dist/server/lib/route-cache-key");
const owner = { kind: "APP_PAGE", sourceRoute: "/page" };
const key = getRouteCacheKey("/", owner);
const cached = join(dist, key);
const marker = "pi-stale-upgrade-page-must-not-be-served";
const scratch = await mkdtemp(join(tmpdir(), "pi-frontend-upgrade-"));
let child;
let exited;
let log = "";
try {
  await mkdir(dirname(cached), { recursive: true });
  await writeFile(`${cached}.html`, `<html>${marker}</html>`);
  await writeFile(`${cached}.rsc`, marker);
  await writeFile(`${cached}.meta`, JSON.stringify({ routeCache: { key, owner, isFallback: false } }));
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const env = { ...process.env };
  for (const name of ["__NEXT_PRIVATE_ORIGIN", "__NEXT_PRIVATE_STANDALONE_CONFIG", "PI_WEB_PASSWORD", "PI_WEB_DESKTOP_API_TOKEN"]) delete env[name];
  child = spawn(node, [join(server, "desktop-server.cjs")], {
    cwd: server,
    env: { ...env, HOME: scratch, USERPROFILE: scratch, PI_CODING_AGENT_DIR: join(scratch, "agent"),
      HOSTNAME: "127.0.0.1", PORT: String(port), NODE_ENV: "production",
      PI_WEB_PARENT_PID: String(process.pid), NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  child.on("error", (error) => { log += String(error); });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { log = (log + chunk).slice(-16000); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let html;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `Staged server exited early\n${log}`);
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) { html = await response.text(); break; }
    } catch { /* server still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(html, `Staged homepage did not respond\n${log}`);
  assert.ok(!html.includes(marker), "Old route-cache overrode the new homepage");
  for (const src of scripts) {
    assert.ok(src.startsWith("/_next/static/"), `Unexpected non-local build script: ${src}`);
    assert.ok(html.includes(src), `HTTP homepage is missing the new build script ${src}`);
    const response = await fetch(new URL(src, base), { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, `New build script is not served: ${src}`);
  }
  console.log(`OK: stale homepage cleared; HTTP serves this build's ${scripts.length} script assets.`);
} finally {
  if (child && child.exitCode === null) child.kill();
  if (exited) await exited;
  // Verification itself can populate route-cache. Never bundle those entries.
  await rm(cacheDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
