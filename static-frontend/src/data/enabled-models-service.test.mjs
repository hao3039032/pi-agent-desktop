/**
 * Tests for the enabledModels + models-config IPC services (the static
 * build's alias targets for lib/enabled-models-service.ts and
 * lib/models-config-service.ts): the ops they call, the refusal-code
 * translation the panel's FAILURE_KEYS consume, and the no-HTTP contract
 * (a raw fetch here would be a production blocker — the static app has no
 * server to answer it).
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

const { bindEnabledModelsService } = await jiti.import("./enabled-models-service.ts");
const { bindModelsConfigService } = await jiti.import("./models-config-service.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
// The refusal class the hook instanceof-checks: the static impl re-exports
// the repo's client-half binding, so the identity check works exactly like
// the HTTP path's.
const { EnabledModelsRefusalError } = await jiti.import("./enabled-models-service.ts");

function bound(handler) {
  const mock = new MockTransport();
  if (handler) for (const [op, impl] of Object.entries(handler)) mock.on(op, impl);
  const client = new IpcClient(mock);
  bindEnabledModelsService(client);
  bindModelsConfigService(client);
  return mock;
}

test("the switch read asks models.enabledGet with the scoped cwd", async () => {
  const calls = [];
  bound({
    "models.enabledGet": (args) => {
      calls.push(args);
      return { allEnabled: true, providers: [] };
    },
  });
  const { fetchEnabledModelsView } = await jiti.import("./enabled-models-service.ts");
  const view = await fetchEnabledModelsView("/tmp/some-project");
  assert.deepEqual(calls, [{ cwd: "/tmp/some-project" }]);
  assert.equal(view.allEnabled, true);
});

test("a write forwards the mutation verbatim beside the scoped cwd", async () => {
  const calls = [];
  bound({
    "models.enabledSet": (args) => {
      calls.push(args);
      return { allEnabled: false, providers: [] };
    },
  });
  const { applyEnabledModelsEdit } = await jiti.import("./enabled-models-service.ts");
  await applyEnabledModelsEdit({ op: "models", refs: ["p/m"], enabled: false }, "/tmp/x");
  await applyEnabledModelsEdit({ op: "resync", renames: [{ from: "a", to: "b" }], modelRenames: [], fullyEnabled: ["a"] }, "/tmp/x");
  assert.deepEqual(calls, [
    { cwd: "/tmp/x", op: "models", refs: ["p/m"], enabled: false },
    { cwd: "/tmp/x", op: "resync", renames: [{ from: "a", to: "b" }], modelRenames: [], fullyEnabled: ["a"] },
  ]);
});

test("the protocol's refusal reasons translate into the hook's refusal shape", async () => {
  // MockTransport.fail carries a code; the transport maps a thrown plain
  // error to invalid_args, so use the explicit failure seam for the codes.
  const mock = new MockTransport();
  mock.fail("models.enabledSet", {
    code: "io",
    message: "At least one model must stay enabled",
    reason: "last-model",
  });
  const client = new IpcClient(mock);
  bindEnabledModelsService(client);
  const { applyEnabledModelsEdit } = await jiti.import("./enabled-models-service.ts");
  const failure = await applyEnabledModelsEdit({ op: "models", refs: ["p/last"], enabled: false }, "/tmp/x").then(
    () => null,
    (error) => error,
  );
  assert.ok(failure instanceof EnabledModelsRefusalError, `a shaped refusal, got ${failure}`);
  assert.equal(failure.reason, "last-model");

  const scopeMock = new MockTransport();
  scopeMock.fail("models.enabledSet", {
    code: "io",
    message: "Project settings override enabledModels",
    reason: "project-scope",
  });
  bindEnabledModelsService(new IpcClient(scopeMock));
  const scoped = await applyEnabledModelsEdit({ op: "clear" }, "/tmp/x").then(
    () => null,
    (error) => error,
  );
  assert.ok(scoped instanceof EnabledModelsRefusalError);
  assert.equal(scoped.reason, "project-scope");
});

test("an unshaped failure stays a plain error with the host's message", async () => {
  const mock = new MockTransport();
  mock.fail("models.enabledGet", { code: "io", message: "the management instance is not configured" });
  bindEnabledModelsService(new IpcClient(mock));
  const { fetchEnabledModelsView } = await jiti.import("./enabled-models-service.ts");
  const failure = await fetchEnabledModelsView("/tmp/x").then(() => null, (error) => error);
  assert.ok(failure instanceof Error);
  assert.ok(!(failure instanceof EnabledModelsRefusalError));
  assert.match(failure.message, /management instance is not configured/);
});

test("the models.json read asks modelsConfig.get and carries no HTTP path", async () => {
  const calls = [];
  bound({
    "modelsConfig.get": () => {
      calls.push("get");
      return { providers: { "fixture-provider": { models: [{ id: "m" }] } } };
    },
  });
  const { fetchModelsConfig } = await jiti.import("./models-config-service.ts");
  const loaded = await fetchModelsConfig();
  assert.deepEqual(calls, ["get"]);
  assert.equal(loaded.providers["fixture-provider"].models.length, 1);
});

test("an unbound service refuses loudly instead of answering empty", async () => {
  // A fresh jiti instance: the shared module above is already bound from the
  // earlier tests, and the point here is the NEVER-bound boot state.
  const freshJiti = createJiti(import.meta.url, {
    alias: { "@": repoRoot },
    interopDefault: true,
    moduleCache: false,
  });
  const { fetchEnabledModelsView } = await freshJiti.import("./enabled-models-service.ts");
  await assert.rejects(
    () => fetchEnabledModelsView("/tmp/x"),
    /enabledModels service IPC bridge is not configured/,
  );
});
