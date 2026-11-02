import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const read = (name) => readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), "utf8");

test("Windows preview overlay isolates identity, payload, updater and upgrade cleanup", () => {
  const config = JSON.parse(read("src-tauri/tauri.preview.conf.json"));
  assert.equal(config.identifier, "com.hao.pi-agent-lw.preview");
  assert.equal(config.productName, "Pi Agent LW Preview");
  assert.equal(config.build.frontendDist, "../desktop/frontend-static");
  assert.deepEqual(config.bundle.resources, { "resources/static-preview/": "static-preview/" });
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(config.plugins.updater, null);
  assert.ok(!config.app.security.capabilities.includes("desktop-updater"));
  assert.equal(config.bundle.windows.nsis.installerHooks, "installer-preview-hooks.nsh");
  const hook = read("src-tauri/installer-preview-hooks.nsh");
  assert.deepEqual([...hook.matchAll(/RMDir \/r "([^"]+)"/g)].map((match) => match[1]), ["$INSTDIR\\resources\\static-preview"]);
});

test("Windows preview workflow is artifact-only and requires real SDK/static host", () => {
  const text = read(".github/workflows/windows-static-preview.yml");
  const workflow = load(text);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.on.push.branches, ["preview/windows-static"]);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.equal(workflow.jobs.preview["runs-on"], "windows-latest");
  assert.equal(workflow.jobs.preview.env.CARGO_BUILD_JOBS, 2);
  for (const required of ["npm ci", "npm run check:deps", "npm ci --prefix static-frontend", "--target x86_64-pc-windows-msvc", "--github-env", "npm run build --prefix static-frontend", "--management-sdk", "smoke-static-preview.mjs", "--features static-preview", "-- --locked", "--no-sign", "if-no-files-found: error"]) assert.ok(text.includes(required), required);
  for (const forbidden of ["pull_request_target", "desktop:prepare", "next build", "tauri-action", "secrets.", "gh release", "latest.json", "static-ui-harness"]) assert.ok(!text.includes(forbidden), forbidden);
  assert.match(text, /if \(\$LASTEXITCODE -ne 0\)/);
  assert.match(text, /Rename-Item node_modules node_modules\.preview-hidden/);
  assert.match(text, /finally\s*\{/);
});

test("staged smoke refuses ancestor node_modules before executing a bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "preview-ambient-"));
  try {
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, "resources"));
    const script = fileURLToPath(new URL("./smoke-static-preview.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, join(root, "resources")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ambient node_modules above resource root/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
