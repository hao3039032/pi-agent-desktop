import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  disabledBuiltInSubagents,
  isBuiltInSubagentsEnabled,
  readPiSubagentsPackageActive,
  readSubagentSettings,
  writeBuiltInSubagentsEnabled,
  writeDisabledBuiltInSubagent,
} = await createJiti(import.meta.url).import("./subagent-settings.ts");

test("subagent settings default the built-in extension to disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: false, disabledBuiltIns: [] });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.deepEqual([...disabledBuiltInSubagents(settingsPath)], []);
});

test("subagent settings persist both states and preserve unrelated fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: true, disabledBuiltIns: [] });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  const first = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(first, { version: 1, builtInEnabled: true });

  await writeFile(settingsPath, JSON.stringify({ ...first, futureSetting: 3 }));
  writeBuiltInSubagentsEnabled(false, settingsPath);
  const second = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(second, { version: 1, builtInEnabled: false, futureSetting: 3 });
});

test("disabling a built-in is a minimal edit of the stored name list", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  writeDisabledBuiltInSubagent("explore", true, settingsPath);
  assert.deepEqual([...disabledBuiltInSubagents(settingsPath)], ["explore"]);
  // The feature switch and any unknown field survive the write.
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1,
    builtInEnabled: true,
    disabledBuiltIns: ["explore"],
  });

  writeDisabledBuiltInSubagent("plan", true, settingsPath);
  writeDisabledBuiltInSubagent("explore", true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, ["explore", "plan"]);

  // A name is matched case-insensitively, and re-enabling one leaves the other.
  writeDisabledBuiltInSubagent("EXPLORE", false, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, ["plan"]);
  writeDisabledBuiltInSubagent("plan", false, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, []);
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);

  assert.throws(() => writeDisabledBuiltInSubagent("  ", true, settingsPath));
});

test("a name no built-in claims is kept, and a damaged list is ignored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({
    version: 1,
    disabledBuiltIns: ["from-a-newer-build", 7, " explore ", "Explore", ""],
    futureSetting: 3,
  }));
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, ["from-a-newer-build", "explore"]);

  writeDisabledBuiltInSubagent("explore", false, settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1,
    disabledBuiltIns: ["from-a-newer-build"],
    futureSetting: 3,
  });

  // A switch that changes nothing does not rewrite the file at all.
  const untouched = JSON.stringify({ disabledBuiltIns: ["from-a-newer-build"] });
  await writeFile(settingsPath, untouched);
  writeDisabledBuiltInSubagent("plan", false, settingsPath);
  writeDisabledBuiltInSubagent("From-A-Newer-Build", true, settingsPath);
  assert.equal(await readFile(settingsPath, "utf8"), untouched);

  await writeFile(settingsPath, JSON.stringify({ version: 1, disabledBuiltIns: "explore" }));
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, []);
});

test("damaged settings fail closed and are not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, "{");

  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.throws(() => readSubagentSettings(settingsPath));
  assert.throws(() => writeBuiltInSubagentsEnabled(true, settingsPath));
  assert.throws(() => writeDisabledBuiltInSubagent("explore", true, settingsPath));
  // Fails open: an unreadable file must not hide the built-in profiles.
  assert.deepEqual([...disabledBuiltInSubagents(settingsPath)], []);
  assert.equal(await readFile(settingsPath, "utf8"), "{");
});

async function withGlobalSettings(packages, write) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-package-active-"));
  try {
    const settingsPath = join(root, "settings.json");
    if (packages !== null) {
      await writeFile(settingsPath, JSON.stringify(write ? { ...write, packages } : { packages }));
    }
    return readPiSubagentsPackageActive(settingsPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("package activity recognizes every pi-subagents entry form", async () => {
  // The canonical form a running app leaves behind, versioned or not.
  assert.equal(await withGlobalSettings(["npm:pi-subagents"]), true);
  assert.equal(await withGlobalSettings(["npm:pi-subagents@0.78.0"]), true);
  // The pi-seed absolute path the distro seeder writes first (posix and windows).
  assert.equal(await withGlobalSettings(["/opt/bundle/pi-seed/pi-subagents"]), true);
  assert.equal(await withGlobalSettings(["C:\\apps\\pi-seed\\pi-subagents"]), true);
  // An object entry keeps its per-package filters; a non-empty extension filter still activates.
  assert.equal(await withGlobalSettings([{ source: "npm:pi-subagents", extensions: ["index.ts"] }]), true);
  // A malformed (non-array) filter is not an explicit disable: fail open rather than hide the package.
  assert.equal(await withGlobalSettings([{ source: "npm:pi-subagents", extensions: "index.ts" }]), true);
  // Disabling through the Plugins panel writes empty resource filters: not active.
  assert.equal(await withGlobalSettings([{
    source: "npm:pi-subagents",
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  }]), false);
  // Any one active entry in the list is enough.
  assert.equal(await withGlobalSettings([
    "npm:pi-web-access",
    { source: "git:github.com/hao3039032/pi-model-images", extensions: [] },
    "npm:pi-subagents",
  ]), true);
});

test("package activity is false for other packages, missing keys, and damaged files", async () => {
  assert.equal(await withGlobalSettings(["npm:pi-web-access"]), false);
  assert.equal(await withGlobalSettings([
    "git:github.com/someone/pi-subagents",
  ]), false, "git sources are not recognized: the distro ships npm only");
  // A lookalike path segment inside another package's directory is not the package.
  assert.equal(await withGlobalSettings(["/opt/bundle/pi-seed/pi-web-access/pi-subagents-theme"]), false);
  assert.equal(await withGlobalSettings([]), false);
  assert.equal(await withGlobalSettings(null), false, "no settings file");
  // A damaged global settings file reads as inactive (UI hint only).
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-package-active-"));
  try {
    const settingsPath = join(root, "settings.json");
    await writeFile(settingsPath, "{");
    assert.equal(readPiSubagentsPackageActive(settingsPath), false);
    await writeFile(settingsPath, JSON.stringify({ packages: "npm:pi-subagents" }));
    assert.equal(readPiSubagentsPackageActive(settingsPath), false, "packages must be an array");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
