import assert from "node:assert/strict";
import test from "node:test";
import { IpcClient, MockTransport } from "../ipc/client.ts";
import { parseIpcResponse } from "../ipc/protocol.ts";
import { bindChatSessionService, getChatAccess, setChatAccess, continueChatInProject } from "./chat-session-service.ts";

test("chat service sends explicit host-owned session operations", async () => {
  const calls = [];
  const transport = new MockTransport()
    .on("sessions.chatAccessGet", args => { calls.push(args); return { chat: true, folder: "/chat", unlocked: false, available: true }; })
    .on("sessions.chatAccessSet", args => { calls.push(args); return { success: true }; })
    .on("sessions.continueInProject", args => { calls.push(args); return { sessionId: "copy", path: "/copy", cwd: "/project", chatFolder: "/chat" }; });
  bindChatSessionService(new IpcClient(transport));
  assert.equal((await getChatAccess("chat")).unlocked, false);
  await setChatAccess("chat", true);
  assert.equal((await continueChatInProject("chat", "/project")).sessionId, "copy");
  assert.deepEqual(calls, [{ session: "chat" }, { session: "chat", unlocked: true }, { session: "chat", cwd: "/project" }]);
});

test("unknown mutation outcomes are not retried", async () => {
  let calls = 0;
  const transport = new MockTransport()
    .on("sessions.chatAccessSet", () => { calls++; throw new Error("outcome unknown"); })
    .on("sessions.continueInProject", () => { calls++; throw new Error("outcome unknown"); });
  bindChatSessionService(new IpcClient(transport));
  await assert.rejects(setChatAccess("chat", true));
  await assert.rejects(continueChatInProject("chat", "/project"));
  assert.equal(calls, 2);
});

test("unknown and partial outcomes remain distinct and non-retryable", () => {
  for (const code of ["outcome_unknown", "partial_success", "access_denied"]) {
    const response = parseIpcResponse({ v: 1, id: "x", ok: false, error: { code, message: "do not retry", retryable: false } }, "x");
    assert.equal(response.ok, false);
    assert.equal(response.error.code, code);
    assert.equal(response.error.retryable, false);
  }
});
