import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { load } from "js-yaml";

const read = (name) => readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), "utf8");

test("macOS preview overlay keeps the preview identity and bundles only macOS targets", () => {
  const preview = JSON.parse(read("src-tauri/tauri.preview.conf.json"));
  const overlay = JSON.parse(read("src-tauri/tauri.preview.macos.conf.json"));
  // The overlay may only narrow the bundle targets: identity, payload and the
  // disabled updater stay in the shared preview overlay, so a macOS build can
  // never ship a second identity or the updater.
  assert.deepEqual(Object.keys(overlay).filter((key) => key !== "$schema"), ["bundle"]);
  assert.deepEqual(Object.keys(overlay.bundle), ["targets"]);
  assert.deepEqual(overlay.bundle.targets, ["app", "dmg"]);
  assert.equal(preview.identifier, "com.hao.pi-agent-lw.preview");
  assert.equal(preview.plugins.updater, null);
  assert.equal(preview.bundle.createUpdaterArtifacts, false);
  // Windows insists on an NSIS-only overlay; macOS must not inherit it, or the
  // bundler is asked for a Windows installer on Darwin.
  assert.deepEqual(preview.bundle.targets, ["nsis"]);
});

test("macOS preview workflow is artifact-only and requires real SDK/static host", () => {
  const text = read(".github/workflows/macos-static-preview.yml");
  const workflow = load(text);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.on.push.branches, ["preview/macos-static"]);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.equal(workflow.jobs.preview["runs-on"], "macos-15");
  assert.equal(workflow.jobs.preview.env.CARGO_BUILD_JOBS, 2);
  assert.ok(!("secrets" in workflow.jobs.preview));
  for (const required of [
    "npm ci",
    "npm run check:deps",
    "npm ci --prefix static-frontend",
    "--target aarch64-apple-darwin",
    "--github-env",
    "npm run build --prefix static-frontend",
    "--management-sdk",
    "smoke-static-preview.mjs",
    "--features static-preview",
    "-- --locked",
    "--config src-tauri/tauri.preview.macos.conf.json",
    "APPLE_SIGNING_IDENTITY=\"-\"",
    "if-no-files-found: error",
    "scripts/migration/test-macos-preview.sh",
  ]) {
    assert.ok(text.includes(required), required);
  }
  for (const forbidden of ["pull_request_target", "desktop:prepare", "next build", "tauri-action", "secrets.", "gh release", "latest.json", "static-ui-harness", "--no-sign"]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  const download = workflow.jobs.preview.steps.find((step) => step.name === "Download checksum-verified official pi distribution").run;
  assert.ok(download.includes("require('./scripts/release-component-pins.json').pi.version"));
  assert.ok(download.includes(`test "$piVersion" = '1.4.0'`));
  assert.ok(download.includes('https://github.com/earendil-works/pi/releases/download/v$piVersion'));
  assert.ok(download.includes('--base "$releaseBase"'));
  assert.ok(!download.includes("/latest/"));
  assert.match(text, /mv node_modules node_modules\.preview-hidden/);
  assert.match(text, /trap 'mv node_modules\.preview-hidden node_modules' EXIT/);
  assert.match(text, /version="0\.0\.\$number-preview\.g\$\{GITHUB_SHA:0:12\}"/);
  assert.equal(semver.valid("0.0.1-preview.g000000000001"), "0.0.1-preview.g000000000001");
  for (const item of ["$stage_bytes", "$target_bytes", "$frontend_bytes", "$download_bytes", "exceedsFormerLocalBudget", "GITHUB_STEP_SUMMARY", "shasum -a 256"]) {
    assert.ok(text.includes(item), item);
  }
});

test("macOS gate names exact real tests and refuses zero-test green", () => {
  const script = read("scripts/migration/test-macos-preview.sh");
  const names = [...script.matchAll(/^ {2}'([^']+)'(?: \\)?$/gm)].map((match) => match[1]);
  assert.equal(names.length, 13);
  assert.equal(new Set(names).size, names.length);
  const sources = new Map([
    ["host_ownership::tests::", "src-tauri/src/host_ownership.rs"],
    ["preview_bundle::tests::", "src-tauri/src/preview_bundle.rs"],
    ["preview::tests::", "src-tauri/src/preview.rs"],
    ["static_host::tests::", "src-tauri/src/static_host.rs"],
  ]);
  for (const name of names) {
    const entry = [...sources].find(([prefix]) => name.startsWith(prefix));
    assert.ok(entry, name);
    assert.ok(read(entry[1]).includes(`fn ${name.slice(entry[0].length)}()`), name);
  }
  // Windows-only evidence must never be listed here, and the macOS staged
  // runtime test must never drift back into the Windows-only test list.
  assert.ok(!script.includes("windows_ledger_tests"));
  assert.ok(!names.includes("static_host::tests::preview_staged_windows_runtime_stores_fake_key_and_starts_cli"));
  assert.ok(names.includes("static_host::tests::preview_staged_macos_runtime_stores_fake_key_and_starts_cli"));
  assert.ok(read("scripts/migration/test-windows-preview.ps1").includes("static_host::tests::preview_staged_windows_runtime_stores_fake_key_and_starts_cli"));
  for (const required of ["uname -s", "Darwin", "--list", "-Fxq", "--exact", "1 passed; 0 failed; 0 ignored;", "PI_PREVIEW_TEST_BUNDLE", "TAURI_CONFIG"]) {
    assert.ok(script.includes(required), required);
  }
  assert.ok(read(".github/workflows/macos-static-preview.yml").includes("bash ./scripts/migration/test-macos-preview.sh"));
});

test("the staged bundle's runtime roles follow the build platform on both sides", () => {
  // The verifier and the stager must agree on the executable names: a macOS
  // tree ships `node/node` and `pi/pi`, Windows ships the `.exe` pair. A
  // mismatch is a hard verification failure at Preview startup.
  const rust = read("src-tauri/src/preview_bundle.rs");
  for (const line of ['const NODE_BIN: &str = "node/node.exe";', 'const NODE_BIN: &str = "node/node";', 'const PI_BIN: &str = "pi.exe";', 'const PI_BIN: &str = "pi";']) {
    assert.ok(rust.includes(line), line);
  }
  const stager = read("scripts/migration/prepare-static-bundle.mjs");
  assert.ok(stager.includes('process.platform === "win32" ? "node.exe" : "node"'));
  assert.ok(stager.includes('process.platform === "win32" ? "pi.exe" : "pi"'));
  const macTest = read("src-tauri/src/static_host.rs");
  assert.ok(macTest.includes('#[cfg(all(feature = "static-preview", target_os = "macos"))]'));
  assert.ok(macTest.includes("fn preview_staged_macos_runtime_stores_fake_key_and_starts_cli()"));
  assert.ok(macTest.includes("fn preview_staged_windows_runtime_stores_fake_key_and_starts_cli()"));
});
