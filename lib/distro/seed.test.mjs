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
