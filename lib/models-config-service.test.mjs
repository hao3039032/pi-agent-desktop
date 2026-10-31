/**
 * The models-config service seam's tests: saveModelsConfig (the ONE
 * composition behind PUT /api/models-config — the literal-key merge, the
 * read refusal, the passthrough of unknown fields) and the client half's
 * HTTP contract. The store layers underneath (pi's read leniency, cost
 * normalization, the blank-row sanitize, the private atomic write) are
 * pinned by lib/models-config-store.test.mjs; what is pinned HERE is that
 * the seam composes exactly what the route's inline body used to.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { saveModelsConfig, ModelsConfigReadError } = await jiti.import("./models-config-service.server.ts");
const { fetchModelsConfig, saveModelsConfig: saveOverHttp } = await jiti.import("./models-config-service.ts");

function createAgentDir(t, modelsJson) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-models-config-seam-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    // The store resolves models.json through the SDK's getAgentDir(), which
    // honours PI_CODING_AGENT_DIR at CALL time — restore the caller's env.
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  if (modelsJson !== undefined) {
    writeFileSync(join(root, "models.json"), typeof modelsJson === "string" ? modelsJson : JSON.stringify(modelsJson, null, 2));
  }
  return root;
}

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

test("an omitted apiKey keeps the stored literal while the user edits unrelated settings", (t) => {
  const root = createAgentDir(t, {
    providers: {
      acme: { apiKey: "literal-secret", baseUrl: "https://old.example.test/v1", models: [{ id: "m" }] },
      shell: { apiKey: "!get-key", models: [] },
    },
  });
  process.env.PI_CODING_AGENT_DIR = root;

  // The redacted load the panel actually holds (no literal key anywhere).
  saveModelsConfig({
    providers: {
      acme: { baseUrl: "https://new.example.test/v1", models: [{ id: "m" }] },
      shell: { apiKey: "!get-key", models: [] },
    },
  });

  const saved = JSON.parse(readFileSync(join(root, "models.json"), "utf8"));
  assert.equal(saved.providers.acme.apiKey, "literal-secret", "the unseen literal is merged back");
  assert.equal(saved.providers.acme.baseUrl, "https://new.example.test/v1", "the edit itself landed");
  assert.equal(saved.providers.shell.apiKey, "!get-key", "a ! reference is configuration, untouched");
});

test("an explicit apiKey wins — including the empty string that clears it", (t) => {
  const root = createAgentDir(t, {
    providers: {
      acme: { apiKey: "literal-secret", models: [] },
      other: { apiKey: "other-secret", models: [] },
    },
  });
  process.env.PI_CODING_AGENT_DIR = root;

  saveModelsConfig({
    providers: {
      acme: { apiKey: "", models: [] },
      other: { apiKey: "replaced-literal", models: [] },
    },
  });

  const saved = JSON.parse(readFileSync(join(root, "models.json"), "utf8"));
  assert.equal(saved.providers.acme.apiKey, "", "an explicit empty string clears the stored literal");
  assert.equal(saved.providers.other.apiKey, "replaced-literal", "an explicit literal replaces the stored one");
});

test("a renamed provider is a new key to the merge — the stored literal does not follow the rename", (t) => {
  // The panel's rename moves the (redacted) provider object to a new key;
  // the merge only restores literals for keys that still exist, so the
  // renamed provider saves without one. That is the route's behaviour, kept
  // verbatim by the seam — pinned here so a "helpful" fix cannot land
  // silently.
  const root = createAgentDir(t, {
    providers: {
      "old-name": { apiKey: "literal-secret", models: [{ id: "m" }] },
    },
  });
  process.env.PI_CODING_AGENT_DIR = root;

  saveModelsConfig({ providers: { "new-name": { models: [{ id: "m" }] } } });

  const saved = JSON.parse(readFileSync(join(root, "models.json"), "utf8"));
  assert.equal(saved.providers["new-name"].apiKey, undefined, "the literal stayed with the old key");
  assert.equal("old-name" in saved.providers, false, "the old key is gone (the draft owns the shape)");
});

test("unknown top-level fields pass through and the composition normalizes costs", (t) => {
  const root = createAgentDir(t, { providers: {} });
  process.env.PI_CODING_AGENT_DIR = root;

  saveModelsConfig({
    "x-future-field": { nested: [1, 2, 3] },
    providers: {
      acme: { models: [{ id: "m", cost: { input: 1 } }, { id: "" }] },
    },
  });

  const saved = JSON.parse(readFileSync(join(root, "models.json"), "utf8"));
  assert.deepEqual(saved["x-future-field"], { nested: [1, 2, 3] }, "an unknown field is the file's own schema, kept");
  assert.deepEqual(saved.providers.acme.models, [
    { id: "m", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ], "partial costs completed and the blank row dropped (the store's own rules)");
});

test("a models.json the composition cannot read refuses the save and is never replaced", (t) => {
  const broken = '{ "providers": { "acme": { "models": [ } } }';
  const root = createAgentDir(t, broken);
  process.env.PI_CODING_AGENT_DIR = root;

  assert.throws(() => saveModelsConfig({ providers: { fresh: { models: [] } } }), ModelsConfigReadError);
  assert.equal(readFileSync(join(root, "models.json"), "utf8"), broken, "the unusable file is untouched");
});

// --- the HTTP client half (the route's client contract) ----------------------

function stubFetch(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    const answer = responses.shift() ?? { ok: true, status: 200, body: { success: true } };
    return Promise.resolve({
      ok: answer.ok,
      status: answer.status,
      json: async () => answer.body,
    });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("the save PUTs the whole draft to the route", async () => {
  const fetchStub = stubFetch([{ ok: true, status: 200, body: { success: true } }]);
  try {
    const draft = { providers: { acme: { models: [{ id: "m" }] } }, "x-custom": 1 };
    await saveOverHttp(draft);
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0].url, "/api/models-config");
    assert.equal(fetchStub.calls[0].init.method, "PUT");
    assert.deepEqual(JSON.parse(fetchStub.calls[0].init.body), draft);
  } finally {
    fetchStub.restore();
  }
});

test("the read and the save surface the route's error text or the HTTP status", async () => {
  const fetchStub = stubFetch([
    { ok: false, status: 409, body: { error: "Failed to read models.json: expected a JSON object" } },
    { ok: false, status: 500, body: {} },
    { ok: true, status: 200, body: { providers: {}, error: "halfway body" } },
  ]);
  try {
    const refused = await saveOverHttp({ providers: {} }).then(() => null, (error) => error);
    assert.ok(refused instanceof Error);
    assert.equal(refused.message, "Failed to read models.json: expected a JSON object");
    const serverError = await saveOverHttp({ providers: {} }).then(() => null, (error) => error);
    assert.equal(serverError.message, "HTTP 500");
    const readError = await fetchModelsConfig().then(() => null, (error) => error);
    assert.equal(readError.message, "halfway body");
  } finally {
    fetchStub.restore();
  }
});
