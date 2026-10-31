/**
 * Tests for the models-extras IPC service (the static build's alias target for
 * lib/models-extras-service.ts): verifies that all operations travel through
 * typed IPC over pi_ipc to the management instance, with proper argument mapping
 * and error translation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const jiti = createJiti(import.meta.url, {
  alias: { "@": repoRoot },
  interopDefault: true,
});

const {
  bindModelsExtrasService,
  fetchModelCatalogPresets,
  discoverProviderModels,
  testModelConfiguration,
  fetchNonChatModels,
  refreshModelCatalog,
  fetchProviderUsage,
} = await jiti.import("./models-extras-service.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

function bound(handler) {
  const mock = new MockTransport();
  if (handler) for (const [op, impl] of Object.entries(handler)) mock.on(op, impl);
  const client = new IpcClient(mock);
  bindModelsExtrasService(client);
  return mock;
}

test("fetchModelCatalogPresets calls modelsConfig.catalog over IPC", async () => {
  const calls = [];
  bound({
    "modelsConfig.catalog": (args) => {
      calls.push(args);
      return { models: [{ id: "m1", name: "Model 1", provider: "p1" }], source: "https://models.dev" };
    },
  });

  const res = await fetchModelCatalogPresets({ q: "llama", provider: "groq", limit: 20 });
  assert.deepEqual(calls, [{ q: "llama", provider: "groq", limit: 20 }]);
  assert.equal(res.models.length, 1);
  assert.equal(res.models[0].id, "m1");
});

test("discoverProviderModels calls modelsConfig.discover over IPC", async () => {
  const calls = [];
  bound({
    "modelsConfig.discover": (args) => {
      calls.push(args);
      return { models: [{ id: "disc-1" }], endpoint: "http://example.test/v1/models" };
    },
  });

  const res = await discoverProviderModels({
    providerName: "test-prov",
    provider: { baseUrl: "http://example.test/v1" },
  });
  assert.deepEqual(calls, [{
    providerName: "test-prov",
    provider: { baseUrl: "http://example.test/v1" },
  }]);
  assert.equal(res.models.length, 1);
  assert.equal(res.endpoint, "http://example.test/v1/models");
});

test("testModelConfiguration calls modelsConfig.test over IPC and returns shaped result", async () => {
  const calls = [];
  bound({
    "modelsConfig.test": (args) => {
      calls.push(args);
      return { ok: true, latencyMs: 120, status: 200, responseText: "OK" };
    },
  });

  const res = await testModelConfiguration({
    providerName: "prov",
    provider: { baseUrl: "http://test.local" },
    model: { id: "m-test" },
  });
  assert.deepEqual(calls, [{
    providerName: "prov",
    provider: { baseUrl: "http://test.local" },
    model: { id: "m-test" },
  }]);
  assert.equal(res.ok, true);
  assert.equal(res.responseText, "OK");
});

test("testModelConfiguration returns { ok: false, error } when IPC fails", async () => {
  bound({
    "modelsConfig.test": () => {
      throw new Error("Connection failed");
    },
  });

  const res = await testModelConfiguration({
    providerName: "prov",
    provider: { baseUrl: "http://test.local" },
    model: { id: "m-test" },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /Connection failed/);
});

test("fetchNonChatModels calls models.nonchat over IPC", async () => {
  bound({
    "models.nonchat": () => ({
      classifier: [{ id: "jev", provider: "openai", name: "Jev", available: true }],
      image: [],
      codemode: "always",
    }),
  });

  const res = await fetchNonChatModels();
  assert.equal(res.classifier.length, 1);
  assert.equal(res.classifier[0].id, "jev");
  assert.equal(res.codemode, "always");
});

test("refreshModelCatalog calls models.refreshCatalog over IPC", async () => {
  const calls = [];
  bound({
    "models.refreshCatalog": (args) => {
      calls.push(args);
      return { completed: true, changed: false };
    },
  });

  const res = await refreshModelCatalog("openrouter");
  assert.deepEqual(calls, [{ provider: "openrouter" }]);
  assert.equal(res.completed, true);
});

test("fetchProviderUsage calls models.providerUsage over IPC", async () => {
  const calls = [];
  bound({
    "models.providerUsage": (args) => {
      calls.push(args);
      return { providerId: "deepseek", status: "ready", report: { capturedAt: 1234, buckets: [], metrics: [] } };
    },
  });

  const res = await fetchProviderUsage("deepseek");
  assert.deepEqual(calls, [{ providerId: "deepseek" }]);
  assert.equal(res.status, "ready");
});
