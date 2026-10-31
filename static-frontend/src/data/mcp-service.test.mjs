import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
const {
  bindMcpService,
  fetchMcpOverview,
  postMcpAction,
  postMcpTest,
} = await jiti.import("./mcp-service.ts");

test("static mcp-service fetches global overview and scoped overview over mock transport", async () => {
  const transport = new MockTransport();
  const calls = [];

  transport.on("mcp.configGet", (args) => {
    calls.push(args);
    return {
      mcp: { available: true },
      files: [{ scope: "global", path: "/tmp/mcp.json", exists: true }],
      servers: [{ scope: "global", name: "test-server", validated: true }],
    };
  });

  const client = new IpcClient(transport);
  bindMcpService(client);

  const globalOverview = await fetchMcpOverview();
  assert.equal(globalOverview.ok, true);
  assert.equal(globalOverview.data.servers.length, 1);
  assert.deepEqual(calls[0], {});

  const scopedOverview = await fetchMcpOverview("/tmp/project");
  assert.equal(scopedOverview.ok, true);
  assert.deepEqual(calls[1], { cwd: "/tmp/project" });
});

test("static mcp-service posts actions over mock transport", async () => {
  const transport = new MockTransport();
  let receivedAction = null;

  transport.on("mcp.configAction", (args) => {
    receivedAction = args;
    return {
      mcp: { available: true },
      files: [],
      servers: [],
      added: { scope: "global", name: "new-server", path: "/tmp/mcp.json" },
    };
  });

  const client = new IpcClient(transport);
  bindMcpService(client);

  const result = await postMcpAction(
    { action: "add", text: "npx some-mcp-server", scope: "global" },
    "/tmp/project",
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.added.name, "new-server");
  assert.deepEqual(receivedAction, {
    action: "add",
    text: "npx some-mcp-server",
    scope: "global",
    cwd: "/tmp/project",
  });
});

test("static mcp-service surfaces error reason from IpcFailure", async () => {
  const transport = new MockTransport();
  transport.fail("mcp.configAction", {
    code: "invalid_request",
    message: "name-taken",
    reason: "name-taken",
    name: "existing",
  });

  const client = new IpcClient(transport);
  bindMcpService(client);

  const result = await postMcpAction(
    { action: "add", text: "npx some-mcp-server", scope: "global" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, "name-taken");
});

test("static mcp-service preserves structured refusal details from IPC", async () => {
  const transport = {
    async send(request) {
      return { v: 1, id: request.id, ok: false, error: { code: "io", message: "Name taken", reason: "name-taken", retryable: false, details: { name: "docs", suggestedName: "docs-2" } } };
    },
  };
  bindMcpService(new IpcClient(transport));
  const result = await postMcpAction({ action: "remove", scope: "global", name: "docs" });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, "name-taken");
  assert.equal(result.error.name, "docs");
  assert.equal(result.error.suggestedName, "docs-2");
});

test("static MCP probe uses the typed operation", async () => {
  const transport = new MockTransport();
  let received;
  transport.on("mcp.test", (args) => { received = args; return { scope: "project", name: "docs", configKey: "key", result: { state: "connected", tools: [], testedAt: 1 } }; });
  bindMcpService(new IpcClient(transport));
  const answer = await postMcpTest({ scope: "project", name: "docs", cwd: "/project" });
  assert.equal(answer.ok, true);
  assert.deepEqual(received, { scope: "project", name: "docs", cwd: "/project" });
});

test("static mcp-service honors AbortSignal", async () => {
  const transport = new MockTransport();
  const client = new IpcClient(transport);
  bindMcpService(client);

  const controller = new AbortController();
  controller.abort();

  const getResult = await fetchMcpOverview(null, controller.signal);
  assert.equal(getResult.ok, false);
  assert.match(getResult.error.error, /aborted/i);

  const actionResult = await postMcpAction({ action: "enable", scope: "global", name: "s" }, null, controller.signal);
  assert.equal(actionResult.ok, false);
  assert.match(actionResult.error.error, /aborted/i);
});
