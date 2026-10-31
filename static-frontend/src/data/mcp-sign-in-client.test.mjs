import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
const { bindMcpSignInClient, requestMcpSignIn } = await jiti.import("./mcp-sign-in-client.ts");

test("MCP sign-in client routes start, status, submit and cancel through IPC", async () => {
  const transport = new MockTransport();
  const calls = [];
  for (const op of ["mcp.signInStart", "mcp.signInStatus", "mcp.signInSubmit", "mcp.signInCancel"]) {
    transport.on(op, (args) => { calls.push([op, args]); return { flowId: "task-1", phase: "authorize", scope: "global", name: "fixture", expiresInMs: 1 }; });
  }
  bindMcpSignInClient(new IpcClient(transport));
  const signal = new AbortController().signal;
  assert.equal((await requestMcpSignIn("/api/mcp/sign-in", { method: "POST", body: JSON.stringify({ scope: "global", name: "fixture" }) }, signal)).ok, true);
  await requestMcpSignIn("/api/mcp/sign-in/task-1", {}, signal);
  await requestMcpSignIn("/api/mcp/sign-in/task-1", { method: "POST", body: JSON.stringify({ redirectUrl: "http://localhost/?code=x" }) }, signal);
  await requestMcpSignIn("/api/mcp/sign-in/task-1", { method: "DELETE" }, signal);
  assert.deepEqual(calls, [["mcp.signInStart", { scope: "global", name: "fixture" }], ["mcp.signInStatus", { flowId: "task-1" }], ["mcp.signInSubmit", { flowId: "task-1", redirectUrl: "http://localhost/?code=x" }], ["mcp.signInCancel", { flowId: "task-1" }]]);
});
