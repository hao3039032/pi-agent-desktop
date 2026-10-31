import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { bindUpdateService, checkAppUpdates } = await jiti.import("./update-service.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

test("update service sends refresh and propagates host failures", async () => {
  const mock = new MockTransport();
  const calls = [];
  mock.on("updates.check", args => { calls.push(args); return { components: [], updates: [], nextCheckAt: "fixture" }; });
  bindUpdateService(new IpcClient(mock));
  await checkAppUpdates();
  await checkAppUpdates({ refresh: true });
  assert.deepEqual(calls, [{ refresh: false }, { refresh: true }]);
  mock.on("updates.check", () => { throw new Error("fixture failure"); });
  await assert.rejects(checkAppUpdates(), /fixture failure/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(checkAppUpdates({ signal: controller.signal }), { name: "AbortError" });
});
