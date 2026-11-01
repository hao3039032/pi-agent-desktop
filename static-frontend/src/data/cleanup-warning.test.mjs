import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { appNotify } = await jiti.import("../../../lib/notification-store.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
const { bindAgentClient, sendAgentCommand } = await jiti.import("./agent-client.ts");
const { bindChatSessionService, continueChatInProject, setChatAccess } = await jiti.import("./chat-session-service.ts");
const { bindSessionActionsService, autoNameSession } = await jiti.import("./session-actions-service.ts");

test("known outcomes remain successful and surface cleanup warnings without retry", async () => {
  const notices = []; const previous = appNotify.warning;
  appNotify.warning = (notice) => { notices.push(notice); return "fixture"; };
  let calls = 0;
  const mock = new MockTransport()
    .on("sessions.chatAccessSet", () => { calls++; return { success: true, cleanupWarning: "access saved; cleanup uncertain" }; })
    .on("sessions.continueInProject", () => { calls++; return { sessionId: "copy", cleanupWarning: "copy created; cleanup uncertain" }; })
    .on("agent.command", () => { calls++; return { newSessionId: "fork", cleanupWarning: "fork created; cleanup uncertain" }; })
    .on("sessions.autoName", () => { calls++; return { task: "title" }; })
    .on("sessions.autoNameStatus", () => { calls++; return { title: "name", cleanupWarning: "title saved; cleanup uncertain" }; });
  try {
    const client = new IpcClient(mock);
    bindChatSessionService(client); bindSessionActionsService(client); bindAgentClient(mock);
    await setChatAccess("s", true);
    assert.equal((await continueChatInProject("s", "/project")).sessionId, "copy");
    assert.equal((await sendAgentCommand("s", { type: "fork" })).newSessionId, "fork");
    assert.equal((await autoNameSession("s")).title, "name");
    assert.equal(calls, 5);
    assert.deepEqual(notices.map((notice) => notice.message), ["access saved; cleanup uncertain", "copy created; cleanup uncertain", "fork created; cleanup uncertain", "title saved; cleanup uncertain"]);
    assert.ok(notices.every((notice) => notice.persistent === true));
  } finally { appNotify.warning = previous; }
});
