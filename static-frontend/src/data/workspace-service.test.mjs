/**
 * Tests for the static workspace service
 * (static-frontend/src/data/workspace-service.ts): the IPC request/response
 * shapes for chats.workspaceState / cwd.validate / cwd.createDefault and the
 * error-text contract (the pickers surface error.message directly).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const jiti = createJiti(import.meta.url, {
  alias: { "@": repoRoot },
  interopDefault: true,
});

const { fetchChatWorkspaceRoot, validateWorkspaceCwd, createDefaultWorkspaceCwd, bindWorkspaceService } =
  await jiti.import("./workspace-service.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

function bound(handler) {
  const mock = new MockTransport();
  if (handler) for (const [op, impl] of Object.entries(handler)) mock.on(op, impl);
  const client = new IpcClient(mock);
  bindWorkspaceService(client);
  return mock;
}

test("the chat root rides chats.workspaceState", async () => {
  bound({ "chats.workspaceState": () => ({ cwd: "/tmp/agent/chats" }) });
  assert.equal(await fetchChatWorkspaceRoot(), "/tmp/agent/chats");
});

test("cwd.validate passes the candidate and returns the validated shape", async () => {
  const calls = [];
  bound({
    "cwd.validate": (args) => {
      calls.push(args);
      return {
        success: true,
        cwd: "/tmp/proj",
        projectRoot: "/tmp/proj",
        projectKey: "proj-key",
      };
    },
  });
  const result = await validateWorkspaceCwd("~/proj");
  assert.deepEqual(calls, [{ cwd: "~/proj" }]);
  assert.equal(result.cwd, "/tmp/proj");
  assert.equal(result.projectKey, "proj-key");
  assert.equal(result.workspaceKind, undefined);
});

test("a chat-path validation keeps its workspaceKind", async () => {
  bound({
    "cwd.validate": () => ({
      success: true,
      cwd: "/tmp/agent/chats/20260101_x",
      projectRoot: null,
      projectKey: null,
      workspaceKind: "chat",
    }),
  });
  const result = await validateWorkspaceCwd("/tmp/agent/chats/20260101_x");
  assert.equal(result.workspaceKind, "chat");
});

test("validation failures reject with the host's error text", async () => {
  bound().fail("cwd.validate", { code: "invalid_args", message: "Directory does not exist: /nope" });
  await assert.rejects(validateWorkspaceCwd("/nope"), /Directory does not exist: \/nope/);
});

test("the default cwd rides cwd.createDefault", async () => {
  const calls = [];
  const mock = new MockTransport().on("cwd.createDefault", (args) => {
    calls.push(args);
    return { cwd: "/home/tester/pi-cwd/20261031" };
  });
  bindWorkspaceService(new IpcClient(mock));
  assert.equal(await createDefaultWorkspaceCwd(), "/home/tester/pi-cwd/20261031");
  assert.equal(calls.length, 1);
  assert.equal(calls[0], undefined, "no args: the host derives the local date");
});

test("every op failure rejects with the host's message, never a silent default", async () => {
  const mock = new MockTransport()
    .fail("chats.workspaceState", { code: "io", message: "cannot create the chat root" })
    .fail("cwd.createDefault", { code: "io", message: "cannot create the default dir" });
  bindWorkspaceService(new IpcClient(mock));
  await assert.rejects(fetchChatWorkspaceRoot(), /cannot create the chat root/);
  await assert.rejects(createDefaultWorkspaceCwd(), /cannot create the default dir/);
});
