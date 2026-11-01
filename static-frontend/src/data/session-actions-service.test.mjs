import assert from "node:assert/strict";
import test from "node:test";
import { IpcClient, MockTransport } from "../ipc/client.ts";
import { autoNameSession, bindSessionActionsService, deleteSession, renameSession } from "./session-actions-service.ts";

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

test("autoNameSession surfaces the host refusal without a retry", async () => {
  let calls = 0;
  const transport = new MockTransport().on("sessions.autoName", () => { calls++; throw new Error("not supported"); });
  bindSessionActionsService(new IpcClient(transport));
  await assert.rejects(autoNameSession("session-1"));
  assert.equal(calls, 1);
});

test("autoNameSession polls its bound task and returns the renamed title", async () => {
  const calls = [];
  const transport = new MockTransport()
    .on("sessions.autoName", args => { calls.push(args); return { task: "task-1" }; })
    .on("sessions.autoNameStatus", args => { calls.push(args); return { title: "Fixture" }; });
  bindSessionActionsService(new IpcClient(transport));
  assert.equal((await autoNameSession("session-1")).title, "Fixture");
  assert.deepEqual(calls, [{ session: "session-1" }, { session: "session-1", task: "task-1" }]);
});

test("autoNameSession cancels its task after an abort during start", async () => {
  const controller = new AbortController();
  const calls = [];
  const transport = new MockTransport()
    .on("sessions.autoName", () => { controller.abort(); return { task: "task-1" }; })
    .on("sessions.autoNameCancel", args => { calls.push(args); return { cancelled: true }; });
  bindSessionActionsService(new IpcClient(transport));
  await assert.rejects(autoNameSession("session-1", controller.signal), /cancelled/);
  assert.deepEqual(calls, [{ session: "session-1", task: "task-1" }]);
});

test("autoNameSession reports a confirmed rename even if abort races status", async () => {
  const controller = new AbortController();
  let cancellations = 0;
  const transport = new MockTransport()
    .on("sessions.autoName", () => ({ task: "task-1" }))
    .on("sessions.autoNameStatus", () => { controller.abort(); return { title: "Already renamed" }; })
    .on("sessions.autoNameCancel", () => { cancellations++; });
  bindSessionActionsService(new IpcClient(transport));
  assert.equal((await autoNameSession("session-1", controller.signal)).title, "Already renamed");
  assert.equal(cancellations, 0);
});

test("renameSession reports host errors without retrying", async () => {
  let calls = 0;
  const transport = new MockTransport().on("sessions.rename", () => { calls++; throw new Error("busy"); });
  bindSessionActionsService(new IpcClient(transport));
  await assert.rejects(renameSession("session-1", "new title"));
  assert.equal(calls, 1);
});
