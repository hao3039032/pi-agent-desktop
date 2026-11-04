import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ripgrepArtifactFor, stageRipgrepForTarget } from "./distro-ripgrep.mjs";

test("ripgrep assets are selected by target, not the runner architecture", () => {
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const artifact = ripgrepArtifactFor(target);
    assert.ok(artifact.asset.endsWith(`${target}.tar.gz`));
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  }
  for (const target of ["constructor", "__proto__", "x86_64-unknown-linux-gnu", undefined]) {
    assert.throws(() => ripgrepArtifactFor(target), /no ripgrep release artifact/);
  }
});

test("a corrupt download fails before replacing any staged binary", async (t) => {
  const destDir = mkdtempSync(join(tmpdir(), "ripgrep-test-"));
  t.after(() => rmSync(destDir, { recursive: true, force: true }));
  writeFileSync(join(destDir, "rg"), "old binary");
  await assert.rejects(stageRipgrepForTarget({
    triple: "x86_64-apple-darwin", destDir,
    fetchImpl: async (url) => {
      assert.ok(url.endsWith("ripgrep-15.2.0-x86_64-apple-darwin.tar.gz"));
      return new Response("not an archive");
    },
  }), /SHA-256 .* does not match/);
  assert.equal(readFileSync(join(destDir, "rg"), "utf8"), "old binary");
  assert.equal(existsSync(join(destDir, "LICENSE-MIT")), false);
});

test("download errors fail the build rather than silently omitting ripgrep", async () => {
  await assert.rejects(stageRipgrepForTarget({
    triple: "aarch64-apple-darwin", destDir: "unused",
    fetchImpl: async () => new Response("missing", { status: 404 }),
  }), /HTTP 404/);
});

test("release and macOS test builds stage and execute the target ripgrep", () => {
  for (const [file, target] of [
    ["distro-release.yml", "matrix.target"],
    ["mac-build-test.yml", "inputs.target"],
  ]) {
    const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    assert.ok(source.includes(`node scripts/distro-ripgrep.mjs --target "\${{ ${target} }}"`));
    assert.ok(source.includes("src-tauri/resources/ripgrep/rg --version"));
  }
});
