import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { "@": root } });
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
const { bindSubagentFleetClient, fetchSubagentFleet, sendSubagentFleetAction } = await jiti.import("./subagent-fleet-client.ts");

test("fleet uses dedicated IPC and normalizes status and inspect results", async () => {
  const mock = new MockTransport();
  mock.on("agent.subagentsStatus", args => {
    assert.deepEqual(args, { session: "s1" });
    return { available: true, ping: { version: 1, capabilities: { status: true } }, status: {} };
  });
  mock.on("agent.subagentsAction", args => {
    assert.deepEqual(args, { session: "s1", body: { action: "inspect", runId: "r1" } });
    return { action: "inspect", runId: "r1", result: { text: "fixture" } };
  });
  bindSubagentFleetClient(new IpcClient(mock));
  const status = await fetchSubagentFleet("s1");
  assert.equal(status.available, true);
  const result = await sendSubagentFleetAction("s1", { action: "inspect", runId: "r1" });
  assert.equal(result.view.text, "fixture");
});
