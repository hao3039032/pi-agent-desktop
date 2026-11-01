#!/usr/bin/env node
// Minimal Linux reproduction: standalone pi 1.4.0 vs its bundled Node using
// the same isolated files. A successful run confirms the resolver failure;
// it is NOT a standalone package acceptance test.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyBundle } from "./static-bundle-manifest.mjs";

if (process.platform !== "linux" || process.argv.length !== 3) throw new Error("usage: node pi-standalone-import-map-repro.mjs <staged-resource-dir>");
const bundle = resolve(process.argv[2]);
verifyBundle(bundle, JSON.parse(readFileSync(join(bundle, "bundle-manifest.json"), "utf8")));
const scratch = mkdtempSync(join(tmpdir(), "pi-import-map-"));
try {
  const pkg = join(scratch, "node_modules/p");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(scratch, "agent"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "p", type: "module", exports: { default: "./index.js" }, imports: { "#internal": "./internal.js" } }));
  writeFileSync(join(pkg, "index.js"), "export default 42;\n");
  writeFileSync(join(pkg, "internal.js"), "export default 43;\n");
  writeFileSync(join(pkg, "test.js"), 'import x from "#internal"; export default x;\n');
  writeFileSync(join(scratch, "test.mjs"), 'import x from "p"; export default x;\n');
  writeFileSync(join(scratch, "missing.mjs"), 'import "pi-static-missing-package-fixture-47c2";\n');
  writeFileSync(join(scratch, "probe.mjs"), `export default function(pi) { pi.registerCommand("probe", { handler: async () => {
    for (const p of ["/work/test.mjs", "/work/node_modules/p/test.js", "/work/missing.mjs"]) {
      try { console.error("PROBE_OK", p, (await import(p)).default); }
      catch (e) { console.error("PROBE_FAIL", p, String(e)); }
    }
  }}); }\n`);
  const base = ["--die-with-parent", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--ro-bind", bundle, "/bundle", "--bind", scratch, "/work", "--chdir", "/work", "--clearenv", "--setenv", "HOME", "/work", "--setenv", "USERPROFILE", "/work", "--setenv", "PATH", "/bundle/node", "--setenv", "PI_CODING_AGENT_DIR", "/work/agent"];
  const node = spawnSync("bwrap", [...base, "/bundle/node/node", "--input-type=module", "-e", 'console.log((await import("/work/test.mjs")).default, (await import("/work/node_modules/p/test.js")).default)'], { encoding: "utf8", timeout: 30000 });
  assert.equal(node.status, 0, node.stderr);
  assert.equal(node.stdout.trim(), "42 43");
  const pi = spawn("bwrap", [...base, "/bundle/pi/pi", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", "/work/probe.mjs"]);
  let stdout = "", stderr = "";
  pi.stdout.on("data", (data) => { stdout += data; });
  pi.stderr.on("data", (data) => { stderr += data; });
  const exited = new Promise((r) => pi.once("exit", r));
  try {
    pi.stdin.write('{"id":"probe","type":"prompt","message":"/probe"}\n');
    const deadline = Date.now() + 30000;
    while (!stdout.includes('"disposition":"handled"') && pi.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.match(stdout, /"disposition":"handled"/, stderr);
    assert.match(stderr, /PROBE_OK \/work\/test\.mjs 42/);
    assert.match(stderr, /PROBE_FAIL \/work\/node_modules\/p\/test\.js .*Cannot find package '#internal'/);
    assert.match(stderr, /PROBE_FAIL \/work\/missing\.mjs .*Cannot find package 'pi-static-missing-package-fixture-47c2'/);
  } finally {
    pi.stdin.end();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (pi.exitCode === null) { pi.kill("SIGKILL"); await exited; }
  }
  console.log("Reproduced: bundled Node resolves package imports; official standalone pi cannot resolve #internal in the same filesystem. No checkout or user home mounted.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
