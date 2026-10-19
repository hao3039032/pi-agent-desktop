import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { applyLazyToolActivation, LAZY_TOOL_ACTIVATION } = await jiti.import("./lazy-tool-activation.ts");

function agentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-lazy-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(dir, name, contents) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
  return path;
}

function readConfig(dir, name) {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

test("both loader configs get the lazy default, other keys intact", (t) => {
  const dir = agentDir(t);
  writeConfig(dir, "web-search.json", { provider: "gemini", workflow: "auto-summary" });
  writeConfig(dir, "extensions/subagent/config.json", { timeoutMs: 3600000 });

  const report = applyLazyToolActivation(dir);

  assert.deepEqual(report.written.sort(), ["extensions/subagent/config.json", "web-search.json"]);
  assert.deepEqual(report.kept, []);
  assert.deepEqual(report.invalid, []);
  assert.equal(LAZY_TOOL_ACTIVATION, "dynamic");
  assert.deepEqual(readConfig(dir, "web-search.json"), {
    provider: "gemini",
    workflow: "auto-summary",
    toolActivation: "dynamic",
  });
  assert.deepEqual(readConfig(dir, "extensions/subagent/config.json"), {
    timeoutMs: 3600000,
    toolActivation: "dynamic",
  });
});

// `eager` is a deliberate answer to the same trade-off (keep the schemas
// declared rather than pay one cache miss when the loader runs). A distro
// default must never overrule it, and a second pass must not rewrite the key.
test("a value the user chose is kept, and a second pass changes nothing", (t) => {
  const dir = agentDir(t);
  writeConfig(dir, "web-search.json", { toolActivation: "eager" });
  writeConfig(dir, "extensions/subagent/config.json", { toolActivation: "eager" });

  const first = applyLazyToolActivation(dir);
  assert.deepEqual(first.written, []);
  assert.deepEqual(first.kept.sort(), ["extensions/subagent/config.json", "web-search.json"]);
  assert.equal(readConfig(dir, "web-search.json").toolActivation, "eager");

  const second = applyLazyToolActivation(dir);
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.kept.sort(), ["extensions/subagent/config.json", "web-search.json"]);
  assert.equal(readConfig(dir, "extensions/subagent/config.json").toolActivation, "eager");
});

test("missing config files are left to the seed and the extensions' defaults", (t) => {
  const dir = agentDir(t);

  const report = applyLazyToolActivation(dir);

  assert.deepEqual(report.written, []);
  assert.deepEqual(report.kept, []);
  assert.deepEqual(report.invalid, []);
  assert.equal(existsSync(join(dir, "web-search.json")), false);
  assert.equal(existsSync(join(dir, "extensions/subagent/config.json")), false);
});

// The value check cannot tell a key the user deleted from one that was never
// seeded, so a second run after losing `migrations.toolActivation` writes
// `dynamic` back. That is exactly why the state flag — not this function — is
// the only thing protecting the "deleted the key to fall back to auto" case
// (lib/distro/seed.ts, lib/distro/seed.test.mjs).
test("a deleted key is filled back in: the state flag is the only protection", (t) => {
  const dir = agentDir(t);
  writeConfig(dir, "web-search.json", { provider: "gemini" });

  assert.deepEqual(applyLazyToolActivation(dir).written, ["web-search.json"]);

  const config = readConfig(dir, "web-search.json");
  delete config.toolActivation;
  writeConfig(dir, "web-search.json", config);

  const again = applyLazyToolActivation(dir);
  assert.deepEqual(again.written, ["web-search.json"]);
  assert.equal(readConfig(dir, "web-search.json").toolActivation, "dynamic");
});

test("an unparsable config is reported, never overwritten", (t) => {
  const dir = agentDir(t);
  const broken = "{ not json";
  writeConfig(dir, "web-search.json", broken);
  writeConfig(dir, "extensions/subagent/config.json", { toolActivation: "dynamic" });

  const report = applyLazyToolActivation(dir);

  assert.deepEqual(report.invalid, ["web-search.json"]);
  assert.deepEqual(report.written, []);
  assert.equal(readFileSync(join(dir, "web-search.json"), "utf8"), broken);
});
