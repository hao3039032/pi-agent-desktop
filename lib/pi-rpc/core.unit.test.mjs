/**
 * FileSessionManagerView reads the session file the CLI child appends.
 * GET /api/sessions/[id] calls getTree() on that view while the wrapper is
 * alive; a missing method is the HTTP 500 at the end of a turn.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { FileSessionManagerView } = await jiti.import("./core.ts");

function entryIds(nodes) {
  return nodes.map((node) => ({
    id: node.entry.id,
    children: entryIds(node.children),
  }));
}

test("FileSessionManagerView.getTree matches the session file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rpc-tree-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "world" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const file = manager.getSessionFile();
  try {
    const view = new FileSessionManagerView(file, root, sessionDir);
    const expected = SessionManager.open(file, sessionDir).getTree();
    assert.deepEqual(entryIds(view.getTree()), entryIds(expected));
    assert.ok(entryIds(expected).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
