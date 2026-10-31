import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../../../", import.meta.url).pathname } });
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
const { bindScheduledTasksClient, scheduledApi } = await jiti.import("./scheduled-tasks-client.ts");
const { bindScheduledTasksStore } = await jiti.import("./scheduled-tasks-store.ts");

test("scheduled preview uses the host IPC and preserves validation details", async () => {
  const transport = new MockTransport().on("tasks.previewCron", (args) => {
    assert.deepEqual(args, { expr: "* * * * *", timezone: "UTC" });
    return { valid: false, key: "scheduled.error.interval", params: { minutes: 5 } };
  });
  bindScheduledTasksClient(new IpcClient(transport));
  const result = await scheduledApi.preview("* * * * *", "UTC");
  assert.equal(result.valid, false);
  assert.equal(result.key, "scheduled.error.interval");
});

test("task editing uses IPC rather than HTTP", async () => {
  const seen = [];
  const transport = new MockTransport().on("tasks.list", () => ({ tasks: [] }));
  for (const op of ["tasks.create", "tasks.get", "tasks.update", "tasks.delete"]) {
    transport.on(op, (args) => { seen.push([op, args]); return op === "tasks.delete" ? { success: true } : { task: { id: "fixture" } }; });
  }
  const client = new IpcClient(transport);
  bindScheduledTasksClient(client);
  bindScheduledTasksStore(client);
  await scheduledApi.create({ name: "fixture" });
  await scheduledApi.get("fixture");
  await scheduledApi.update("fixture", { name: "renamed" });
  await scheduledApi.remove("fixture");
  assert.deepEqual(seen.map(([op]) => op), ["tasks.create", "tasks.get", "tasks.update", "tasks.delete"]);
  assert.deepEqual(seen[2][1], { id: "fixture", patch: { name: "renamed" } });
});
