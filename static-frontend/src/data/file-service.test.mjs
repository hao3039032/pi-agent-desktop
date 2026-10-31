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

const {
  fetchFileEntries,
  allowOutsideLink,
  searchFileIndex,
  fetchFileIndex,
  readFileContent,
  grantFileResource,
  readFileResource,
  revokeFileResource,
  bindFileService,
} = await jiti.import("./file-service.ts");
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

test("searchFileIndex sends cwd and q to files.index and returns matches", async () => {
  const mock = boundService(null);
  const calls = [];
  mock.on("files.index", (args) => {
    calls.push(args);
    return {
      matches: [
        { path: "src/Chat.tsx", isDir: false },
        { path: "src", isDir: true },
      ],
    };
  });
  const results = await searchFileIndex("/proj", "chat");
  assert.deepEqual(calls, [{ cwd: "/proj", q: "chat" }]);
  assert.equal(results.length, 2);
  assert.equal(results[0].path, "src/Chat.tsx");
  assert.equal(results[0].isDir, false);
});

test("fetchFileIndex sends cwd to files.index and returns files with truncated flag", async () => {
  const mock = boundService(null);
  const calls = [];
  mock.on("files.index", (args) => {
    calls.push(args);
    return {
      files: ["a.ts", "b.ts"],
      truncated: false,
    };
  });
  const res = await fetchFileIndex("/proj");
  assert.deepEqual(calls, [{ cwd: "/proj" }]);
  assert.deepEqual(res, { files: ["a.ts", "b.ts"], truncated: false });
});

test("readFileContent sends path to files.read and returns mime and data", async () => {
  const mock = boundService(null);
  const calls = [];
  mock.on("files.read", (args) => {
    calls.push(args);
    return {
      mime: "text/plain",
      data: "aGVsbG8=",
    };
  });
  const res = await readFileContent("/proj/file.txt");
  assert.deepEqual(calls, [{ path: "/proj/file.txt" }]);
  assert.equal(res.mime, "text/plain");
  assert.equal(res.data, "aGVsbG8=");
});

test("resource protocol functions roundtrip through resources.* ops", async () => {
  const mock = boundService(null);
  mock.on("resources.grantFile", (args) => {
    assert.equal(args.path, "/proj/img.png");
    return { handle: "handle-123" };
  });
  mock.on("resources.read", (args) => {
    assert.equal(args.handle, "handle-123");
    return {
      mime: "image/png",
      data: "iVBORw0KGgo=",
      totalLen: 8,
      rangeApplied: false,
    };
  });
  mock.on("resources.revoke", (args) => {
    assert.equal(args.handle, "handle-123");
    return { revoked: true };
  });

  const handle = await grantFileResource("/proj/img.png");
  assert.equal(handle, "handle-123");
  const readRes = await readFileResource(handle);
  assert.equal(readRes.mime, "image/png");
  const revoked = await revokeFileResource(handle);
  assert.equal(revoked, true);
});
