import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { applySessionAffinityMigration } = await jiti.import("./session-affinity-migration.ts");
const { DISTRO, mergeDistroProviderCompat } = await jiti.import("./config.ts");

const DEFAULTS = { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" };

function sandbox(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "distro-session-affinity-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  return agentDir;
}

function writeModels(agentDir, providers) {
  const path = join(agentDir, "models.json");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ providers }, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function readModels(agentDir) {
  return JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
}

test("distro.json declares the session-affinity compat pair this migration fills", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(DISTRO.provider.compat ?? {}).filter(([key]) => key in DEFAULTS)),
    DEFAULTS,
  );
});

test("a missing models.json or an unconfigured service is a no-op success", (t) => {
  const empty = sandbox(t);
  assert.deepEqual(applySessionAffinityMigration(empty), { written: [], kept: [] });

  const agentDir = sandbox(test);
  writeModels(agentDir, { other: { baseUrl: "https://other.example.com", apiKey: "k" } });
  assert.deepEqual(applySessionAffinityMigration(agentDir), { written: [], kept: [] });
  assert.equal(readModels(agentDir).providers.other.apiKey, "k");
});

test("a provider without compat gets the pair; everything else is untouched and the write is private", (t) => {
  const agentDir = sandbox(t);
  writeModels(agentDir, {
    [DISTRO.provider.id]: {
      name: "LW",
      baseUrl: "https://gw.example.com",
      apiKey: "platform-key",
      api: "anthropic-messages",
      models: [{ id: "glm-5.3" }, { id: "grok-4.7", api: "openai-completions", compat: { thinkingFormat: "openai" } }],
    },
  });

  const report = applySessionAffinityMigration(agentDir);
  assert.deepEqual(report, { written: ["models.json"], kept: [] });

  const provider = readModels(agentDir).providers[DISTRO.provider.id];
  assert.deepEqual(provider.compat, DEFAULTS);
  assert.equal(provider.apiKey, "platform-key");
  assert.equal(provider.baseUrl, "https://gw.example.com");
  assert.equal(provider.models.length, 2);
  // Model-level compat is never touched (pi applies it over the provider's).
  assert.deepEqual(provider.models[1].compat, { thinkingFormat: "openai" });
  if (process.platform !== "win32") {
    assert.equal(statSync(join(agentDir, "models.json")).mode & 0o777, 0o600);
  }

  // Idempotent: nothing left to fill, so a retry writes nothing.
  assert.deepEqual(applySessionAffinityMigration(agentDir), { written: [], kept: [] });
});

test("an already-configured provider (the handover doc's outcome) writes nothing", (t) => {
  const agentDir = sandbox(t);
  writeModels(agentDir, {
    [DISTRO.provider.id]: {
      baseUrl: "https://gw.example.com",
      apiKey: "platform-key",
      compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
    },
  });
  assert.deepEqual(applySessionAffinityMigration(agentDir), { written: [], kept: [] });
});

test("explicit user values win, missing keys are still filled, and overrides are reported", (t) => {
  const agentDir = sandbox(t);
  writeModels(agentDir, {
    [DISTRO.provider.id]: {
      baseUrl: "https://gw.example.com",
      apiKey: "platform-key",
      compat: { sendSessionAffinityHeaders: false, thinkingFormat: "deepseek" },
    },
  });

  const report = applySessionAffinityMigration(agentDir);
  assert.equal(report.written.length, 1);
  assert.match(report.kept.join("; "), /sendSessionAffinityHeaders/);

  const compat = readModels(agentDir).providers[DISTRO.provider.id].compat;
  // The deliberate `false` is kept, the missing format is filled, unrelated keys survive.
  assert.equal(compat.sendSessionAffinityHeaders, false);
  assert.equal(compat.sessionAffinityFormat, "openrouter");
  assert.equal(compat.thinkingFormat, "deepseek");
});

test("an unreadable models.json throws so the release receipt stays unset", (t) => {
  const agentDir = sandbox(t);
  writeFileSync(join(agentDir, "models.json"), "{ not json", { mode: 0o600 });
  assert.throws(() => applySessionAffinityMigration(agentDir));
});

test("mergeDistroProviderCompat fills only absent keys and keeps object identity when nothing changes", () => {
  assert.deepEqual(mergeDistroProviderCompat(undefined), DEFAULTS);
  const explicit = { sendSessionAffinityHeaders: false, extra: 1 };
  const merged = mergeDistroProviderCompat(explicit);
  assert.equal(merged.sendSessionAffinityHeaders, false);
  assert.equal(merged.sessionAffinityFormat, "openrouter");
  assert.equal(merged.extra, 1);
  const complete = { ...DEFAULTS, extra: 2 };
  assert.equal(mergeDistroProviderCompat(complete), complete);
  assert.deepEqual(mergeDistroProviderCompat("junk"), DEFAULTS);
});
