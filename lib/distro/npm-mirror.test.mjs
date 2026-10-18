import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const {
  mirrorNpmCommand,
  isMirrorNpmCommand,
  planNpmCommandChange,
  applyNpmMirrorEnv,
  readNpmMirrorEnabled,
  applyNpmMirrorEnvFromSettings,
} = await jiti.import("./npm-mirror.ts");

const MIRROR = "https://registry.npmmirror.com";

test("mirror command shape and detection", () => {
  assert.deepEqual(mirrorNpmCommand(MIRROR), ["npm", "--registry", MIRROR]);
  assert.equal(isMirrorNpmCommand(["npm", "--registry", MIRROR], MIRROR), true);
  assert.equal(isMirrorNpmCommand(undefined, MIRROR), false);
  assert.equal(isMirrorNpmCommand(["npm"], MIRROR), false);
  // A different registry (user's own) is a custom command, not ours.
  assert.equal(isMirrorNpmCommand(["npm", "--registry", "https://custom.example"], MIRROR), false);
  assert.equal(isMirrorNpmCommand(["npm", "--registry", MIRROR, "--extra"], MIRROR), false);
});

test("plan: enable writes ours, disable removes only ours", () => {
  // enable: absent → write
  assert.deepEqual(planNpmCommandChange(undefined, true, MIRROR), { write: true, command: ["npm", "--registry", MIRROR] });
  // enable: already ours → no write
  assert.deepEqual(planNpmCommandChange(["npm", "--registry", MIRROR], true, MIRROR), { write: false });
  // enable: custom → replaced by explicit checkbox choice
  assert.deepEqual(planNpmCommandChange(["npm", "--registry", "https://custom.example"], true, MIRROR), {
    write: true,
    command: ["npm", "--registry", MIRROR],
  });
  // disable: ours → remove (undefined clears the setting)
  assert.deepEqual(planNpmCommandChange(["npm", "--registry", MIRROR], false, MIRROR), { write: true, command: undefined });
  // disable: custom/absent → untouched
  assert.deepEqual(planNpmCommandChange(undefined, false, MIRROR), { write: false });
  assert.deepEqual(planNpmCommandChange(["npm", "--registry", "https://custom.example"], false, MIRROR), { write: false });
});

test("env: enable sets ours, disable removes only ours", () => {
  const saved = process.env.npm_config_registry;
  try {
    applyNpmMirrorEnv(true, MIRROR);
    assert.equal(process.env.npm_config_registry, MIRROR);
    applyNpmMirrorEnv(false, MIRROR);
    assert.equal(process.env.npm_config_registry, undefined);

    // A registry the user set themselves survives a disable.
    process.env.npm_config_registry = "https://custom.example";
    applyNpmMirrorEnv(false, MIRROR);
    assert.equal(process.env.npm_config_registry, "https://custom.example");
  } finally {
    if (saved === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = saved;
  }
});

test("readNpmMirrorEnabled reads settings.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "npm-mirror-"));
  try {
    assert.equal(readNpmMirrorEnabled(dir), false); // no file
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark" }));
    assert.equal(readNpmMirrorEnabled(dir), false); // no npmCommand
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ npmCommand: ["npm", "--registry", MIRROR] }));
    assert.equal(readNpmMirrorEnabled(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup apply honors a user-set registry env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "npm-mirror-"));
  const savedLower = process.env.npm_config_registry;
  const savedUpper = process.env.NPM_CONFIG_REGISTRY;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ npmCommand: ["npm", "--registry", MIRROR] }));

    // no env → ours is applied
    delete process.env.npm_config_registry;
    delete process.env.NPM_CONFIG_REGISTRY;
    applyNpmMirrorEnvFromSettings(dir);
    assert.equal(process.env.npm_config_registry, MIRROR);

    // user-set env wins
    process.env.npm_config_registry = "https://custom.example";
    applyNpmMirrorEnvFromSettings(dir);
    assert.equal(process.env.npm_config_registry, "https://custom.example");

    // disabled in settings → env untouched
    writeFileSync(join(dir, "settings.json"), JSON.stringify({}));
    delete process.env.npm_config_registry;
    applyNpmMirrorEnvFromSettings(dir);
    assert.equal(process.env.npm_config_registry, undefined);
  } finally {
    if (savedLower === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = savedLower;
    if (savedUpper === undefined) delete process.env.NPM_CONFIG_REGISTRY;
    else process.env.NPM_CONFIG_REGISTRY = savedUpper;
    rmSync(dir, { recursive: true, force: true });
  }
});
