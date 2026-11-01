import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readRecoveryStatus } = await jiti.import("./recovery-status.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

test("recovery status preserves pending and uninspectable without issuing a mutation", async () => {
  let calls = 0;
  const transport = new MockTransport().on("desktop.recoveryStatus", (args) => {
    calls++;
    assert.equal(args, undefined);
    return { trustPolicy: "pending", sessionWriters: "uninspectable", deletionJournal: "clear" };
  });
  assert.deepEqual(await readRecoveryStatus(new IpcClient(transport)), {
    trustPolicy: "pending", sessionWriters: "uninspectable", deletionJournal: "clear",
  });
  assert.equal(calls, 1);
});

test("malformed or unavailable status is not treated as clear", async () => {
  const bad = new IpcClient(new MockTransport().on("desktop.recoveryStatus", () => ({ trustPolicy: "clear" })));
  await assert.rejects(readRecoveryStatus(bad), /Invalid recovery status/);
  await assert.rejects(readRecoveryStatus(new IpcClient(new MockTransport())));
});
