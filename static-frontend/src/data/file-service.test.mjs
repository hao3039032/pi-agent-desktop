/**
 * Tests for the static file-tree service (static-frontend/src/data/file-service.ts):
 * the IPC request/response shapes for files.list / files.allowLink and the
 * entry mapping onto the FileNode shape FileExplorer consumes.
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

const { fetchFileEntries, allowOutsideLink, bindFileService } = await jiti.import("./file-service.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

function boundService(handler) {
  const mock = new MockTransport();
  if (handler) mock.on("files.list", handler);
  const client = new IpcClient(mock);
  bindFileService(client);
  return mock;
}

test("files.list maps entries onto the FileNode shape with full paths", async () => {
  boundService(() => ({
    entries: [
      { name: "sub", isDir: true, size: 0, modified: "" },
      { name: "a.txt", isDir: false, size: 0, modified: "" },
      {
        name: "linked",
        isDir: true,
        size: 0,
        modified: "",
        outsideLinkTarget: "/outside/target",
        outsideLinkEncloses: false,
      },
    ],
    path: "/proj",
  }));
  const nodes = await fetchFileEntries("/proj");
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes[0], {
    name: "sub",
    fullPath: "/proj/sub",
    isDir: true,
    size: 0,
    children: [],
    loaded: false,
    outsideLinkTarget: undefined,
    outsideLinkEncloses: undefined,
  });
  assert.equal(nodes[1].loaded, true, "a file node is loaded");
  assert.equal(nodes[1].children, undefined, "file nodes have no children array");
  assert.equal(nodes[2].outsideLinkTarget, "/outside/target");
  assert.equal(nodes[2].outsideLinkEncloses, false);
});

test("an out-of-scope listing surfaces the host's message", async () => {
  const mock = boundService(null);
  mock.on("files.list", () => {
    const error = new Error("no host handler");
    throw error;
  });
  await assert.rejects(fetchFileEntries("/etc"), /no host handler|Failed to load files/);
});

test("allowOutsideLink sends the shown target and surfaces refusals", async () => {
  const mock = boundService(null);
  const calls = [];
  mock.on("files.allowLink", (args) => {
    calls.push(args);
    return { target: args.target, alreadyAllowed: false };
  });
  await allowOutsideLink("/proj/link", "/outside/target");
  assert.deepEqual(calls, [{ link: "/proj/link", target: "/outside/target" }],
    "the operator's shown target rides the request verbatim");

  // A re-aimed link: the host refuses with the changed-target message.
  mock.on("files.allowLink", () => {
    const failure = new Error("Link target changed; refresh the file list");
    throw failure;
  });
  await assert.rejects(
    allowOutsideLink("/proj/link", "/outside/other"),
    /changed/,
  );
});
