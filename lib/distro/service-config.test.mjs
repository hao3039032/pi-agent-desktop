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

// The optional Exa fallback connection rides along on the same save: the
// gateway proxies Exa's native endpoints at the service address + /exa and
// takes the platform key, so a fresh install gets a usable fallback without
// extra setup. It is a connection, not a switch — provider stays "gemini" and
// workflow stays "none".
test("a first save pre-fills the Exa fallback pair without touching provider or workflow", async (t) => {
  const agentDir = sandboxAgentDir(t);
  await applyDistroServiceConfig(SERVICE);
  const written = readConfig(agentDir, "web-search.json");
  assert.equal(DISTRO.webSearch.exaFallback.baseUrlKey, "exaBaseUrl");
  assert.equal(DISTRO.webSearch.exaFallback.apiKeyKey, "exaApiKey");
  assert.equal(written.exaBaseUrl, `${SERVICE.baseUrl}/exa`);
  assert.equal(written.exaApiKey, SERVICE.apiKey);
  assert.equal(written.provider, "gemini");
  assert.equal(written.workflow, "none");
});

// The Exa endpoint is derived from whatever address the user saved — subpaths
// and trailing slashes survive, an address that already ends in the suffix is
// not doubled — never a hard-coded host. An omitted key keeps the stored one
// for the Gemini pair and the Exa pair alike.
test("the Exa endpoint follows the saved address through subpaths, slashes and an existing suffix", async (t) => {
  const agentDir = sandboxAgentDir(t);
  await applyDistroServiceConfig({ baseUrl: "https://gw.example.com/team/a/", apiKey: "k-1" });
  assert.equal(readConfig(agentDir, "web-search.json").exaBaseUrl, "https://gw.example.com/team/a/exa");

  // URL-only change: the key is kept from models.json for both pairs.
  await applyDistroServiceConfig({ baseUrl: "https://gw.example.com/team/a", apiKey: "" });
  const kept = readConfig(agentDir, "web-search.json");
  assert.equal(kept.exaBaseUrl, "https://gw.example.com/team/a/exa");
  assert.equal(kept.exaApiKey, "k-1");

  await applyDistroServiceConfig({ baseUrl: "https://gw.example.com/exa", apiKey: "k-2" });
  const resuffixed = readConfig(agentDir, "web-search.json");
  assert.equal(resuffixed.exaBaseUrl, "https://gw.example.com/exa");
  assert.equal(resuffixed.exaApiKey, "k-2");
});

// The distro-owned pair follows a service address/key change. Ownership is
// proven against what the previous address would have derived plus the
// previously stored platform key — the field names alone prove nothing.
test("a service URL/key change re-syncs the distro-owned Exa pair", async (t) => {
  const agentDir = sandboxAgentDir(t);
  await applyDistroServiceConfig({ baseUrl: "https://old.example.com", apiKey: "k-old" });
  await applyDistroServiceConfig({ baseUrl: "https://new.example.com", apiKey: "k-new" });
  const written = readConfig(agentDir, "web-search.json");
  assert.equal(written.exaBaseUrl, "https://new.example.com/exa");
  assert.equal(written.exaApiKey, "k-new");
  assert.equal(written[DISTRO.webSearch.baseUrlKey], "https://new.example.com");
  assert.equal(written[DISTRO.webSearch.apiKeyKey], "k-new");
});

// A custom pair is kept whole: overwriting only the URL would send the user's
// upstream Exa key to the gateway, overwriting only the key would send the
// platform key to a custom Exa host. Neither may happen; the Gemini
// credentials still follow the save, and a provider the user chose stays.
test("a complete custom Exa pair survives a service save untouched", async (t) => {
  const agentDir = sandboxAgentDir(t);
  writeConfig(agentDir, "web-search.json", {
    provider: "exa",
    workflow: "auto-summary",
    exaBaseUrl: "https://my-exa.example.com",
    exaApiKey: "upstream-key",
  });
  await applyDistroServiceConfig(SERVICE);
  const kept = readConfig(agentDir, "web-search.json");
  assert.equal(kept.exaBaseUrl, "https://my-exa.example.com");
  assert.equal(kept.exaApiKey, "upstream-key");
  assert.equal(kept.provider, "exa");
  assert.equal(kept.workflow, "auto-summary");
  assert.equal(kept[DISTRO.webSearch.baseUrlKey], SERVICE.baseUrl);
  assert.equal(kept[DISTRO.webSearch.apiKeyKey], SERVICE.apiKey);
});

// Half-custom pairs are never completed with the other side's derived value:
// mixing would pair one host's credential with another host's endpoint.
test("a half-custom Exa pair is left alone rather than completed with derived values", async (t) => {
  // Custom URL, no key: filling the platform key would leak it to that host.
  let agentDir = sandboxAgentDir(t);
  writeConfig(agentDir, "web-search.json", { exaBaseUrl: "https://my-exa.example.com" });
  await applyDistroServiceConfig(SERVICE);
  let written = readConfig(agentDir, "web-search.json");
  assert.equal(written.exaBaseUrl, "https://my-exa.example.com");
  assert.equal(Object.hasOwn(written, "exaApiKey"), false);

  // Custom key, no URL: filling the gateway URL would send that key to it.
  agentDir = sandboxAgentDir(t);
  writeConfig(agentDir, "web-search.json", { exaApiKey: "upstream-key" });
  await applyDistroServiceConfig(SERVICE);
  written = readConfig(agentDir, "web-search.json");
  assert.equal(written.exaApiKey, "upstream-key");
  assert.equal(Object.hasOwn(written, "exaBaseUrl"), false);
});

// A pair whose URL matches the derivation but whose key was replaced by the
// user is still theirs: ownership needs both sides to check out.
test("a derived URL with a user-replaced key is preserved, not re-keyed", async (t) => {
  const agentDir = sandboxAgentDir(t);
  await applyDistroServiceConfig(SERVICE);
  const file = readConfig(agentDir, "web-search.json");
  file.exaApiKey = "my-own-exa-key";
  writeConfig(agentDir, "web-search.json", file);

  await applyDistroServiceConfig({ baseUrl: "https://new.example.com", apiKey: "k-new" });

  const kept = readConfig(agentDir, "web-search.json");
  assert.equal(kept.exaBaseUrl, `${SERVICE.baseUrl}/exa`);
  assert.equal(kept.exaApiKey, "my-own-exa-key");
});

// Unparsable JSON is never rewritten and its (unknown) contents never appear
// in output — the same contract the Gemini keys already follow.
test("an unparsable web-search.json is left untouched, Exa included", async (t) => {
  t.mock.method(console, "warn", () => {});
  const agentDir = sandboxAgentDir(t);
  const path = webSearchFile(agentDir);
  writeFileSync(path, "{ not json");
  await applyDistroServiceConfig(SERVICE);
  assert.equal(readFileSync(path, "utf8"), "{ not json");
});
