import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const { planBundledShellPath, ensureBundledBashShellPath } = await jiti.import("./shell-path.ts");

const BASH = "C:\\Apps\\Pi Agent LW\\resources\\git\\bin\\bash.exe";

function plan(overrides = {}) {
  return planBundledShellPath({
    platform: "win32",
    current: null,
    managed: null,
    bundledBash: BASH,
    bundledBashExists: true,
    systemGitBash: false,
    ...overrides,
  });
}

test("plan: fresh machine without git pins the bundled bash", () => {
  assert.deepEqual(plan(), { action: "pin", path: BASH, managed: BASH });
});

test("plan: non-windows never pins", () => {
  assert.deepEqual(plan({ platform: "darwin", current: null, managed: BASH }), { action: "keep", managed: BASH });
});

test("plan: system Git for Windows needs no pin", () => {
  assert.deepEqual(plan({ systemGitBash: true }), { action: "keep", managed: null });
});

test("plan: missing bundle cannot pin", () => {
  assert.deepEqual(plan({ bundledBashExists: false }), { action: "keep", managed: null });
});

test("plan: already pinned at the current bundle path is a no-op that claims the marker", () => {
  assert.deepEqual(plan({ current: BASH, managed: null }), { action: "keep", managed: BASH });
  assert.deepEqual(plan({ current: BASH, managed: BASH }), { action: "keep", managed: BASH });
});

test("plan: our stale pin follows the app or is dropped with the bundle", () => {
  const old = "C:\\Users\\x\\AppData\\Local\\Old Install\\resources\\git\\bin\\bash.exe";
  // App reinstalled elsewhere: repoint.
  assert.deepEqual(plan({ current: old, managed: old }), { action: "repoint", path: BASH, managed: BASH });
  // Bundle no longer ships git: remove so pi falls back to auto-discovery.
  assert.deepEqual(plan({ current: old, managed: old, bundledBashExists: false }), { action: "remove", managed: null });
});

test("plan: a user-chosen shellPath is never touched", () => {
  const own = "D:\\tools\\bash.exe";
  assert.deepEqual(plan({ current: own }), { action: "keep", managed: null });
  // Even when a stale managed marker exists alongside a different user path.
  assert.deepEqual(plan({ current: own, managed: BASH }), { action: "keep", managed: BASH });
});

test("plan: non-string shellPath garbage reads as unpinned", () => {
  assert.deepEqual(plan({ current: null }), { action: "pin", path: BASH, managed: BASH });
});

function fakeInstall(dir, withGit = true) {
  const resourcesDir = join(dir, `install-${Math.random().toString(36).slice(2)}`);
  if (withGit) {
    mkdirSync(join(resourcesDir, "git", "bin"), { recursive: true });
    writeFileSync(join(resourcesDir, "git", "bin", "bash.exe"), "stub");
  }
  return resourcesDir;
}

test("ensure: pins, is idempotent, repoints on move, drops with the bundle, respects user paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-shell-path-"));
  const agentDir = join(dir, "agent");
  try {
    const readSettings = () => JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    const readState = () => JSON.parse(readFileSync(join(agentDir, "desktop-distro.json"), "utf8"));

    // Fresh install: pin.
    const install1 = fakeInstall(dir);
    await ensureBundledBashShellPath(install1, agentDir, { platform: "win32", systemGitBash: false });
    assert.equal(readSettings().shellPath, join(install1, "git", "bin", "bash.exe"));
    assert.equal(readState().managedShellPath, join(install1, "git", "bin", "bash.exe"));

    // Second boot on the same install: nothing changes.
    await ensureBundledBashShellPath(install1, agentDir, { platform: "win32", systemGitBash: false });
    assert.equal(readSettings().shellPath, join(install1, "git", "bin", "bash.exe"));

    // App moved to a new directory: repoint.
    const install2 = fakeInstall(dir);
    await ensureBundledBashShellPath(install2, agentDir, { platform: "win32", systemGitBash: false });
    assert.equal(readSettings().shellPath, join(install2, "git", "bin", "bash.exe"));
    assert.equal(readState().managedShellPath, join(install2, "git", "bin", "bash.exe"));

    // A build without git: drop the pin and the marker.
    const noGit = fakeInstall(dir, false);
    await ensureBundledBashShellPath(noGit, agentDir, { platform: "win32", systemGitBash: false });
    assert.equal(readSettings().shellPath, undefined);
    assert.equal(readState().managedShellPath, undefined);

    // A user-chosen path is left alone.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "D:\\tools\\bash.exe" }));
    await ensureBundledBashShellPath(install1, agentDir, { platform: "win32", systemGitBash: false });
    assert.equal(readSettings().shellPath, "D:\\tools\\bash.exe");
    assert.equal(readState().managedShellPath, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
