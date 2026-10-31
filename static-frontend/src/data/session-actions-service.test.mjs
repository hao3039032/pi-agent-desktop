import assert from "node:assert/strict";
import test from "node:test";
import { IpcClient, MockTransport } from "../ipc/client.ts";
import { bindSessionActionsService, deleteSession, renameSession } from "./session-actions-service.ts";

test("renameSession sends one explicit sessions.rename IPC request", async () => {
  const calls = [];
  const transport = new MockTransport().on("sessions.rename", (args) => { calls.push(args); return { ok: true }; });
  bindSessionActionsService(new IpcClient(transport));
  await renameSession("session-1", "new title");
  assert.deepEqual(calls, [{ session: "session-1", name: "new title" }]);
});

test("deleteSession preserves the chat-folder option in one IPC call", async () => {
  const calls = [];
  const transport = new MockTransport().on("sessions.delete", (args) => { calls.push(args); return { ok: true }; });
  bindSessionActionsService(new IpcClient(transport));
  await deleteSession("session-1", true);
  assert.deepEqual(calls, [{ session: "session-1", trashChatFolder: true }]);
});

test("renameSession reports host errors without retrying", async () => {
  let calls = 0;
  const transport = new MockTransport().on("sessions.rename", () => { calls++; throw new Error("busy"); });
  bindSessionActionsService(new IpcClient(transport));
  await assert.rejects(renameSession("session-1", "new title"));
  assert.equal(calls, 1);
});
