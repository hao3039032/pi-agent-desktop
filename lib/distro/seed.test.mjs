import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { seedAgentDir } = await jiti.import("./seed.ts");

/** A minimal pi-seed manifest: no packages, so only the migrations are under test. */
const MANIFEST = { distro: "lw", revision: 2, seedVersion: "test-1", packages: [] };

function sandbox(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "distro-seed-agent-"));
  const resourcesDir = mkdtempSync(join(tmpdir(), "distro-seed-resources-"));
  const home = mkdtempSync(join(tmpdir(), "distro-seed-home-"));
  mkdirSync(join(resourcesDir, "pi-seed"), { recursive: true });
  writeFileSync(join(resourcesDir, "pi-seed", "manifest.json"), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  t.after(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(resourcesDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  return { agentDir, resourcesDir, home };
}

/**
 * `seedAgentDir()` takes the agent dir as an argument, but `refreshProviderModels()`
 * reaches for it through the SDK's `getAgentDir()`. Point that at the sandbox as
 * well: a temp dir holds no `lw` provider, so the refresh returns before writing
 * anything, and the real `~/.pi/agent` is never read or written. HOME is redirected
 * for the same reason — the MCP migration reads `~/.config/mcp/mcp.json` and
 * friends, whose content on the developer's machine must not leak into this test.
 */
function useSandboxDirs(t, agentDir, home) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = home;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
}

function writeConfig(agentDir, name, contents) {
  const path = join(agentDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`);
  return path;
}

function readConfig(agentDir, name) {
  return JSON.parse(readFileSync(join(agentDir, name), "utf8"));
}

function readDistroState(agentDir) {
  return JSON.parse(readFileSync(join(agentDir, "desktop-distro.json"), "utf8"));
}

test("204 upgrade removes runtime registration before the SDK loads extensions, without deleting the dependency", async (t) => {
  const { agentDir, resourcesDir, home } = sandbox(t);
  useSandboxDirs(t, agentDir, home);
  const runtime = {
    source: "npm:@anthropic-ai/sandbox-runtime",
    path: "npm/node_modules/@anthropic-ai/sandbox-runtime",
    version: "0.0.81",
  };
  const extension = { source: "npm:test-extension", path: "npm/node_modules/test-extension" };
  const runtimeDir = join(resourcesDir, "pi-seed", runtime.path);
  const extensionDir = join(resourcesDir, "pi-seed", extension.path);
  // A real dependency-shaped package: not a Pi extension entry point.
  writeConfig(runtimeDir, "package.json", { name: "@anthropic-ai/sandbox-runtime", type: "module", exports: "./dist/index.js" });
  writeConfig(runtimeDir, "dist/marker.json", { installed: true });
  writeFileSync(join(runtimeDir, "dist/index.js"), "export const SandboxManager = {};\n");
  writeConfig(extensionDir, "package.json", { name: "test-extension", type: "module", pi: { extensions: ["./index.js"] } });
  writeFileSync(join(extensionDir, "index.js"), "export default function () {}\n");
  writeConfig(resourcesDir, "pi-seed/manifest.json", {
    ...MANIFEST, seedVersion: "fixed", packages: [extension], runtimePackages: [runtime],
  });
  writeConfig(agentDir, "settings.json", { packages: [extensionDir, runtimeDir], customPreference: "keep" });
  writeConfig(agentDir, "desktop-distro.json", {
    distro: "lw", seedVersion: "204", defaultsApplied: true,
    packages: { [runtime.source]: runtimeDir, [extension.source]: extensionDir },
  });

  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const loadExtensions = async () => {
    const loader = new DefaultResourceLoader({
      cwd: home, agentDir, settingsManager: SettingsManager.create(home, agentDir),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    return loader.getExtensions();
  };
  const before = await loadExtensions();
  assert.ok(before.errors.some((error) => error.path === runtimeDir), JSON.stringify(before.errors));

  await seedAgentDir(resourcesDir, agentDir);
  const settings = readConfig(agentDir, "settings.json");
  assert.deepEqual(settings.packages, [extensionDir]);
  assert.equal(settings.customPreference, "keep");
  assert.ok(!(runtime.source in readDistroState(agentDir).packages));
  assert.deepEqual(readConfig(runtimeDir, "dist/marker.json"), { installed: true });
  const after = await loadExtensions();
  assert.deepEqual(after.errors, []);
  assert.ok(after.extensions.some((entry) => entry.path === join(extensionDir, "index.js")));
  await seedAgentDir(resourcesDir, agentDir);
  assert.deepEqual(readConfig(agentDir, "settings.json").packages, [extensionDir]);
});

// The whole feature rests on this: `migrations.toolActivation` is the only thing
// that keeps a deleted key deleted, because the value check cannot tell a key the
// user removed from one that was never seeded.
test("lazy tool activation is seeded once and stays deleted after the user removes it", async (t) => {
  const { agentDir, resourcesDir, home } = sandbox(t);
  useSandboxDirs(t, agentDir, home);

  writeConfig(agentDir, "web-search.json", { provider: "gemini" });
  writeConfig(agentDir, "extensions/subagent/config.json", { timeoutMs: 3600000 });

  await seedAgentDir(resourcesDir, agentDir);

  assert.equal(readConfig(agentDir, "web-search.json").toolActivation, "dynamic");
  assert.equal(readConfig(agentDir, "extensions/subagent/config.json").toolActivation, "dynamic");
  assert.equal(readDistroState(agentDir).migrations.toolActivation, true);

  // The user deletes the key to fall back to the extension's own `auto`.
  const webSearch = readConfig(agentDir, "web-search.json");
  delete webSearch.toolActivation;
  writeFileSync(join(agentDir, "web-search.json"), `${JSON.stringify(webSearch, null, 2)}\n`);

  await seedAgentDir(resourcesDir, agentDir);

  const after = readConfig(agentDir, "web-search.json");
  assert.equal(after.toolActivation, undefined);
  assert.equal(after.provider, "gemini");
  const subagent = readConfig(agentDir, "extensions/subagent/config.json");
  assert.equal(subagent.toolActivation, "dynamic");
  assert.equal(subagent.timeoutMs, 3600000);
  assert.equal(readDistroState(agentDir).migrations.toolActivation, true);
});

// Revision 2 seeded a defaultPlanTools without the delegation names, and the
// lazy loaders it also introduced made pi-plan-vanguard block `subagents_enable`
// in Plan mode. The revision-3 migration fixed that list; revision 16 removed
// the plan extension from the bundle entirely, and with it this migration:
// an existing pi-plan-vanguard.json (still read by a user's own install of
// the extension) and the receipt of the migration that already ran are both
// history now — nothing may write or rewrite that config again.
test("no plan config is written and old receipts are preserved as history", async (t) => {
  const { agentDir, resourcesDir, home } = sandbox(t);
  useSandboxDirs(t, agentDir, home);

  // An upgraded machine: the old config file, plus the receipt of the
  // revision-3 migration that ran on it.
  writeConfig(agentDir, "pi-plan-vanguard.json", { defaultPlanTools: ["read", "bash"] });
  writeConfig(agentDir, "desktop-distro.json", {
    distro: "lw", seedVersion: "old", defaultsApplied: true,
    packages: {}, migrations: { planTools: true },
  });

  await seedAgentDir(resourcesDir, agentDir);

  assert.deepEqual(readConfig(agentDir, "pi-plan-vanguard.json"), { defaultPlanTools: ["read", "bash"] });
  assert.equal(readDistroState(agentDir).migrations.planTools, true);
  assert.equal(readConfig(agentDir, "extensions/pi-auto-review/config.json").model, "lw/deepseek-v4.1-flash");
});

test("a fresh install seeds no plan config and no plan-tools receipt", async (t) => {
  const { agentDir, resourcesDir, home } = sandbox(t);
  useSandboxDirs(t, agentDir, home);

  await seedAgentDir(resourcesDir, agentDir);

  assert.throws(() => readConfig(agentDir, "pi-plan-vanguard.json"), { code: "ENOENT" });
  assert.equal(readDistroState(agentDir).migrations.planTools, undefined);
  assert.equal(readDistroState(agentDir).releaseMigrations["0.8.210"], true);
  assert.equal(readConfig(agentDir, "extensions/pi-auto-review/config.json").model, "lw/deepseek-v4.1-flash");
});

test("release migration persists across seed hash changes and does not shadow WATCHDOG.yaml", async (t) => {
  const { agentDir, resourcesDir, home } = sandbox(t);
  useSandboxDirs(t, agentDir, home);
  const old = "main: true\nadvisors:\n  - model: lw/gemini-3.8-flash # keep\n";
  writeFileSync(join(agentDir, "WATCHDOG.yaml"), old);
  writeConfig(agentDir, "models.json", { providers: { lw: { apiKey: "test-key", baseUrl: "https://custom.example", models: [{ id: "gemini-3.8-flash" }, { id: "custom-model" }] } } });
  writeConfig(agentDir, "settings.json", { defaultProvider: "lw", defaultModel: "gemini-3.8-flash" });
  await seedAgentDir(resourcesDir, agentDir);
  assert.equal(readDistroState(agentDir).releaseMigrations["0.8.210"], true);
  assert.equal(readFileSync(join(agentDir, "WATCHDOG.yaml"), "utf8"), old.replace("lw/gemini-3.8-flash", "lw/deepseek-v4.1-flash"));
  assert.throws(() => readFileSync(join(agentDir, "WATCHDOG.yml")), { code: "ENOENT" });
  const models = readConfig(agentDir, "models.json").providers.lw.models;
  assert.ok(!models.some((m) => m.id === "gemini-3.8-flash"));
  assert.ok(models.some((m) => m.id === "gemini-3.5-flash-lite"));
  assert.ok(models.some((m) => m.id === "deepseek-v4.1-flash"));
  assert.ok(models.some((m) => m.id === "custom-model"));
  assert.equal(readConfig(agentDir, "settings.json").defaultModel, "deepseek-v4.1-flash");
  writeFileSync(join(agentDir, "WATCHDOG.yaml"), old);
  writeConfig(resourcesDir, "pi-seed/manifest.json", { ...MANIFEST, seedVersion: "test-next-release" });
  await seedAgentDir(resourcesDir, agentDir);
  assert.equal(readFileSync(join(agentDir, "WATCHDOG.yaml"), "utf8"), old);
  assert.equal(readDistroState(agentDir).releaseMigrations["0.8.210"], true);
});

// The provider refresh (a seedVersion change = an app update) carries the
// distro's session-affinity compat defaults with the same only-if-absent
// merge as the service form and release migration 0.8.402: a missing pair is
// filled, a value the user set themselves is kept, and no refresh (unchanged
// seedVersion) means no write.
test("a seedVersion change fills missing session-affinity compat on the refreshed provider", async (t) => {
  const { agentDir, resourcesDir, home } = sandbox(t);
  useSandboxDirs(t, agentDir, home);
  writeConfig(agentDir, "models.json", {
    providers: { lw: { apiKey: "k", baseUrl: "https://custom.example", models: [{ id: "custom-model" }] } },
  });
  // Release receipts already recorded, so only the provider refresh runs.
  writeConfig(agentDir, "desktop-distro.json", {
    distro: "lw", seedVersion: "old", defaultsApplied: true, packages: {},
    releaseMigrations: { "0.8.210": true, "0.8.215": true, "0.8.402": true },
  });

  await seedAgentDir(resourcesDir, agentDir);

  let provider = readConfig(agentDir, "models.json").providers.lw;
  assert.equal(provider.apiKey, "k");
  assert.equal(provider.baseUrl, "https://custom.example");
  assert.ok(provider.models.some((m) => m.id === "custom-model"));
  assert.equal(provider.compat.sendSessionAffinityHeaders, true);
  assert.equal(provider.compat.sessionAffinityFormat, "openrouter");

  // The user turns it off explicitly; an unchanged seed hash never rewrites it.
  writeConfig(agentDir, "models.json", {
    providers: { lw: { ...provider, compat: { sendSessionAffinityHeaders: false } } },
  });
  await seedAgentDir(resourcesDir, agentDir);
  assert.equal(readConfig(agentDir, "models.json").providers.lw.compat.sendSessionAffinityHeaders, false);

  // The next app update refreshes again: the explicit `false` survives.
  writeConfig(resourcesDir, "pi-seed/manifest.json", { ...MANIFEST, seedVersion: "test-next-release" });
  await seedAgentDir(resourcesDir, agentDir);
  const refreshed = readConfig(agentDir, "models.json").providers.lw;
  assert.equal(refreshed.compat.sendSessionAffinityHeaders, false);
  assert.equal(refreshed.compat.sessionAffinityFormat, "openrouter");
});

test("failed release migration leaves its receipt unset and retries with an unchanged seed hash", async (t) => {
  t.mock.method(console, "warn", () => {});
  const { agentDir, resourcesDir, home } = sandbox(t);
  useSandboxDirs(t, agentDir, home);
  writeFileSync(join(agentDir, "WATCHDOG.yml"), "advisors: [");
  await seedAgentDir(resourcesDir, agentDir);
  assert.equal(readDistroState(agentDir).releaseMigrations["0.8.210"], undefined);
  writeFileSync(join(agentDir, "WATCHDOG.yml"), "advisors:\n  - model: lw/gemini-3.8-flash\n");
  await seedAgentDir(resourcesDir, agentDir);
  assert.equal(readDistroState(agentDir).releaseMigrations["0.8.210"], true);
  assert.match(readFileSync(join(agentDir, "WATCHDOG.yml"), "utf8"), /lw\/deepseek-v4\.1-flash/);
});

// Revision 16 retired pi-plan-vanguard (and with it the bundled sandbox
// runtime) in favour of the npm:@codella/pi-prompt-plan prompt template. The
// upgrade must prune exactly the bundle's own registrations — recognized by
// their pi-seed path even with the state file gone and the app moved — and
// keep the user's own plan install; while that is installed its /plan
// extension command would shadow the template (pi dispatches extension
// commands first), so the template waits and the seed says so.
test("retired plan registrations are pruned, and the template waits for the user's own plan install", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  const { agentDir, resourcesDir, home } = sandbox(t);
  useSandboxDirs(t, agentDir, home);

  const promptPkg = {
    source: "npm:@codella/pi-prompt-plan@0.2.2",
    path: "npm/node_modules/@codella/pi-prompt-plan",
    version: "0.2.2",
  };
  const pkgDir = join(resourcesDir, "pi-seed", "npm", "node_modules", "@codella", "pi-prompt-plan");
  mkdirSync(pkgDir, { recursive: true });
  writeConfig(pkgDir, "package.json", { name: "@codella/pi-prompt-plan", version: "0.2.2", type: "module", pi: { prompts: ["./prompts"] } });
  writeConfig(resourcesDir, "pi-seed/manifest.json", { ...MANIFEST, packages: [promptPkg] });

  // An old install: the state file is gone, the entries point at yesterday's
  // bundle (the app has moved), and the user tracks their own plan extension.
  const oldPlan = "/opt/old/Pi Agent LW/resources/pi-seed/git/github.com/hao3039032/pi-plan-vanguard";
  const oldSrt = "C:\\Old Pi Agent LW\\resources\\pi-seed\\npm\\node_modules\\@anthropic-ai\\sandbox-runtime";
  const userPlan = "git:github.com/hao3039032/pi-plan-vanguard@v0.63.2";
  writeConfig(agentDir, "settings.json", { packages: [oldPlan, oldSrt, userPlan], customPreference: "keep" });

  await seedAgentDir(resourcesDir, agentDir);

  // The bundle's own registrations are gone; the user's plan install stays.
  assert.deepEqual(readConfig(agentDir, "settings.json").packages, [userPlan]);
  assert.equal(readConfig(agentDir, "settings.json").customPreference, "keep");
  assert.ok(logs.some((line) => line.includes(promptPkg.source) && line.includes("pi-plan-vanguard")), logs.join("\n"));
  assert.equal(promptPkg.source in readDistroState(agentDir).packages, false, "a shadowed seed is not remembered as removed");

  // The user uninstalls their plan extension: the next start seeds the template.
  writeConfig(agentDir, "settings.json", { packages: [], customPreference: "keep" });
  await seedAgentDir(resourcesDir, agentDir);
  assert.deepEqual(readConfig(agentDir, "settings.json").packages, [pkgDir]);
  assert.ok(readDistroState(agentDir).packages[promptPkg.source] === pkgDir);

  // Removing the template afterwards is the user's choice: it stays out.
  writeConfig(agentDir, "settings.json", { customPreference: "keep" });
  await seedAgentDir(resourcesDir, agentDir);
  assert.deepEqual(readConfig(agentDir, "settings.json").packages ?? [], []);
});
