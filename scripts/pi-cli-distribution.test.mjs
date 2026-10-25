/**
 * The packaged pi distribution (scripts/pi-cli-distribution.mjs): the whole
 * archive tree is staged beside the server, not just the executable, and the
 * manifest is what `verify-packaged-frontend.mjs` checks after packaging.
 *
 * Everything here runs in a temp dir; no archive is downloaded.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PI_DISTRIBUTION_MANIFEST,
  piExecutableName,
  readPiDistributionManifest,
  stagePiDistribution,
  stagePiExecutableOnly,
} from "./pi-cli-distribution.mjs";

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-dist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** The darwin/linux archive layout, as the real tarball ships it. */
function darwinDistribution(root) {
  const source = join(root, "pi");
  mkdirSync(join(source, "theme"), { recursive: true });
  mkdirSync(join(source, "examples", "sdk"), { recursive: true });
  writeFileSync(join(source, "pi"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(source, "theme", "dark.json"), "{}");
  writeFileSync(join(source, "photon_rs_bg.wasm"), "wasm");
  writeFileSync(join(source, "examples", "sdk", "01.ts"), "//");
  return source;
}

test("the whole distribution tree is staged, wasm and theme included", async (t) => {
  const root = await sandbox(t);
  const source = darwinDistribution(root);
  const dest = join(root, "resources", "pi");

  const manifest = stagePiDistribution({ sourceDir: source, destDir: dest, binaryName: "pi", platform: "darwin" });

  assert.equal(manifest.binary, "pi");
  assert.equal(manifest.complete, true);
  assert.deepEqual(manifest.files, ["examples/sdk/01.ts", "photon_rs_bg.wasm", "pi", "theme/dark.json"]);
  assert.equal(readFileSync(join(dest, "photon_rs_bg.wasm"), "utf8"), "wasm");
  assert.equal(readFileSync(join(dest, "theme", "dark.json"), "utf8"), "{}");
  // Forward-slash paths in the manifest, whatever the host separator is.
  assert.ok(manifest.files.every((file) => !file.includes("\\")));
  // The engine spawns this path directly.
  if (process.platform !== "win32") assert.equal(statSync(join(dest, "pi")).mode & 0o777, 0o755);
  // The manifest itself is on disk for the release gate.
  assert.deepEqual(readPiDistributionManifest(dest), manifest);
});

test("the Windows layout is staged flat, with pi.exe as the binary", async (t) => {
  const root = await sandbox(t);
  const source = join(root, "win");
  mkdirSync(join(source, "theme"), { recursive: true });
  writeFileSync(join(source, "pi.exe"), "MZ");
  writeFileSync(join(source, "theme", "dark.json"), "{}");
  const dest = join(root, "resources", "pi");

  const manifest = stagePiDistribution({ sourceDir: source, destDir: dest, binaryName: "pi.exe", platform: "win32" });

  assert.equal(manifest.binary, "pi.exe");
  assert.deepEqual(manifest.files, ["pi.exe", "theme/dark.json"]);
  assert.equal(readFileSync(join(dest, "pi.exe"), "utf8"), "MZ");
});

test("a distribution without the target's binary is refused by name", async (t) => {
  const root = await sandbox(t);
  const source = darwinDistribution(root);
  assert.throws(
    () => stagePiDistribution({ sourceDir: source, destDir: join(root, "out"), binaryName: "pi.exe", platform: "win32" }),
    /pi distribution has no pi\.exe/,
  );
});

test("a symlink inside the distribution is refused instead of followed", async (t) => {
  const root = await sandbox(t);
  const source = darwinDistribution(root);
  try {
    symlinkSync(join(root, "outside"), join(source, "escape"));
  } catch (error) {
    if (error.code === "EPERM") return t.skip("this Windows session cannot create symlinks");
    throw error;
  }
  assert.throws(
    () => stagePiDistribution({ sourceDir: source, destDir: join(root, "out"), binaryName: "pi", platform: "darwin" }),
    /contains a symlink: escape/,
  );
});

test("a bare executable stages as an explicitly incomplete distribution", async (t) => {
  const root = await sandbox(t);
  const binary = join(root, "pi.exe");
  writeFileSync(binary, "MZ");
  const dest = join(root, "resources", "pi");

  const manifest = stagePiExecutableOnly({ sourcePath: binary, destDir: dest, platform: "win32" });

  assert.deepEqual(manifest, { binary: "pi.exe", files: ["pi.exe"], complete: false });
  assert.equal(readFileSync(join(dest, "pi.exe"), "utf8"), "MZ");
});

test("no manifest reads as undefined, so an unstaged tree is distinguishable", async (t) => {
  const root = await sandbox(t);
  assert.equal(readPiDistributionManifest(join(root, "nothing")), undefined);
  mkdirSync(join(root, "broken"));
  writeFileSync(join(root, "broken", PI_DISTRIBUTION_MANIFEST), "{not json");
  assert.equal(readPiDistributionManifest(join(root, "broken")), undefined);
});

test("the executable name follows the target platform, not the host", () => {
  assert.equal(piExecutableName("win32"), "pi.exe");
  assert.equal(piExecutableName("darwin"), "pi");
  assert.equal(piExecutableName("linux"), "pi");
});
