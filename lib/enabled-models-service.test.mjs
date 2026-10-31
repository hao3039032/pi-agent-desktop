import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  parseEnabledModelsMutation,
  fetchEnabledModelsView,
  applyEnabledModelsEdit,
  EnabledModelsRefusalError,
} = await jiti.import("./enabled-models-service.ts");

// --- parseEnabledModelsMutation: the write path's shared validation ---------

test("parse accepts every op shape and rejects the route's field errors", () => {
  assert.deepEqual(parseEnabledModelsMutation({ op: "clear" }), { ok: true, mutation: { op: "clear" } });
  assert.deepEqual(parseEnabledModelsMutation({ op: "prune" }), { ok: true, mutation: { op: "prune" } });
  assert.deepEqual(
    parseEnabledModelsMutation({ op: "models", refs: ["p/m", "p/m2"], enabled: false }),
    { ok: true, mutation: { op: "models", refs: ["p/m", "p/m2"], enabled: false } },
  );
  assert.deepEqual(
    parseEnabledModelsMutation({ op: "provider", provider: "p", enabled: true }),
    { ok: true, mutation: { op: "provider", provider: "p", enabled: true } },
  );
  assert.deepEqual(
    parseEnabledModelsMutation({
      op: "resync",
      renames: [{ from: "a", to: "b" }],
      modelRenames: [],
      fullyEnabled: ["a"],
    }),
    {
      ok: true,
      mutation: {
        op: "resync",
        renames: [{ from: "a", to: "b" }],
        modelRenames: [],
        fullyEnabled: ["a"],
      },
    },
  );
  // modelRenames/fullyEnabled default to empty, like the route.
  assert.deepEqual(
    parseEnabledModelsMutation({ op: "resync", renames: [] }),
    { ok: true, mutation: { op: "resync", renames: [], modelRenames: [], fullyEnabled: [] } },
  );

  // The route's exact field-error texts.
  assert.deepEqual(parseEnabledModelsMutation({ op: "nonsense" }), { ok: false, error: "Invalid op" });
  assert.deepEqual(parseEnabledModelsMutation({ op: "models", refs: [] }), { ok: false, error: "enabled must be a boolean" });
  assert.deepEqual(parseEnabledModelsMutation({ op: "provider", provider: "p", enabled: 1 }), { ok: false, error: "enabled must be a boolean" });
  assert.deepEqual(parseEnabledModelsMutation({ op: "clear", cwd: 7 }), { ok: false, error: "Invalid cwd" });
  assert.deepEqual(parseEnabledModelsMutation({ op: "resync" }), { ok: false, error: "Invalid resync payload" });
  assert.deepEqual(
    parseEnabledModelsMutation({ op: "resync", renames: [{ from: "a" }] }),
    { ok: false, error: "Invalid resync payload" },
  );
  assert.deepEqual(parseEnabledModelsMutation({ op: "provider", enabled: true }), { ok: false, error: "provider is required" });
  assert.deepEqual(parseEnabledModelsMutation({ op: "models", refs: "x", enabled: true }), { ok: false, error: "refs must be an array of strings" });
  assert.deepEqual(parseEnabledModelsMutation({ op: "models", refs: [1], enabled: true }), { ok: false, error: "refs must be an array of strings" });
});

// --- the HTTP implementations (the route's client contract) -----------------

function stubFetch(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    const answer = responses.shift() ?? { ok: true, status: 200, body: {} };
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

test("the read sends the cwd query and returns the parsed view", async () => {
  const fetchStub = stubFetch([{ ok: true, status: 200, body: { allEnabled: true, providers: [] } }]);
  try {
    const view = await fetchEnabledModelsView("/tmp/project");
    assert.deepEqual(view, { allEnabled: true, providers: [] });
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0].url, "/api/models/enabled?cwd=%2Ftmp%2Fproject");
    const bare = await fetchEnabledModelsView(null);
    assert.equal(fetchStub.calls[1].url, "/api/models/enabled", "no cwd means no query parameter");
    assert.deepEqual(bare, {});
  } finally {
    fetchStub.restore();
  }
});

test("the write serializes the mutation beside the cwd", async () => {
  const fetchStub = stubFetch([{ ok: true, status: 200, body: { allEnabled: false } }]);
  try {
    await applyEnabledModelsEdit({ op: "models", refs: ["p/m"], enabled: false }, "/tmp/x");
    assert.equal(fetchStub.calls[0].url, "/api/models/enabled");
    assert.equal(fetchStub.calls[0].init.method, "PUT");
    assert.deepEqual(JSON.parse(fetchStub.calls[0].init.body), {
      op: "models",
      refs: ["p/m"],
      enabled: false,
      cwd: "/tmp/x",
    });
  } finally {
    fetchStub.restore();
  }
});

test("a 409 body's reason becomes the shaped refusal the panel keys on", async () => {
  const fetchStub = stubFetch([
    { ok: false, status: 409, body: { error: "At least one model must stay enabled", reason: "last-model" } },
    { ok: false, status: 409, body: { error: "Project settings override enabledModels", reason: "project-scope" } },
  ]);
  try {
    const last = await applyEnabledModelsEdit({ op: "models", refs: ["p/last"], enabled: false }).then(
      () => null,
      (error) => error,
    );
    assert.ok(last instanceof EnabledModelsRefusalError, `shaped: ${last}`);
    assert.equal(last.reason, "last-model");
    assert.equal(last.message, "At least one model must stay enabled");
    const scoped = await applyEnabledModelsEdit({ op: "clear" }).then(() => null, (error) => error);
    assert.ok(scoped instanceof EnabledModelsRefusalError);
    assert.equal(scoped.reason, "project-scope");
  } finally {
    fetchStub.restore();
  }
});

test("unknown failures keep the body's text or the HTTP status", async () => {
  const fetchStub = stubFetch([
    { ok: false, status: 500, body: { error: "boom" } },
    { ok: false, status: 502, body: {} },
  ]);
  try {
    const withText = await fetchEnabledModelsView().then(() => null, (error) => error);
    assert.equal(withText.message, "boom");
    const bare = await fetchEnabledModelsView().then(() => null, (error) => error);
    assert.equal(bare.message, "HTTP 502");
  } finally {
    fetchStub.restore();
  }
});
