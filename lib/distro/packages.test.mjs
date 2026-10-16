import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { packageKey, reconcilePackages } = await jiti.import("./packages.ts");

const ROOT = "C:\\Users\\a\\AppData\\Local\\Pi Agent LW\\resources\\pi-seed";
const seed = [
  { source: "npm:pi-subagents", relativePath: "npm/node_modules/pi-subagents", path: `${ROOT}\\npm\\node_modules\\pi-subagents` },
  { source: "git:github.com/o/pi-plan-mode", relativePath: "git/github.com/o/pi-plan-mode", path: `${ROOT}\\git\\github.com\\o\\pi-plan-mode` },
];

test("package keys ignore versions, refs and protocols", () => {
  assert.equal(packageKey("npm:pi-subagents@^0.7"), "npm:pi-subagents");
  assert.equal(packageKey("npm:@scope/pkg@1.2.3"), "npm:@scope/pkg");
  assert.equal(packageKey("git:github.com/O/Repo@v1"), "git:github.com/o/repo");
  assert.equal(packageKey("https://github.com/o/repo.git"), "git:github.com/o/repo");
  assert.equal(packageKey("git@github.com:o/repo"), "git:github.com/o/repo");
  assert.equal(packageKey("/abs/local/path"), null);
  assert.equal(packageKey("./relative"), null);
});

test("fresh install appends the bundled paths", () => {
  const result = reconcilePackages({ entries: ["npm:other"], seed, previous: null });
  assert.deepEqual(result.entries, ["npm:other", seed[0].path, seed[1].path]);
  assert.equal(result.changed, true);
  assert.deepEqual(Object.keys(result.managed.packages), ["npm:pi-subagents", "git:github.com/o/pi-plan-mode"]);
});

test("user-managed npm:/git: entries are left alone, not adopted and not duplicated", () => {
  const entries = [
    "npm:pi-subagents@latest",
    "npm:keep-me",
    { source: "git:github.com/o/pi-plan-mode", skills: [] },
    "npm:pi-subagents", // duplicate of the user's own — also untouched (pi dedupes at load)
  ];
  const result = reconcilePackages({ entries, seed, previous: null });
  assert.deepEqual(result.entries, entries);
  assert.equal(result.changed, false);
  assert.deepEqual(result.managed.packages, {});
});

test("a seed entry the user replaced with their own npm: source is not re-adopted", () => {
  const first = reconcilePackages({ entries: [], seed, previous: null });
  // Today's incident shape: the seeder rewrote packages to pi-seed paths, the
  // user restored canonical npm:/git: sources by hand.
  const replaced = first.entries.map((entry) => (entry === seed[0].path ? "npm:pi-subagents" : entry));
  const second = reconcilePackages({ entries: replaced, seed, previous: first.managed });
  assert.deepEqual(second.entries, replaced);
  assert.equal(second.changed, false);
});

test("a moved install location is followed", () => {
  const old = "D:\\Apps\\Pi Agent LW\\resources\\pi-seed\\npm\\node_modules\\pi-subagents";
  const result = reconcilePackages({ entries: [old], seed: [seed[0]], previous: { packages: { "npm:pi-subagents": old } } });
  assert.deepEqual(result.entries, [seed[0].path]);
});

test("idempotent when nothing changed", () => {
  const first = reconcilePackages({ entries: [], seed, previous: null });
  const second = reconcilePackages({ entries: first.entries, seed, previous: first.managed });
  assert.equal(second.changed, false);
  assert.deepEqual(second.managed, first.managed);
});

test("a package the user removed stays removed", () => {
  const first = reconcilePackages({ entries: [], seed, previous: null });
  const withoutPlan = first.entries.filter((entry) => entry !== seed[1].path);
  const second = reconcilePackages({ entries: withoutPlan, seed, previous: first.managed });
  assert.deepEqual(second.entries, [seed[0].path]);
  assert.equal(second.changed, false);
  assert.ok("git:github.com/o/pi-plan-mode" in second.managed.packages, "removal is remembered");
  const third = reconcilePackages({ entries: second.entries, seed, previous: second.managed });
  assert.deepEqual(third.entries, [seed[0].path]);
});

test("a package dropped from the bundle is pruned and not remembered as removed", () => {
  const first = reconcilePackages({ entries: [], seed, previous: null });
  // The next bundle ships pi-subagents only; plan-mode's bundled copy is gone.
  const nextSeed = [seed[0]];
  const second = reconcilePackages({ entries: first.entries, seed: nextSeed, previous: first.managed });
  assert.deepEqual(second.entries, [seed[0].path], "the dangling pi-seed path entry is removed");
  assert.equal(second.changed, true);
  assert.ok(!("git:github.com/o/pi-plan-mode" in second.managed.packages), "no removal memory for dropped packages");
  // Re-bundling it later re-adds it (the state no longer pretends the user removed it).
  const third = reconcilePackages({ entries: second.entries, seed, previous: second.managed });
  assert.deepEqual(third.entries, [seed[0].path, seed[1].path]);
});

test("pruning a dropped package keeps entries the user manages themselves", () => {
  const first = reconcilePackages({ entries: [], seed, previous: null });
  const nextSeed = [seed[0]];
  // The user also tracks their own copy at another path: only the managed
  // pi-seed path (recorded in previous state) may be pruned.
  const own = "D:\\repos\\pi-plan-mode";
  const entries = [...first.entries, own];
  const second = reconcilePackages({ entries, seed: nextSeed, previous: first.managed });
  assert.ok(second.entries.includes(own));
  assert.ok(!second.entries.includes(seed[1].path));
});
