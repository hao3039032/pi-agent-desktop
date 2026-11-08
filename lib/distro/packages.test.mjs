import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { packageKey, reconcilePackages, RETIRED_SEED_PACKAGES } = await jiti.import("./packages.ts");

const ROOT = "C:\\Users\\a\\AppData\\Local\\Pi Agent LW\\resources\\pi-seed";
const seed = [
  { source: "npm:pi-subagents", relativePath: "npm/node_modules/pi-subagents", path: `${ROOT}\\npm\\node_modules\\pi-subagents` },
  { source: "git:github.com/o/pi-plan-mode", relativePath: "git/github.com/o/pi-plan-mode", path: `${ROOT}\\git\\github.com\\o\\pi-plan-mode` },
];

const runtime = {
  source: "npm:@anthropic-ai/sandbox-runtime",
  relativePath: "npm/node_modules/@anthropic-ai/sandbox-runtime",
  path: `${ROOT}\\npm\\node_modules\\@anthropic-ai\\sandbox-runtime`,
};

/** The bundled prompt-template plan package as revision 16 ships it. */
const promptPlan = {
  source: "npm:@codella/pi-prompt-plan@0.2.2",
  relativePath: "npm/node_modules/@codella/pi-prompt-plan",
  path: `${ROOT}\\npm\\node_modules\\@codella\\pi-prompt-plan`,
};

const PLAN_VANGUARD_KEY = "git:github.com/hao3039032/pi-plan-vanguard";

test("bundled runtimes are never registered as Pi packages on fresh installs", () => {
  const result = reconcilePackages({ entries: [], seed, runtimePackages: [runtime], previous: null });
  assert.deepEqual(result.entries, seed.map((pkg) => pkg.path));
  assert.ok(!(runtime.source in result.managed.packages));
});

for (const previous of [null, { packages: { [runtime.source]: "/old/custom/runtime" } }]) {
  test(`runtime cleanup handles moved installs, duplicates and ${previous ? "existing" : "lost"} state`, () => {
    const userEntries = ["npm:@anthropic-ai/sandbox-runtime@0.0.81", "/user/runtime", "npm:keep-me"];
    const oldMacPath = `/Applications/Pi Agent LW.app/Contents/Resources/resources/pi-seed/${runtime.relativePath}`;
    const entries = [runtime.path, { source: oldMacPath, extensions: [] }, ...userEntries];
    if (previous) entries.push(previous.packages[runtime.source]);
    const result = reconcilePackages({ entries, seed: [], runtimePackages: [runtime], previous });
    assert.deepEqual(result.entries, userEntries);
    assert.deepEqual(result.managed.packages, {});
    const again = reconcilePackages({ entries: result.entries, seed: [], runtimePackages: [runtime], previous: result.managed });
    assert.equal(again.changed, false);
  });
}

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

// Revision 16 retired pi-plan-vanguard and its sandbox runtime from the
// bundle. Old installs may still point at a bundled copy of either — the
// cleanup must recognize those registrations by their exact pi-seed-relative
// path alone, so a lost/corrupt state file and a moved install directory are
// covered, and must keep everything the user installed themselves.
test("retired plan registrations are pruned without state, across installs, separators and duplicates", () => {
  const retired = RETIRED_SEED_PACKAGES.find((pkg) => pkg.source === PLAN_VANGUARD_KEY);
  assert.ok(retired, "pi-plan-vanguard must stay in the retired list");
  const oldWindows = "D:\\Old Install\\resources\\pi-seed\\git\\github.com\\hao3039032\\pi-plan-vanguard";
  const oldMac = "/Applications/Pi Agent LW.app/Contents/Resources/resources/pi-seed/Git/github.com/hao3039032/pi-plan-vanguard/";
  const userPlan = "git:github.com/hao3039032/pi-plan-vanguard@v0.63.2";
  const userCheckout = "/home/user/repos/pi-plan-vanguard";
  const entries = [
    oldWindows,
    { source: oldMac, extensions: [] },
    oldWindows, // duplicate
    userPlan, // the user's own source form — kept
    userCheckout, // an independent local copy — kept (cannot be identified safely)
    "npm:keep-me",
  ];
  const result = reconcilePackages({ entries, seed: [seed[0]], previous: null });
  assert.deepEqual(result.entries, [userPlan, userCheckout, "npm:keep-me", seed[0].path]);
});

