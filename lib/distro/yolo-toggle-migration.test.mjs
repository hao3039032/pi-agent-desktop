import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { parse as parseJsonc } from "jsonc-parser";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { applyYoloToggleMigration, PERMISSION_SYSTEM_CONFIG, YOLO_TOGGLE_CONFIG } = await jiti.import("./yolo-toggle-migration.ts");
const { DISTRO } = await jiti.import("./config.ts");

const PERMISSION = "extensions/pi-permission-system/config.json";
const TOGGLE = "extensions/pi-permission-yolo-toggle/config.json";

function sandbox(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "distro-yolo-toggle-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  return agentDir;
}

function write(agentDir, name, value) {
  const path = join(agentDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function read(agentDir, name) {
  return JSON.parse(readFileSync(join(agentDir, name), "utf8"));
}

/** The config release 0.8.703 seeded (the current seed minus this release's change). */
function seededBefore(overrides = {}) {
  const config = structuredClone(DISTRO.agentFiles[PERMISSION]);
  return { ...config, yoloMode: true, authorizerChain: ["pi-auto-review"], ...overrides };
}

test("the seeded yoloMode default moves onto the yolo-session link, first in the chain", (t) => {
  const agentDir = sandbox(t);
  write(agentDir, PERMISSION, seededBefore());
  assert.equal(PERMISSION, PERMISSION_SYSTEM_CONFIG);
  assert.equal(TOGGLE, YOLO_TOGGLE_CONFIG);

  assert.deepEqual(applyYoloToggleMigration(agentDir), { written: [TOGGLE, PERMISSION], kept: [] });
  const config = read(agentDir, PERMISSION);
  assert.equal("yoloMode" in config, false);
  assert.deepEqual(config.authorizerChain, ["yolo-session", "pi-auto-review"]);
  // Everything else is the user's file as it was.
  const rest = structuredClone(seededBefore());
  delete rest.yoloMode;
  delete rest.authorizerChain;
  assert.deepEqual({ ...config, authorizerChain: undefined }, { ...rest, authorizerChain: undefined });
  assert.deepEqual(read(agentDir, TOGGLE), { defaultEnabled: true });
  if (process.platform !== "win32") assert.equal(statSync(join(agentDir, TOGGLE)).mode & 0o777, 0o600);

  // A re-run (a lost receipt) finds a config that already names the link and
  // carries no yoloMode: nothing to do, and nothing is read back as "off".
  const once = readFileSync(join(agentDir, PERMISSION), "utf8");
  assert.deepEqual(applyYoloToggleMigration(agentDir), { written: [], kept: [] });
  assert.equal(readFileSync(join(agentDir, PERMISSION), "utf8"), once);
  assert.deepEqual(read(agentDir, TOGGLE), { defaultEnabled: true });
});

test("a fresh install's seeded config is this release's already: nothing is written, no toggle file either", (t) => {
  const agentDir = sandbox(t);
  // agentFiles runs before the release migrations (lib/distro/seed.ts), so a
  // first start reaches this step with the new seed on disk and no old state.
  write(agentDir, PERMISSION, DISTRO.agentFiles[PERMISSION]);
  assert.deepEqual(applyYoloToggleMigration(agentDir, { newlySeededFiles: new Set([PERMISSION]) }), { written: [], kept: [] });
  assert.equal(existsSync(join(agentDir, TOGGLE)), false);
  // A config the user copied without the key, but still on the old chain,
  // is a legacy install that never had YOLO on: the link is added, YOLO stays off.
  write(agentDir, PERMISSION, { ...DISTRO.agentFiles[PERMISSION], authorizerChain: ["pi-auto-review"] });
  assert.deepEqual(applyYoloToggleMigration(agentDir), { written: [TOGGLE, PERMISSION], kept: [] });
  assert.deepEqual(read(agentDir, PERMISSION).authorizerChain, ["yolo-session", "pi-auto-review"]);
  assert.deepEqual(read(agentDir, TOGGLE), { defaultEnabled: false });
});

test("a pre-existing file exactly equal to the current seed is not mistaken for a fresh install", (t) => {
  const agentDir = sandbox(t);
  write(agentDir, PERMISSION, DISTRO.agentFiles[PERMISSION]);
  const before = readFileSync(join(agentDir, PERMISSION), "utf8");
  assert.deepEqual(applyYoloToggleMigration(agentDir), { written: [TOGGLE], kept: [] });
  assert.deepEqual(read(agentDir, TOGGLE), { defaultEnabled: false });
  assert.equal(readFileSync(join(agentDir, PERMISSION), "utf8"), before);
});

test("an install that had YOLO off, by switch or by never having it on, does not gain it", (t) => {
  for (const overrides of [{ yoloMode: false }, { yoloMode: undefined }]) {
    const agentDir = sandbox(t);
    write(agentDir, PERMISSION, seededBefore(overrides));
    applyYoloToggleMigration(agentDir);
    const config = read(agentDir, PERMISSION);
    assert.equal("yoloMode" in config, false);
    assert.deepEqual(config.authorizerChain, ["yolo-session", "pi-auto-review"]);
    assert.deepEqual(read(agentDir, TOGGLE), { defaultEnabled: false });
  }
});

test("a chain the user placed yolo-session in keeps its order; an absent chain names only the link", (t) => {
  const agentDir = sandbox(t);
  write(agentDir, PERMISSION, seededBefore({ authorizerChain: ["pi-auto-review", "yolo-session"] }));
  applyYoloToggleMigration(agentDir);
  assert.deepEqual(read(agentDir, PERMISSION).authorizerChain, ["pi-auto-review", "yolo-session"]);

  const withoutChain = sandbox(t);
  write(withoutChain, PERMISSION, seededBefore({ authorizerChain: undefined }));
  assert.deepEqual(applyYoloToggleMigration(withoutChain), { written: [TOGGLE, PERMISSION], kept: [] });
  assert.deepEqual(read(withoutChain, PERMISSION).authorizerChain, ["yolo-session"]);
});

test("the user's own toggle config is kept, whatever the old switch said", (t) => {
  const agentDir = sandbox(t);
  write(agentDir, PERMISSION, seededBefore());
  write(agentDir, TOGGLE, { defaultEnabled: false, statusOn: "YOLO" });
  assert.deepEqual(applyYoloToggleMigration(agentDir), { written: [PERMISSION], kept: [`${TOGGLE} exists: its defaultEnabled kept`] });
  assert.deepEqual(read(agentDir, TOGGLE), { defaultEnabled: false, statusOn: "YOLO" });
  assert.deepEqual(read(agentDir, PERMISSION).authorizerChain, ["yolo-session", "pi-auto-review"]);
});

test("a fresh install has no permission config yet: nothing is written for it", (t) => {
  const agentDir = sandbox(t);
  assert.deepEqual(applyYoloToggleMigration(agentDir), { written: [], kept: [] });
  assert.deepEqual(existsSync(join(agentDir, PERMISSION)), false);
  assert.deepEqual(existsSync(join(agentDir, TOGGLE)), false);
});

test("a config that cannot be used fails the step and is left untouched, toggle included", (t) => {
  const agentDir = sandbox(t);
  write(agentDir, PERMISSION, "{");
  assert.throws(() => applyYoloToggleMigration(agentDir), /not valid JSON/);
  assert.equal(readFileSync(join(agentDir, PERMISSION), "utf8"), "{");
  assert.equal(existsSync(join(agentDir, TOGGLE)), false);

  write(agentDir, PERMISSION, seededBefore({ authorizerChain: "pi-auto-review" }));
  assert.throws(() => applyYoloToggleMigration(agentDir), /authorizerChain is not an array/);
  assert.equal(existsSync(join(agentDir, TOGGLE)), false);
  assert.equal(read(agentDir, PERMISSION).yoloMode, true);
});

test("a retry after the toggle was written but the config was not yet edited reads the recorded state", (t) => {
  const agentDir = sandbox(t);
  write(agentDir, PERMISSION, seededBefore());
  write(agentDir, TOGGLE, { defaultEnabled: true });
  assert.deepEqual(applyYoloToggleMigration(agentDir), { written: [PERMISSION], kept: [`${TOGGLE} exists: its defaultEnabled kept`] });
  assert.equal("yoloMode" in read(agentDir, PERMISSION), false);
  assert.deepEqual(read(agentDir, TOGGLE), { defaultEnabled: true });
});

test("a valid toggle missing defaultEnabled gains the old boolean state without losing its labels", (t) => {
  const agentDir = sandbox(t);
  write(agentDir, PERMISSION, seededBefore());
  write(agentDir, TOGGLE, { statusOn: "YOLO on", statusOff: "YOLO off" });
  assert.deepEqual(applyYoloToggleMigration(agentDir), { written: [TOGGLE, PERMISSION], kept: [] });
  assert.deepEqual(read(agentDir, TOGGLE), {
    statusOn: "YOLO on",
    statusOff: "YOLO off",
    defaultEnabled: true,
  });
});

test("an invalid existing toggle is rejected strictly before either file changes", (t) => {
  for (const invalid of [
    "{",
    "",
    "   \n",
    "[]",
    "\uFEFF{\"defaultEnabled\":false}",
    '{"defaultEnabled":"yes"}',
    '{"statusOn":1}',
    '{"statusOff":false}',
    '{ // JSONC is not valid for this extension\n "defaultEnabled": true\n}',
  ]) {
    const agentDir = sandbox(t);
    write(agentDir, PERMISSION, seededBefore());
    write(agentDir, TOGGLE, invalid);
    const permissionBefore = readFileSync(join(agentDir, PERMISSION), "utf8");
    assert.throws(() => applyYoloToggleMigration(agentDir), /pi-permission-yolo-toggle\/config\.json/);
    assert.equal(readFileSync(join(agentDir, PERMISSION), "utf8"), permissionBefore);
    assert.equal(readFileSync(join(agentDir, TOGGLE), "utf8"), invalid);
  }
});

test("fixing a rejected toggle makes the same migration retry successfully", (t) => {
  const agentDir = sandbox(t);
  write(agentDir, PERMISSION, seededBefore());
  write(agentDir, TOGGLE, '{"defaultEnabled":1}');
  assert.throws(() => applyYoloToggleMigration(agentDir), /defaultEnabled must be a boolean/);
  assert.equal(read(agentDir, PERMISSION).yoloMode, true);

  write(agentDir, TOGGLE, { defaultEnabled: false });
  assert.deepEqual(applyYoloToggleMigration(agentDir), {
    written: [PERMISSION],
    kept: [`${TOGGLE} exists: its defaultEnabled kept`],
  });
  assert.equal("yoloMode" in read(agentDir, PERMISSION), false);
  assert.deepEqual(read(agentDir, TOGGLE), { defaultEnabled: false });
});

test("an old dormant yolo-session chain without a toggle fails closed instead of inheriting the new default", (t) => {
  const agentDir = sandbox(t);
  const dormant = { ...structuredClone(DISTRO.agentFiles[PERMISSION]), debugLog: true };
  write(agentDir, PERMISSION, dormant);
  const before = readFileSync(join(agentDir, PERMISSION), "utf8");
  assert.deepEqual(applyYoloToggleMigration(agentDir), { written: [TOGGLE], kept: [] });
  assert.deepEqual(read(agentDir, TOGGLE), { defaultEnabled: false });
  assert.equal(readFileSync(join(agentDir, PERMISSION), "utf8"), before, "the dormant permission file needs no rewrite");

  // Once a valid toggle exists, a lost receipt must not overwrite the user's choice.
  write(agentDir, TOGGLE, { defaultEnabled: true });
  assert.deepEqual(applyYoloToggleMigration(agentDir), { written: [], kept: [] });
  assert.deepEqual(read(agentDir, TOGGLE), { defaultEnabled: true });
});

test("JSONC permission config keeps comments and catastrophic deny rules through targeted edits", (t) => {
  const agentDir = sandbox(t);
  const commented = `// retain the file header\n${JSON.stringify(seededBefore(), null, 2)}`
    .replace('"permissionReviewLog": true,', '"permissionReviewLog": true, // retain this setting')
    .replace('"rm -rf /": "deny",', '/* retain hard-deny policy */\n        "rm -rf /": "deny",');
  write(agentDir, PERMISSION, commented);

  applyYoloToggleMigration(agentDir);
  const migrated = readFileSync(join(agentDir, PERMISSION), "utf8");
  assert.match(migrated, /retain the file header/);
  assert.match(migrated, /retain this setting/);
  assert.match(migrated, /retain hard-deny policy/);
  const errors = [];
  const config = parseJsonc(migrated, errors, { allowTrailingComma: true });
  assert.deepEqual(errors, []);
  assert.equal("yoloMode" in config, false);
  assert.deepEqual(config.authorizerChain, ["yolo-session", "pi-auto-review"]);
  assert.equal(config.permission.bash["rm -rf /"], "deny");
  assert.deepEqual(read(agentDir, TOGGLE), { defaultEnabled: true });
  if (process.platform !== "win32") {
    assert.equal(statSync(join(agentDir, PERMISSION)).mode & 0o777, 0o600);
    assert.equal(statSync(join(agentDir, TOGGLE)).mode & 0o777, 0o600);
  }
});

test("a non-boolean yoloMode is reported and kept; a chain with other links keeps them", (t) => {
  const agentDir = sandbox(t);
  write(agentDir, PERMISSION, seededBefore({ yoloMode: "yes", authorizerChain: ["model-judge", "pi-auto-review"] }));
  assert.deepEqual(applyYoloToggleMigration(agentDir), {
    written: [TOGGLE, PERMISSION],
    kept: [`${PERMISSION}: yoloMode is not a boolean; left as is`],
  });
  const config = read(agentDir, PERMISSION);
  assert.equal(config.yoloMode, "yes");
  assert.deepEqual(config.authorizerChain, ["yolo-session", "model-judge", "pi-auto-review"]);
  assert.deepEqual(read(agentDir, TOGGLE), { defaultEnabled: false });

  // With the link already in place such a value is no state to carry over: left alone.
  write(agentDir, PERMISSION, seededBefore({ yoloMode: "yes", authorizerChain: ["yolo-session", "pi-auto-review"] }));
  assert.deepEqual(applyYoloToggleMigration(agentDir), { written: [], kept: [] });
  assert.equal(read(agentDir, PERMISSION).yoloMode, "yes");
});

test("deleting a first yoloMode property preserves its line and block comments", (t) => {
  for (const comment of ["// first-property line comment", "/* first-property\n * block comment */"]) {
    const agentDir = sandbox(t);
    write(agentDir, PERMISSION, `{\n  ${comment}\n  "yoloMode": true,\n  "authorizerChain": ["pi-auto-review"],\n  "permissionReviewLog": true\n}\n`);
    applyYoloToggleMigration(agentDir);
    const migrated = readFileSync(join(agentDir, PERMISSION), "utf8");
    assert.match(migrated, /first-property/);
    const errors = [];
    const config = parseJsonc(migrated, errors, { allowTrailingComma: true });
    assert.deepEqual(errors, []);
    assert.equal("yoloMode" in config, false);
    assert.deepEqual(config.authorizerChain, ["yolo-session", "pi-auto-review"]);
    assert.equal(config.permissionReviewLog, true);
  }
});

test("duplicate migration keys are rejected before either config file is written", (t) => {
  for (const [key, source] of [
    ["authorizerChain", '{\n  "authorizerChain": ["yolo-session"],\n  "yoloMode": false,\n  "authorizerChain": ["pi-auto-review"]\n}\n'],
    ["yoloMode", '{\n  "yoloMode": false,\n  "authorizerChain": ["pi-auto-review"],\n  "yoloMode": true\n}\n'],
  ]) {
    const agentDir = sandbox(t);
    write(agentDir, PERMISSION, source);
    const toggleBefore = '{"defaultEnabled":false,"statusOn":"keep"}\n';
    write(agentDir, TOGGLE, toggleBefore);
    assert.throws(() => applyYoloToggleMigration(agentDir), new RegExp(`duplicate ${key} key`));
    assert.equal(readFileSync(join(agentDir, PERMISSION), "utf8"), source);
    assert.equal(readFileSync(join(agentDir, TOGGLE), "utf8"), toggleBefore);
  }
});

test("migration rewrites symlink targets without replacing either config symlink", async (t) => {
  const { fileSymlinkSkip } = await import("../../scripts/test-platform.mjs");
  if (fileSymlinkSkip) return t.skip(fileSymlinkSkip);

  const permissionLinks = sandbox(t);
  const permissionTarget = write(permissionLinks, "dotfiles/permission.json", seededBefore());
  const permissionLink = join(permissionLinks, PERMISSION);
  mkdirSync(dirname(permissionLink), { recursive: true });
  symlinkSync(permissionTarget, permissionLink, "file");
  applyYoloToggleMigration(permissionLinks);
  assert.ok(lstatSync(permissionLink).isSymbolicLink());
  assert.equal("yoloMode" in JSON.parse(readFileSync(permissionTarget, "utf8")), false);
  assert.equal(lstatSync(join(permissionLinks, TOGGLE)).isSymbolicLink(), false);
  if (process.platform !== "win32") assert.equal(statSync(permissionTarget).mode & 0o777, 0o600);

  const toggleLinks = sandbox(t);
  write(toggleLinks, PERMISSION, seededBefore());
  const toggleTarget = write(toggleLinks, "dotfiles/toggle.json", { statusOn: "YOLO" });
  const toggleLink = join(toggleLinks, TOGGLE);
  mkdirSync(dirname(toggleLink), { recursive: true });
  symlinkSync(toggleTarget, toggleLink, "file");
  applyYoloToggleMigration(toggleLinks);
  assert.ok(lstatSync(toggleLink).isSymbolicLink());
  assert.deepEqual(JSON.parse(readFileSync(toggleTarget, "utf8")), { statusOn: "YOLO", defaultEnabled: true });
  if (process.platform !== "win32") assert.equal(statSync(toggleTarget).mode & 0o777, 0o600);
});
