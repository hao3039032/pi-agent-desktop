import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { applyOpenAICompletionsMigration } = await jiti.import("./openai-completions-migration.ts");
const { DISTRO } = await jiti.import("./config.ts");

function sandbox(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "distro-openai-default-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  return agentDir;
}

function writeModels(agentDir, value) {
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function readModels(agentDir) {
  return JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
}

test("an old LW provider gains the OpenAI default, /v1 and managed model overrides", (t) => {
  const agentDir = sandbox(t);
  const custom = { id: "my-model", api: "anthropic-messages", baseUrl: "https://elsewhere.invalid" };
  writeModels(agentDir, {
    providers: {
      other: { api: "openai-responses", baseUrl: "https://other.invalid/v1", models: [] },
      [DISTRO.provider.id]: {
        apiKey: "stored-key",
        api: "anthropic-messages",
        baseUrl: "https://custom.example/team",
        compat: { sendSessionAffinityHeaders: false },
        models: [
          { id: "glm-5.3", thinkingLevelMap: { high: "high" } },
          { id: "claude-opus-5-5" },
          { id: "gpt-6-astra" },
          custom,
        ],
      },
    },
  });

  const report = applyOpenAICompletionsMigration(agentDir);
  assert.deepEqual(report, { written: ["models.json"] });
  const config = readModels(agentDir);
  const provider = config.providers[DISTRO.provider.id];
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.baseUrl, "https://custom.example/team/v1");
  assert.equal(provider.apiKey, "stored-key");
  assert.deepEqual(provider.compat, { sendSessionAffinityHeaders: false });
  assert.deepEqual(config.providers.other, { api: "openai-responses", baseUrl: "https://other.invalid/v1", models: [] });

  const byId = new Map(provider.models.map((model) => [model.id, model]));
  assert.equal(byId.get("glm-5.3").api, undefined);
  assert.equal(byId.get("glm-5.3").compat.thinkingFormat, "zai");
  assert.equal(byId.get("glm-5.3").thinkingLevelMap.medium, null);
  assert.equal(byId.get("glm-5.3-flash").compat.zaiToolStream, true);
  assert.equal(byId.get("claude-opus-5-5").api, "anthropic-messages");
  assert.equal(byId.get("claude-opus-5-5").baseUrl, "https://custom.example/team");
  for (const id of ["gpt-6-astra", "gpt-6.1-terra"]) {
    assert.equal(byId.get(id).api, "openai-responses");
    assert.equal(byId.get(id).baseUrl, "https://custom.example/team/v1");
  }
  assert.equal(byId.get("gemini-3.5-flash-lite").baseUrl, "https://custom.example/team/v1beta");
  assert.equal(byId.get("gemini-4-argon").api, "google-generative-ai");
  assert.equal(byId.get("gemini-4-argon").baseUrl, "https://custom.example/team/v1beta");
  assert.equal(byId.get("gemini-4-argon").maxTokens, 32768);
  assert.deepEqual(byId.get("my-model"), custom);
});

test("migration is idempotent and an existing /v1 provider base is never doubled", (t) => {
  const agentDir = sandbox(t);
  writeModels(agentDir, {
    providers: {
      [DISTRO.provider.id]: {
        apiKey: "k",
        api: "anthropic-messages",
        baseUrl: "https://custom.example/v1",
        models: [],
      },
    },
  });
  applyOpenAICompletionsMigration(agentDir);
  const path = join(agentDir, "models.json");
  const once = readFileSync(path, "utf8");
  const provider = readModels(agentDir).providers[DISTRO.provider.id];
  assert.equal(provider.baseUrl, "https://custom.example/v1");
  assert.equal(provider.models.find((model) => model.id === "claude-opus-5-5").baseUrl, "https://custom.example");
  assert.equal(provider.models.find((model) => model.id === "gpt-6-astra").baseUrl, "https://custom.example/v1");

  assert.deepEqual(applyOpenAICompletionsMigration(agentDir), { written: [] });
  assert.equal(readFileSync(path, "utf8"), once);
});

test("an unconfigured service is a no-op and malformed JSON fails without replacement", (t) => {
  const agentDir = sandbox(t);
  assert.deepEqual(applyOpenAICompletionsMigration(agentDir), { written: [] });
  writeModels(agentDir, { providers: { other: { models: [] } } });
  assert.deepEqual(applyOpenAICompletionsMigration(agentDir), { written: [] });
  assert.deepEqual(readModels(agentDir), { providers: { other: { models: [] } } });

  writeFileSync(join(agentDir, "models.json"), "{broken");
  assert.throws(() => applyOpenAICompletionsMigration(agentDir));
  assert.equal(readFileSync(join(agentDir, "models.json"), "utf8"), "{broken");
});
