import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  applyPlanToolsMigration,
  PRE_DELEGATION_PLAN_TOOLS,
  DELEGATION_PLAN_TOOLS,
  PLAN_TOOLS_CONFIG_FILE,
} = await jiti.import("./plan-tools-migration.ts");
const { DISTRO } = await jiti.import("./config.ts");

function agentDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-plan-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(dir, contents) {
  const path = join(dir, PLAN_TOOLS_CONFIG_FILE);
  writeFileSync(path, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
  return path;
}

function readConfig(dir) {
  return JSON.parse(readFileSync(join(dir, PLAN_TOOLS_CONFIG_FILE), "utf8"));
}

function seededPlanTools() {
  return DISTRO.agentFiles[PLAN_TOOLS_CONFIG_FILE].defaultPlanTools;
}

test("the revision-2 seed is replaced, other keys intact", (t) => {
  const dir = agentDir(t);
  writeConfig(dir, { defaultPlanTools: [...PRE_DELEGATION_PLAN_TOOLS], thinkingLevel: "inherit" });

  const report = applyPlanToolsMigration(dir);

  assert.equal(report.written, true);
  assert.deepEqual(report.kept, []);
  const config = readConfig(dir);
  assert.deepEqual(config.defaultPlanTools, seededPlanTools());
  assert.deepEqual(config.thinkingLevel, "inherit");
});

test("the seeded list carries exactly the delegation additions", (t) => {
  // The two paths must agree: what the agentFiles seed writes for a fresh
  // install is what this migration writes for an existing one.
  assert.deepEqual([...PRE_DELEGATION_PLAN_TOOLS, ...DELEGATION_PLAN_TOOLS], seededPlanTools());
});

test("a reordered revision-2 seed still matches entry-for-entry", (t) => {
  const dir = agentDir(t);
  writeConfig(dir, { defaultPlanTools: [...PRE_DELEGATION_PLAN_TOOLS].reverse() });

  const report = applyPlanToolsMigration(dir);

  assert.equal(report.written, true);
  assert.deepEqual(readConfig(dir).defaultPlanTools, seededPlanTools());
});

// The list is the user's answer to the same trade-off (which tools a Plan
// workflow may use). A default must never overrule it, and a second pass must
// not rewrite it either: the migrated list no longer matches the old seed.
test("a customized list is kept, and a second pass changes nothing", (t) => {
  const dir = agentDir(t);
  const custom = ["read", "grep", "web_enable"];
  writeConfig(dir, { defaultPlanTools: custom });

  const first = applyPlanToolsMigration(dir);
  assert.equal(first.written, false);
  assert.deepEqual(first.kept, ["defaultPlanTools was customized"]);
  assert.deepEqual(readConfig(dir).defaultPlanTools, custom);

  const second = applyPlanToolsMigration(dir);
  assert.equal(second.written, false);
  assert.deepEqual(readConfig(dir).defaultPlanTools, custom);
});

test("a trimmed seed (user removed a tool) counts as customized", (t) => {
  const dir = agentDir(t);
  const trimmed = [...PRE_DELEGATION_PLAN_TOOLS].slice(1);
  writeConfig(dir, { defaultPlanTools: trimmed });

  const report = applyPlanToolsMigration(dir);

  assert.equal(report.written, false);
  assert.deepEqual(report.kept, ["defaultPlanTools was customized"]);
  assert.deepEqual(readConfig(dir).defaultPlanTools, trimmed);
});

test("a deleted key is kept: the state flag is the only protection", (t) => {
  const dir = agentDir(t);
  writeConfig(dir, { thinkingLevel: "inherit" });

  const report = applyPlanToolsMigration(dir);

  // Without the key pi-plan-vanguard uses its built-in automatic policy; that
  // is a choice, not an omission, so nothing is written here. Fresh installs
  // get the full list from the agentFiles seed instead.
  assert.equal(report.written, false);
  assert.deepEqual(report.kept, ["no defaultPlanTools key (user deleted it)"]);
  assert.deepEqual(readConfig(dir), { thinkingLevel: "inherit" });
});

test("a missing file is left to the agentFiles seed", (t) => {
  const dir = agentDir(t);

  const report = applyPlanToolsMigration(dir);

  assert.equal(report.written, false);
  assert.deepEqual(report.kept, []);
  assert.equal(existsSync(join(dir, PLAN_TOOLS_CONFIG_FILE)), false);
});

test("a legacy config file shadows the canonical one: never created", (t) => {
  const dir = agentDir(t);
  writeFileSync(join(dir, "pi-plan-mode.json"), `${JSON.stringify({ defaultPlanTools: ["read"] })}\n`);

  const report = applyPlanToolsMigration(dir);

  assert.equal(report.written, false);
  assert.deepEqual(report.kept, ["legacy config file present"]);
  assert.equal(existsSync(join(dir, PLAN_TOOLS_CONFIG_FILE)), false);
});

test("an unparsable config is reported, never overwritten", (t) => {
  const dir = agentDir(t);
  const broken = "{ not json";
  writeConfig(dir, broken);

  const report = applyPlanToolsMigration(dir);

  assert.equal(report.written, false);
  assert.deepEqual(report.kept, ["config is not valid JSON"]);
  assert.equal(readFileSync(join(dir, PLAN_TOOLS_CONFIG_FILE), "utf8"), broken);
});