test("a retired sandbox runtime registration is pruned even though no bundle ships it", () => {
  // Before revision 16 the cleanup leaned on the manifest's runtimePackages
  // list; the retired package has no manifest entry any more.
  const old = `${ROOT}\\npm\\node_modules\\@anthropic-ai\\sandbox-runtime`;
  const result = reconcilePackages({ entries: [old, { source: old, skills: [] }, "npm:keep-me"], seed: [], runtimePackages: [], previous: null });
  assert.deepEqual(result.entries, ["npm:keep-me"]);
  const again = reconcilePackages({ entries: result.entries, seed: [], runtimePackages: [], previous: result.managed });
  assert.equal(again.changed, false);
});

test("a state-recorded retired path is pruned even when it sits outside pi-seed", () => {
  const previous = { packages: { [PLAN_VANGUARD_KEY]: "/old/custom/plan-vanguard" } };
  const result = reconcilePackages({ entries: ["/old/custom/plan-vanguard", "npm:keep-me"], seed: [], previous });
  assert.deepEqual(result.entries, ["npm:keep-me"]);
});

// pi dispatches extension commands before it expands prompt templates, so a
// still-installed pi-plan-vanguard would shadow the bundled /plan template.
// The template then waits (and is reported) instead of being appended next to
// a command that can never reach it; the user's plan install is never removed.
test("the plan prompt template is not seeded while the old plan extension is installed", () => {
  const entries = [PLAN_VANGUARD_KEY, "npm:keep-me"];
  const result = reconcilePackages({ entries, seed: [promptPlan, seed[0]], previous: null });
  assert.deepEqual(result.entries, [...entries, seed[0].path]);
  assert.deepEqual(result.shadowed, [{ source: promptPlan.source, shadow: PLAN_VANGUARD_KEY }]);
  assert.equal(promptPlan.source in result.managed.packages, false, "no removal memory while shadowed");

  // The user uninstalls their plan extension: the next run seeds the template.
  const uninstalled = result.entries.filter((entry) => entry !== PLAN_VANGUARD_KEY);
  const second = reconcilePackages({ entries: uninstalled, seed: [promptPlan, seed[0]], previous: result.managed });
  assert.deepEqual(second.entries, [...uninstalled, promptPlan.path]);
  assert.deepEqual(second.shadowed, []);

  // Removing the template afterwards is the user's choice: it stays out.
  const third = reconcilePackages({ entries: second.entries.filter((entry) => entry !== promptPlan.path), seed: [promptPlan, seed[0]], previous: second.managed });
  assert.deepEqual(third.entries, uninstalled);
  assert.equal(third.changed, false);
});

test("every source form of the old plan extension holds the template back", () => {
  for (const form of [
    "git:github.com/hao3039032/pi-plan-vanguard@v0.63.2",
    "https://github.com/hao3039032/pi-plan-vanguard.git",
    { source: "git:github.com/hao3039032/pi-plan-vanguard", extensions: [] },
  ]) {
    const result = reconcilePackages({ entries: [form], seed: [promptPlan], previous: null });
    assert.deepEqual(result.entries, [form], "the user's install is never removed");
    assert.deepEqual(result.shadowed, [{ source: promptPlan.source, shadow: PLAN_VANGUARD_KEY }], String(form));
  }
});

test("the user's own prompt-plan install in any version is kept, not duplicated", () => {
  for (const form of [
    "npm:@codella/pi-prompt-plan",
    "npm:@codella/pi-prompt-plan@0.1.0",
    "npm:@codella/pi-prompt-plan@0.2.2",
    { source: "npm:@codella/pi-prompt-plan@0.2.2", prompts: [] },
  ]) {
    const result = reconcilePackages({ entries: [form], seed: [promptPlan], previous: null });
    assert.deepEqual(result.entries, [form], String(form));
    assert.deepEqual(result.shadowed, [], String(form));
    assert.deepEqual(result.managed.packages, {}, String(form));
  }
});

test("seeding the plan template is idempotent across restarts", () => {
  const first = reconcilePackages({ entries: [], seed: [promptPlan], previous: null });
  assert.deepEqual(first.entries, [promptPlan.path]);
  const second = reconcilePackages({ entries: first.entries, seed: [promptPlan], previous: first.managed });
  assert.equal(second.changed, false);
  assert.deepEqual(second.shadowed, []);
  assert.deepEqual(second.managed.packages, first.managed.packages);
});
