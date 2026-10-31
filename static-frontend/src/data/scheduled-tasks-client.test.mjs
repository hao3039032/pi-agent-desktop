import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../../../", import.meta.url).pathname } });
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
const { bindScheduledTasksClient, scheduledApi } = await jiti.import("./scheduled-tasks-client.ts");

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
