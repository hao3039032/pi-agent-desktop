/**
 * The prompt-based /plan package (npm:@codella/pi-prompt-plan, distro
 * revision 16) end to end:
 *
 *  1. the distro seed registers the bundled copy in the user's settings
 *     (lib/distro/seed.ts → reconcilePackages);
 *  2. pi's real resource loader discovers the plan command as a *prompt
 *     template* from that package — not via a noPromptTemplates:true
 *     fixture, which is precisely what these assertions must not lean on;
 *  3. the desktop RPC's get_commands composition (the same
 *     AgentSessionWrapper code /api/agent/[id] serves) surfaces it with
 *     source "prompt" and package origin;
 *  4. `/plan <task>` expands $ARGUMENTS into the dispatched prompt.
 *
 * The model is a registered faux provider — no network, no paid API. The
 * fixture package (plan-package.fixture/) is the byte-identical copy of the
 * pinned version; the gitignored release seed only exists after
 * `npm run distro:seed`.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, tsconfigPaths: true, moduleCache: false });
const { seedAgentDir } = await jiti.import("./seed.ts");
const { AgentSessionWrapper } = await jiti.import("../rpc-manager.ts");
const { DISTRO } = await jiti.import("./config.ts");

const FIXTURE_DIR = fileURLToPath(new URL("./plan-package.fixture/", import.meta.url));
/** The source as distro.json pins it, e.g. `npm:@codella/pi-prompt-plan@0.2.2`. */
const PINNED_SOURCE = DISTRO.packages.find((source) => source.startsWith("npm:@codella/pi-prompt-plan@"));

function sandbox(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "distro-plan-agent-"));
  const resourcesDir = mkdtempSync(join(tmpdir(), "distro-plan-resources-"));
  const home = mkdtempSync(join(tmpdir(), "distro-plan-home-"));
  mkdirSync(join(resourcesDir, "pi-seed"), { recursive: true });
  t.after(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(resourcesDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  return { agentDir, resourcesDir, home };
}

/** Redirect every consumer of the real agent dir / home (see seed.test.mjs). */
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

function writeConfig(dir, name, contents) {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
  return path;
}

test("the fixture mirrors the package version the distro pins", () => {
  assert.ok(PINNED_SOURCE, "distro.json must pin npm:@codella/pi-prompt-plan@<version>");
  const pinnedVersion = PINNED_SOURCE.split("@").pop();
  const fixturePackage = JSON.parse(readFileSync(join(FIXTURE_DIR, "package.json"), "utf8"));
  assert.equal(fixturePackage.name, "@codella/pi-prompt-plan");
  assert.equal(fixturePackage.version, pinnedVersion, "refresh plan-package.fixture/ after bumping the pin");
  assert.deepEqual(fixturePackage.pi.prompts, ["./prompts"]);
});

test("the seeded /plan package is discovered, served by get_commands and expands $ARGUMENTS", async (t) => {
  const { agentDir, resourcesDir, home } = sandbox(t);
  useSandboxDirs(t, agentDir, home);

  // 1. Stage the bundled package the way scripts/distro-seed.mjs installs it.
  const pkgDir = join(resourcesDir, "pi-seed", "npm", "node_modules", "@codella", "pi-prompt-plan");
  mkdirSync(pkgDir, { recursive: true });
  cpSync(join(FIXTURE_DIR, "package.json"), join(pkgDir, "package.json"));
  cpSync(join(FIXTURE_DIR, "prompts"), join(pkgDir, "prompts"), { recursive: true });
  writeConfig(resourcesDir, "pi-seed/manifest.json", {
    distro: DISTRO.id,
    revision: DISTRO.revision,
    seedVersion: "plan-package-test",
    packages: [{ source: PINNED_SOURCE, path: "npm/node_modules/@codella/pi-prompt-plan", version: "0.2.2" }],
  });

  await seedAgentDir(resourcesDir, agentDir);
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [pkgDir], "the seed registers the bundled copy");

  // 2. pi's real loader over those settings: prompt templates stay enabled.
  const { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } =
    await import("@earendil-works/pi-coding-agent");
  const faux = fauxProvider({ models: [{ id: "faux-plan" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(home, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.create(home, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: home,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: home,
    agentDir,
    modelRuntime,
    model: faux.getModel("faux-plan"),
    sessionManager: SessionManager.inMemory(home),
    settingsManager,
    resourceLoader,
  });
  t.after(() => session.dispose());

  const template = [...session.promptTemplates].find((entry) => entry.name === "plan");
  assert.ok(template, "the plan prompt template is discovered from the package");
  assert.match(template.content, /\$ARGUMENTS/, "the template substitutes its task argument");

  // 3. The desktop RPC's get_commands composition (lib/rpc-manager.ts).
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  const { commands } = await wrapper.send({ type: "get_commands" });
  const plan = commands.find((command) => command.name === "plan");
  assert.ok(plan, "/plan is served by get_commands");
  assert.equal(plan.source, "prompt");
  assert.equal(plan.sourceInfo?.origin, "package");
  assert.equal(plan.sourceInfo?.baseDir, pkgDir, "the command is attributed to the bundled package");

  // 4. /plan <task> expands before the agent sees it (no model call needed to
  //    prove the substitution; the faux provider keeps the run offline).
  faux.setResponses([() => fauxAssistantMessage([fauxText("plan acknowledged")])]);
  await session.prompt("/plan refactor auth handling and update tests");
  const userEntry = session.sessionManager
    .getEntries()
    .find((entry) => entry.type === "message" && entry.message?.role === "user");
  const dispatched = typeof userEntry.message.content === "string"
    ? userEntry.message.content
    : JSON.stringify(userEntry.message.content);
  assert.match(dispatched, /Enter plan mode for this task: refactor auth handling and update tests/);
  assert.doesNotMatch(dispatched, /\$ARGUMENTS/);
});
