import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { IpcClient, MockTransport } = await jiti.import("../../static-frontend/src/ipc/client.ts");
const { bindPluginsClient, installPluginPackage } = await jiti.import("../../static-frontend/src/data/plugins-client.ts");

test("plugin install polls task progress then returns the real result", async () => {
  let polls = 0;
  const progress = [];
  const result = { packages: [], totals: {}, diagnostics: [] };
  const transport = new MockTransport()
    .on("plugins.install.start", () => ({ handle: "task-fixture" }))
    .on("plugins.install.status", ({ handle }) => {
      assert.equal(handle, "task-fixture");
      return ++polls === 1 ? { status: "running", progress: { phase: "running" } } : { status: "succeeded", result };
    });
  bindPluginsClient(new IpcClient(transport));
  assert.deepEqual(await installPluginPackage("/cwd", "fixture", "global", new AbortController().signal, (value) => progress.push(value)), result);
  assert.deepEqual(progress, ["running"]);
});

test("plugin install cancellation targets its handle and reports unknown", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const transport = new MockTransport()
    .on("plugins.install.start", () => ({ handle: "task-cancel" }))
    .on("plugins.install.status", ({ handle }) => {
      assert.equal(handle, "task-cancel");
      return cancelled ? { status: "unknown", error: "operation cancelled; outcome unknown" } : { status: "running", progress: { phase: "running" } };
    })
    .on("plugins.install.cancel", ({ handle }) => { assert.equal(handle, "task-cancel"); cancelled = true; return { requested: true }; });
  bindPluginsClient(new IpcClient(transport));
  await assert.rejects(installPluginPackage("/cwd", "fixture", "global", controller.signal, () => controller.abort()), /outcome unknown/);
  assert.equal(cancelled, true);
});
