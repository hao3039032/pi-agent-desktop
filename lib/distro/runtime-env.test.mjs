import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import {
  applyAutoReviewWorkspaceOptOut,
  applyUpstreamWebUpdateSkip,
  configureDistroPath,
} from "./runtime-env.ts";

const FLAG = "PI_WEB_SKIP_VERSION_CHECK";

test("the packaged distro suppresses the upstream pi-web update prompt", () => {
  const saved = process.env[FLAG];
  try {
    // Unset → the distro runtime turns the npm version check off.
    delete process.env[FLAG];
    applyUpstreamWebUpdateSkip();
    assert.equal(process.env[FLAG], "1");

    // An operator's explicit choice wins: "0" keeps upstream's check on.
    process.env[FLAG] = "0";
    applyUpstreamWebUpdateSkip();
    assert.equal(process.env[FLAG], "0");

    // Idempotent once set.
    process.env[FLAG] = "1";
    applyUpstreamWebUpdateSkip();
    assert.equal(process.env[FLAG], "1");
  } finally {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  }
});

test("the bundled srt bin directory is put before the inherited PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "distro-runtime-env-"));
  const srtBin = join(root, "pi-seed", "npm", "node_modules", ".bin");
  mkdirSync(srtBin, { recursive: true });
  const srt = join(srtBin, process.platform === "win32" ? "srt.cmd" : "srt");
  writeFileSync(srt, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") chmodSync(srt, 0o755);
  const inherited = ["/usr/local/bin", "/usr/bin"];
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = inherited.join(delimiter);
    configureDistroPath(root);
    assert.equal(process.env.PATH?.split(delimiter)[0], srtBin);
    assert.deepEqual(process.env.PATH?.split(delimiter), [srtBin, ...inherited]);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS finds bundled ripgrep without Homebrew and repeated setup stays idempotent", (t) => {
  const root = mkdtempSync(join(tmpdir(), "distro rg 空格-"));
  const bin = join(root, "ripgrep");
  const saved = process.env.PATH;
  t.after(() => {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
    rmSync(root, { recursive: true, force: true });
  });
  process.env.PATH = "/usr/bin";
  configureDistroPath(root, "darwin");
  assert.equal(process.env.PATH, "/usr/bin", "missing resources do not add dead PATH entries");
  mkdirSync(bin);
  writeFileSync(join(bin, "rg"), "stub");
  configureDistroPath(root, "linux");
  assert.equal(process.env.PATH, "/usr/bin", "never expose a Mach-O binary on Linux");
  configureDistroPath(root, "darwin");
  configureDistroPath(root, "darwin");
  assert.deepEqual(process.env.PATH.split(delimiter), [bin, "/usr/bin"]);
});

const AUTO_REVIEW_FLAG = "PI_AUTO_REVIEW_ALLOW_UNTRUSTED_DEV";

test("the packaged distro opts the security reviewer out of workspace containment", () => {
  const saved = process.env[AUTO_REVIEW_FLAG];
  try {
    // Unset → the distro sets the opt-out: on Windows the pi-seed install
    // lives under the user profile, so home-directory and drive-root
    // workspaces would otherwise disable the reviewer entirely.
    delete process.env[AUTO_REVIEW_FLAG];
    applyAutoReviewWorkspaceOptOut();
    assert.equal(process.env[AUTO_REVIEW_FLAG], "1");

    // An operator's explicit choice wins: "0" keeps the strict check.
    process.env[AUTO_REVIEW_FLAG] = "0";
    applyAutoReviewWorkspaceOptOut();
    assert.equal(process.env[AUTO_REVIEW_FLAG], "0");

    // Idempotent once set.
    process.env[AUTO_REVIEW_FLAG] = "1";
    applyAutoReviewWorkspaceOptOut();
    assert.equal(process.env[AUTO_REVIEW_FLAG], "1");
  } finally {
    if (saved === undefined) delete process.env[AUTO_REVIEW_FLAG];
    else process.env[AUTO_REVIEW_FLAG] = saved;
  }
});
