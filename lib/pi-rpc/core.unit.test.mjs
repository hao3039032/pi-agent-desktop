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
const { CliAgentSessionCore, FileSessionManagerView, initialCoreState } = await jiti.import("./core.ts");

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

/** The stdio surface the core touches; a scripted stand-in for PiRpcClient. */
class FakeRpcClient {
  constructor() {
    this.uiHandlers = new Map();
    this.events = new Set();
    this.exits = new Set();
    this.exited = false;
    this.hasExited = false;
  }

  onEvent(listener) {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  onUi(method, handler) {
    this.uiHandlers.set(method, handler);
    return () => this.uiHandlers.delete(method);
  }

  onProcessExit(listener) {
    this.exits.add(listener);
    if (this.exited) listener(null);
    return () => this.exits.delete(listener);
  }

  command(type) {
    return Promise.reject(new Error(`fake client: '${type}' is not scripted`));
  }

  /** One extension_ui_request as the child's stdout would deliver it. */
  emitUi(record) {
    const handler = this.uiHandlers.get(record.method);
    if (handler) handler({ type: "extension_ui_request", ...record });
  }

  close() {
    return Promise.resolve(0);
  }

  kill() {}
}

function makeCore(root) {
  const client = new FakeRpcClient();
  const core = new CliAgentSessionCore({
    client,
    initialState: initialCoreState({ sessionId: "startup-ui" }),
    sessionFile: join(root, "session.jsonl"),
    cwd: root,
    knownToolNames: ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"],
    bridgeExtensionPath: join(root, "pi-web-bridge.mjs"),
    bridgeNonce: "startup-ui-nonce",
    agentDir: root,
    onLog: () => {},
  });
  return { client, core };
}

test("child UI raised before the relay exists is replayed in arrival order at attach", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rpc-relay-backlog-"));
  try {
    const { client, core } = makeCore(root);
    // The child notifies while it boots: the core's notify handler exists (the
    // bridge result channel owns it) but there is no wrapper to hand it to yet.
    client.emitUi({ id: "n-1", method: "notify", message: "loading project" });
    client.emitUi({ id: "n-2", method: "notify", message: "still loading" });

    const delivered = [];
    core.attachUiRelay({
      relayExternalUiRequest: async () => ({ cancelled: true }),
      relayExternalUiEvent: (event) => delivered.push(event.id),
    });
    assert.deepEqual(delivered, ["n-1", "n-2"], "both startup notifies arrive, in arrival order");

    client.emitUi({ id: "n-3", method: "notify", message: "after attach" });
    assert.deepEqual(delivered, ["n-1", "n-2", "n-3"], "later notifies relay immediately");
    core.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bridge result notify is consumed before the relay exists, not queued as user UI", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rpc-relay-bridge-"));
  try {
    const { client, core } = makeCore(root);
    // The tool listing runs BEFORE attachUiRelay: its result notify must be
    // handled by the bridge channel immediately (it is not user-facing UI).
    client.emitUi({
      id: "b-1",
      method: "notify",
      message: `PI_WEB_BRIDGE_V1 ${JSON.stringify({ requestId: "unknown-request", ok: false }) }`,
    });
    const delivered = [];
    core.attachUiRelay({
      relayExternalUiRequest: async () => ({ cancelled: true }),
      relayExternalUiEvent: (event) => delivered.push(event.message),
    });
    assert.deepEqual(delivered, [], "a bridge envelope is never replayed as user UI");
    core.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initialCoreState leaves auto-retry unknown: get_state reports no such field", () => {
  const state = initialCoreState({ sessionId: "s" });
  assert.equal(state.autoRetryEnabled, undefined, "an unconfirmed retry policy is not claimed as enabled");
  assert.equal(initialCoreState({ sessionId: "s", autoRetryEnabled: false }).autoRetryEnabled, false,
    "a value the child did report is kept");
});
