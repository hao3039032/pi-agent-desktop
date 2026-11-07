import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { exaFallbackBaseUrl, resolveExaFallbackPair, applyExaFallbackMigration } = await jiti.import("./exa-fallback.ts");
const { DISTRO } = await jiti.import("./config.ts");

function sandbox(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "distro-exa-agent-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  return agentDir;
}

function writeConfig(agentDir, name, contents) {
  const path = join(agentDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
  return path;
}

function readConfig(agentDir, name) {
  return JSON.parse(readFileSync(join(agentDir, name), "utf8"));
}

const LW = { baseUrl: "https://gw.example.com/team/", apiKey: "platform-key" };
const lwModels = (overrides = {}) => ({
  providers: { [DISTRO.provider.id]: { baseUrl: LW.baseUrl, apiKey: LW.apiKey, ...overrides } },
});

// The endpoint is always derived from the user's service address: trailing
// slashes collapse, subpaths survive, an existing suffix is kept, and nothing
// is derived from an empty base.
test("exaFallbackBaseUrl derives the endpoint from any service address", () => {
  assert.equal(exaFallbackBaseUrl("https://gw.example.com"), "https://gw.example.com/exa");
  assert.equal(exaFallbackBaseUrl("https://gw.example.com/"), "https://gw.example.com/exa");
  assert.equal(exaFallbackBaseUrl("https://gw.example.com///"), "https://gw.example.com/exa");
  assert.equal(exaFallbackBaseUrl("https://gw.example.com/team/a///"), "https://gw.example.com/team/a/exa");
  assert.equal(exaFallbackBaseUrl("https://gw.example.com/exa"), "https://gw.example.com/exa");
  assert.equal(exaFallbackBaseUrl("https://gw.example.com/exa/"), "https://gw.example.com/exa");
  assert.equal(exaFallbackBaseUrl("  https://gw.example.com  "), "https://gw.example.com/exa");
  assert.equal(exaFallbackBaseUrl(""), "");
});

// The pair rule shared by the service form and the migration: fill when both
// sides are absent, move when both sides are provably ours, never mix.
test("resolveExaFallbackPair fills, re-syncs and refuses to mix", () => {
  const derived = "https://old.example.com/exa";
  const next = { exaBaseUrl: "https://new.example.com/exa", exaApiKey: "k-new" };

  // Both absent → both filled.
  assert.deepEqual(resolveExaFallbackPair({}, "https://old.example.com", "k-old", "https://new.example.com", "k-new"), next);
  // Both ours (equal to what the previous address/key would write) → moved.
  assert.deepEqual(
    resolveExaFallbackPair({ exaBaseUrl: derived, exaApiKey: "k-old" }, "https://old.example.com", "k-old", "https://new.example.com", "k-new"),
    next,
  );
  // Custom URL → the pair (including an equal key) stays untouched.
  assert.deepEqual(
    resolveExaFallbackPair({ exaBaseUrl: "https://my-exa.example.com", exaApiKey: "k-old" }, "https://old.example.com", "k-old", "https://new.example.com", "k-new"),
    {},
  );
  // Derived URL but user-replaced key → theirs.
  assert.deepEqual(resolveExaFallbackPair({ exaBaseUrl: derived, exaApiKey: "my-key" }, "https://old.example.com", "k-old", "https://new.example.com", "k-new"), {});
  // Half pairs stay half: no derived URL under a custom key, no key onto a custom host.
  assert.deepEqual(resolveExaFallbackPair({ exaBaseUrl: "https://my-exa.example.com" }, "https://old.example.com", "k-old", "https://new.example.com", "k-new"), {});
  assert.deepEqual(resolveExaFallbackPair({ exaApiKey: "my-key" }, "https://old.example.com", "k-old", "https://new.example.com", "k-new"), {});
  // Even a matching half-pair or malformed value is explicit configuration.
  for (const partial of [
    { exaBaseUrl: derived }, { exaApiKey: "k-old" },
    { exaBaseUrl: null, exaApiKey: null },
    { exaBaseUrl: false }, { exaApiKey: 123 },
  ]) {
    assert.deepEqual(resolveExaFallbackPair(partial, "https://old.example.com", "k-old", "https://new.example.com", "k-new"), {});
  }
  // A cleared ("") URL is a user choice, not an absent one.
  assert.deepEqual(resolveExaFallbackPair({ exaBaseUrl: "", exaApiKey: "k-old" }, "https://old.example.com", "k-old", "https://new.example.com", "k-new"), {});
  // No previous LW configuration to prove ownership against → an existing pair is kept.
  assert.deepEqual(resolveExaFallbackPair({ exaBaseUrl: derived, exaApiKey: "k-old" }, "", "", "https://new.example.com", "k-new"), {});
  // Nothing usable to write → no pair.
  assert.deepEqual(resolveExaFallbackPair({}, "https://old.example.com", "k-old", "https://new.example.com", ""), {});
});

// web-search.json is never created by the migration: an agent-dir file would
// shadow the legacy ~/.pi/web-search.json (same rule as toolActivation).
test("the migration never creates web-search.json, configured or not", (t) => {
  const agentDir = sandbox(t);
  writeConfig(agentDir, "models.json", lwModels());
  const report = applyExaFallbackMigration(agentDir);
  assert.equal(existsSync(join(agentDir, "web-search.json")), false);
  assert.deepEqual(report, { written: [], kept: [] });
});

test("the migration fills a missing pair from LW credentials and keeps every other key", (t) => {
  const agentDir = sandbox(t);
  writeConfig(agentDir, "models.json", lwModels());
  writeConfig(agentDir, "web-search.json", {
    provider: "gemini",
    searchModel: "gemini-3.8-flash",
    workflow: "none",
    geminiBaseUrl: "https://elsewhere.example.com",
    geminiApiKey: "gemini-key",
    youtube: { enabled: false, preferredModel: "gemini-3.5-flash-lite" },
    toolActivation: "eager",
  });

  const report = applyExaFallbackMigration(agentDir);

  assert.deepEqual(report, { written: ["web-search.json"], kept: [] });
  const written = readConfig(agentDir, "web-search.json");
  assert.equal(written.exaBaseUrl, "https://gw.example.com/team/exa");
  assert.equal(written.exaApiKey, LW.apiKey);
  // Nothing else moves: provider, workflow, media preferences, the Gemini
  // credentials (which may point elsewhere) and the lazy switch stay as-is.
  assert.equal(written.provider, "gemini");
  assert.equal(written.searchModel, "gemini-3.8-flash");
  assert.equal(written.workflow, "none");
  assert.equal(written.geminiBaseUrl, "https://elsewhere.example.com");
  assert.equal(written.geminiApiKey, "gemini-key");
  assert.equal(written.toolActivation, "eager");
  assert.deepEqual(written.youtube, { enabled: false, preferredModel: "gemini-3.5-flash-lite" });
});

// Running again (e.g. the receipt file was lost) changes nothing and reports
// no write — the migration is idempotent.
test("the migration is idempotent and a re-run writes nothing", (t) => {
  const agentDir = sandbox(t);
  writeConfig(agentDir, "models.json", lwModels());
  writeConfig(agentDir, "web-search.json", { provider: "gemini" });

  const first = applyExaFallbackMigration(agentDir);
  const afterFirst = readFileSync(join(agentDir, "web-search.json"), "utf8");
  const second = applyExaFallbackMigration(agentDir);

  assert.deepEqual(first, { written: ["web-search.json"], kept: [] });
  assert.deepEqual(second, { written: [], kept: [] });
  assert.equal(readFileSync(join(agentDir, "web-search.json"), "utf8"), afterFirst);
});

test("an existing complete custom pair is kept and reported, not overwritten", (t) => {
  const agentDir = sandbox(t);
  writeConfig(agentDir, "models.json", lwModels());
  writeConfig(agentDir, "web-search.json", {
    provider: "exa",
    exaBaseUrl: "https://my-exa.example.com",
    exaApiKey: "upstream-key",
  });
  const before = readFileSync(join(agentDir, "web-search.json"), "utf8");

  const report = applyExaFallbackMigration(agentDir);

  assert.deepEqual(report, { written: [], kept: ["web-search.json: custom Exa connection kept"] });
  assert.equal(before, readFileSync(join(agentDir, "web-search.json"), "utf8"));
});

// A half-custom pair is never completed: the missing side must not be filled
// with the derived value, in either direction.
test("a half-custom pair is kept half, never mixed", (t) => {
  for (const half of [{ exaBaseUrl: "https://my-exa.example.com" }, { exaApiKey: "upstream-key" }]) {
    const agentDir = sandbox(t);
    writeConfig(agentDir, "models.json", lwModels());
    writeConfig(agentDir, "web-search.json", half);
    const report = applyExaFallbackMigration(agentDir);
    const kept = readConfig(agentDir, "web-search.json");
    assert.deepEqual(report, { written: [], kept: ["web-search.json: custom Exa connection kept"] });
    assert.deepEqual(kept, half);
  }
});

// Without LW credentials there is nothing safe to derive: skip (success), and
// never touch the file.
test("no LW credentials in models.json means nothing to migrate", (t) => {
  for (const models of [{}, { providers: {} }, { providers: { lw: { baseUrl: LW.baseUrl } } }, { providers: { lw: { apiKey: LW.apiKey } } }]) {
    const agentDir = sandbox(t);
    writeConfig(agentDir, "models.json", models);
    const before = writeConfig(agentDir, "web-search.json", { provider: "gemini" });
    assert.deepEqual(applyExaFallbackMigration(agentDir), { written: [], kept: [] });
    assert.equal(readFileSync(before, "utf8"), readFileSync(join(agentDir, "web-search.json"), "utf8"));
  }
});

// A missing models.json is simply "unconfigured" (pi reads it that way too);
// an unreadable one must fail the migration so the release receipt stays unset
// and the next start retries.
test("an unreadable models.json fails the migration; a missing one does not", (t) => {
  const agentDir = sandbox(t);
  writeConfig(agentDir, "web-search.json", { provider: "gemini" });
  // Missing models.json: no-op success.
  assert.deepEqual(applyExaFallbackMigration(agentDir), { written: [], kept: [] });
  assert.equal(readConfig(agentDir, "web-search.json").exaBaseUrl, undefined);

  writeConfig(agentDir, "models.json", "{ not json");
  assert.throws(() => applyExaFallbackMigration(agentDir), /Failed to read/);
  assert.equal(readConfig(agentDir, "web-search.json").exaBaseUrl, undefined);
});

// Corrupt web-search.json is preserved byte for byte and fails the migration:
// no success mark, no secrets in the message.
test("an unparsable web-search.json is preserved and fails the migration", (t) => {
  const agentDir = sandbox(t);
  writeConfig(agentDir, "models.json", lwModels());
  const path = writeConfig(agentDir, "web-search.json", "{ not json");

  assert.throws(() => applyExaFallbackMigration(agentDir), /not valid JSON/);
  assert.equal(readFileSync(path, "utf8"), "{ not json");
});

// An empty (0-byte or whitespace) existing file holds no user choice: the pair
// lands in it without creating anything.
test("an empty existing web-search.json still gets the pair", (t) => {
  const agentDir = sandbox(t);
  writeConfig(agentDir, "models.json", lwModels());
  writeConfig(agentDir, "web-search.json", "");

  assert.deepEqual(applyExaFallbackMigration(agentDir), { written: ["web-search.json"], kept: [] });
  const written = readConfig(agentDir, "web-search.json");
  assert.equal(written.exaBaseUrl, "https://gw.example.com/team/exa");
  assert.equal(written.exaApiKey, LW.apiKey);
});
