import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { applyDistroServiceConfig } = await jiti.import("./service-config.ts");
const { DISTRO } = await jiti.import("./config.ts");
const { LAZY_TOOL_ACTIVATION } = await jiti.import("./lazy-tool-activation.ts");

/** The dialog's save payload; an explicit key keeps the run off the stored-key branch. */
const SERVICE = { baseUrl: "https://gw.example.com", apiKey: "k-123" };

function sandbox(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "distro-service-agent-"));
  const home = mkdtempSync(join(tmpdir(), "distro-service-home-"));
  t.after(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  return { agentDir, home };
}

/**
 * `applyDistroServiceConfig()` never takes the agent dir as an argument: it
 * reaches for it through the SDK's `getAgentDir()` (models.json, web-search.json,
 * settings.json) and through `readNpmMirrorEnabled()`. Point that at the sandbox
 * so nothing here can read or write the developer's real `~/.pi/agent`.
 */
function redirectSdkDirs(t, agentDir, home) {
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

/** A sandbox agent dir with the chat provider the save rewrites already in place. */
function sandboxAgentDir(t) {
  const { agentDir, home } = sandbox(t);
  redirectSdkDirs(t, agentDir, home);
  writeConfig(agentDir, "models.json", {
    providers: { [DISTRO.provider.id]: { baseUrl: "https://old.example.com", apiKey: "stored-key" } },
  });
  return agentDir;
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

function webSearchFile(agentDir) {
  return join(agentDir, "web-search.json");
}

// A first save on a fresh agent dir is where pi-web-access gets its config file
// at all (the seed deliberately leaves web-search.json to this form), so the
// file, the distro's distro.json defaults and the lazy switch must all land in
// the same write. Without `toolActivation` here a new install declares the whole
// web_search tool set on every request.
test("a first save creates web-search.json with the lazy switch and the distro defaults", async (t) => {
  const agentDir = sandboxAgentDir(t);
  assert.equal(existsSync(webSearchFile(agentDir)), false);

  await applyDistroServiceConfig(SERVICE);

  assert.equal(existsSync(webSearchFile(agentDir)), true);
  const written = readConfig(agentDir, "web-search.json");
  assert.equal(LAZY_TOOL_ACTIVATION, "dynamic");
  assert.equal(written.toolActivation, "dynamic");
  for (const [key, value] of Object.entries(DISTRO.webSearch.defaults)) {
    assert.deepEqual(written[key], value, `distro default ${key} was not written`);
  }
  assert.equal(written[DISTRO.webSearch.baseUrlKey], SERVICE.baseUrl);
  assert.equal(written[DISTRO.webSearch.apiKeyKey], SERVICE.apiKey);
  assert.equal(DISTRO.webSearch.baseUrlKey, "geminiBaseUrl");
  assert.equal(DISTRO.webSearch.apiKeyKey, "geminiApiKey");
  // The chat provider went through the same save; a stale temp file would show here.
  assert.equal(readConfig(agentDir, "models.json").providers[DISTRO.provider.id].baseUrl, SERVICE.baseUrl);
});

// The lazy switch is a one-shot seed, not a default that comes back: `eager` is a
// deliberate choice, and a deleted key means the user fell back to the
// extension's own `auto`. Both must survive a later service-config save.
test("an existing web-search.json keeps its toolActivation choice, and a deleted one stays deleted", async (t) => {
  const agentDir = sandboxAgentDir(t);
  writeConfig(agentDir, "web-search.json", { provider: "gemini", toolActivation: "eager" });

  await applyDistroServiceConfig(SERVICE);

  const kept = readConfig(agentDir, "web-search.json");
  assert.equal(kept.toolActivation, "eager");
  assert.equal(kept[DISTRO.webSearch.baseUrlKey], SERVICE.baseUrl);
  assert.equal(kept[DISTRO.webSearch.apiKeyKey], SERVICE.apiKey);

  // The user deletes the key to fall back to the extension's own `auto`.
  delete kept.toolActivation;
  writeConfig(agentDir, "web-search.json", kept);

  await applyDistroServiceConfig(SERVICE);

  const after = readConfig(agentDir, "web-search.json");
  assert.equal(after.toolActivation, undefined);
  assert.equal(Object.hasOwn(after, "toolActivation"), false);
  assert.equal(after.provider, "gemini");
});

// An existing but empty file is *not* a user choice: a 0-byte web-search.json
// (an interrupted write, or a file the user created by hand) must still get the
// lazy switch, or the save would leave a config that can never gain the key.
test("an empty existing web-search.json is treated as a first creation", async (t) => {
  const agentDir = sandboxAgentDir(t);
  writeFileSync(webSearchFile(agentDir), "");
  assert.equal(existsSync(webSearchFile(agentDir)), true);

  await applyDistroServiceConfig(SERVICE);

  const written = readConfig(agentDir, "web-search.json");
  assert.equal(written.toolActivation, "dynamic");
  assert.equal(written[DISTRO.webSearch.baseUrlKey], SERVICE.baseUrl);
  assert.equal(written[DISTRO.webSearch.apiKeyKey], SERVICE.apiKey);
});

// `{...DISTRO.webSearch.defaults, ...webSearch}`: the file wins over the defaults
// for every key the user owns, and the defaults only fill in keys it lacks. The
// service keys come last, so a stale address in the file is always replaced.
test("keys in the user's file win over the distro defaults, which only fill in missing ones", async (t) => {
  const agentDir = sandboxAgentDir(t);
  writeConfig(agentDir, "web-search.json", {
    provider: "my-provider",
    searchModel: "my-search-model",
    workflow: "my-workflow",
    [DISTRO.webSearch.baseUrlKey]: "https://stale.example.com",
    [DISTRO.webSearch.apiKeyKey]: "stale-key",
  });

  await applyDistroServiceConfig(SERVICE);

  const written = readConfig(agentDir, "web-search.json");
  assert.equal(written.provider, "my-provider");
  assert.equal(written.searchModel, "my-search-model");
  assert.equal(written.workflow, "my-workflow");
  assert.equal(DISTRO.webSearch.defaults.provider, "gemini");
  assert.notEqual(written.provider, DISTRO.webSearch.defaults.provider);
  // Defaults the user did not set are still filled in.
  for (const key of ["allowBrowserCookies", "autoOpenBrowser", "youtube", "video"]) {
    assert.deepEqual(written[key], DISTRO.webSearch.defaults[key], `missing default ${key} was not filled in`);
  }
  // The saved service address and key always win over whatever the file held.
  assert.equal(written[DISTRO.webSearch.baseUrlKey], SERVICE.baseUrl);
  assert.equal(written[DISTRO.webSearch.apiKeyKey], SERVICE.apiKey);
});
