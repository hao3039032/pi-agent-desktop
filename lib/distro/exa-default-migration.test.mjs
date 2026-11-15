import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { applyExaDefaultMigration } = await jiti.import("./exa-default-migration.ts");
const { DISTRO } = await jiti.import("./config.ts");

function sandbox(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "distro-exa-default-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  return agentDir;
}

function write(agentDir, name, value) {
  const path = join(agentDir, name);
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function read(agentDir, name) {
  return JSON.parse(readFileSync(join(agentDir, name), "utf8"));
}

function oldDefault(overrides = {}) {
  return {
    provider: "gemini",
    searchModel: DISTRO.webSearch.defaults.searchModel,
    workflow: "none",
    ...overrides,
  };
}

test("the old distro default switches to Exa without discarding Gemini or workflow settings", (t) => {
  const agentDir = sandbox(t);
  write(agentDir, "web-search.json", oldDefault({
    exaBaseUrl: "https://gw.example/exa",
    exaApiKey: "platform-key",
    geminiBaseUrl: "https://gw.example",
    geminiApiKey: "platform-key",
    summaryModel: "lw/deepseek-v4.1-flash",
  }));

  assert.deepEqual(applyExaDefaultMigration(agentDir), { written: ["web-search.json"], kept: [] });
  const written = read(agentDir, "web-search.json");
  assert.equal(written.provider, "exa");
  assert.equal(written.searchModel, DISTRO.webSearch.defaults.searchModel);
  assert.equal(written.exaBaseUrl, "https://gw.example/exa");
  assert.equal(written.exaApiKey, "platform-key");
  assert.equal(written.geminiBaseUrl, "https://gw.example");
  assert.equal(written.geminiApiKey, "platform-key");
  assert.equal(written.summaryModel, "lw/deepseek-v4.1-flash");
  assert.equal(written.workflow, "none");

  const once = readFileSync(join(agentDir, "web-search.json"), "utf8");
  assert.deepEqual(applyExaDefaultMigration(agentDir), { written: [], kept: [] });
  assert.equal(readFileSync(join(agentDir, "web-search.json"), "utf8"), once);
});

test("a missing Exa pair is derived from the LW service root, including an explicit searchProvider", (t) => {
  const agentDir = sandbox(t);
  write(agentDir, "models.json", {
    providers: { [DISTRO.provider.id]: { baseUrl: "https://custom.example/team/v1", apiKey: "stored-key" } },
  });
  write(agentDir, "web-search.json", oldDefault({ searchProvider: "gemini" }));

  assert.deepEqual(applyExaDefaultMigration(agentDir), { written: ["web-search.json"], kept: [] });
  const written = read(agentDir, "web-search.json");
  assert.equal(written.provider, "exa");
  assert.equal(written.searchProvider, "exa");
  assert.equal(written.exaBaseUrl, "https://custom.example/team/exa");
  assert.equal(written.exaApiKey, "stored-key");
});

test("a complete custom Exa pair is reused without mixing in platform credentials", (t) => {
  const agentDir = sandbox(t);
  write(agentDir, "web-search.json", oldDefault({
    exaBaseUrl: "https://my-exa.example",
    exaApiKey: "my-upstream-key",
  }));
  applyExaDefaultMigration(agentDir);
  const written = read(agentDir, "web-search.json");
  assert.equal(written.provider, "exa");
  assert.equal(written.exaBaseUrl, "https://my-exa.example");
  assert.equal(written.exaApiKey, "my-upstream-key");
});

test("custom providers, models and routing are preserved", (t) => {
  for (const config of [
    oldDefault({ provider: "brave" }),
    oldDefault({ searchModel: "custom-search" }),
    oldDefault({ searchProvider: "auto" }),
  ]) {
    const agentDir = sandbox(t);
    const path = write(agentDir, "web-search.json", config);
    const before = readFileSync(path, "utf8");
    assert.deepEqual(applyExaDefaultMigration(agentDir), {
      written: [], kept: ["web-search.json: custom search provider kept"],
    });
    assert.equal(readFileSync(path, "utf8"), before);
  }
});

test("an incomplete Exa connection keeps the old default instead of breaking search", (t) => {
  for (const config of [
    oldDefault({ exaBaseUrl: "https://my-exa.example" }),
    oldDefault({ exaApiKey: "upstream-key" }),
    oldDefault(),
  ]) {
    const agentDir = sandbox(t);
    const path = write(agentDir, "web-search.json", config);
    const before = readFileSync(path, "utf8");
    assert.deepEqual(applyExaDefaultMigration(agentDir), {
      written: [], kept: ["web-search.json: incomplete Exa connection; Gemini default kept"],
    });
    assert.equal(readFileSync(path, "utf8"), before);
  }
});

test("missing files are a no-op; unreadable inputs fail without replacement", (t) => {
  const agentDir = sandbox(t);
  assert.deepEqual(applyExaDefaultMigration(agentDir), { written: [], kept: [] });
  assert.equal(existsSync(join(agentDir, "web-search.json")), false);

  write(agentDir, "web-search.json", "{broken");
  assert.throws(() => applyExaDefaultMigration(agentDir));
  assert.equal(readFileSync(join(agentDir, "web-search.json"), "utf8"), "{broken");

  write(agentDir, "web-search.json", oldDefault());
  write(agentDir, "models.json", "{broken");
  assert.throws(() => applyExaDefaultMigration(agentDir));
  assert.equal(read(agentDir, "web-search.json").provider, "gemini");
});
