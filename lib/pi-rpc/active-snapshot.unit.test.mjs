/**
 * Binary-free unit tests for RpcAgentSession.getActiveSnapshot: the
 * CLI-authoritative active-branch read (one get_entries response's entries +
 * leafId, plus get_tree's own tree projection). The client is a scripted fake
 * implementing the PiRpcClient surface RpcAgentSession reads, so CI runs this
 * without pi. The real-CLI behaviour after navigation is pinned by
 * lib/pi-rpc/active-leaf.smoke.test.mjs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { RpcAgentSession } = await jiti.import("./session.ts");

class FakeRpcClient {
  constructor() {
    this.listeners = new Set();
    this.exitListeners = new Set();
    this.sent = [];
    /** command type -> (data, client) => response data (may throw/reject). */
    this.handlers = new Map();
    this.exited = false;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onUi() {
    return () => {};
  }

  onProcessExit(listener) {
    this.exitListeners.add(listener);
    if (this.exited) listener(null);
    return () => this.exitListeners.delete(listener);
  }

  command(type, data = {}, timeoutMs = 120_000) {
    this.sent.push({ type, ...data });
    const handler = this.handlers.get(type);
    if (!handler) return Promise.reject(new Error(`fake client: no handler for '${type}'`));
    const cap = Math.min(timeoutMs ?? Infinity, 5_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake client: '${type}' did not answer within ${cap} ms`)), cap);
      Promise.resolve().then(() => handler(data, this)).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  close() {
    return Promise.resolve(0);
  }

  kill() {}
}

function makeSession(client) {
  return new RpcAgentSession({
    client,
    initialState: {
      sessionId: "snap-test",
      isStreaming: false,
      isCompacting: false,
      isIdle: true,
      autoCompactionEnabled: true,
      autoRetryEnabled: undefined,
      retryAttempt: 0,
      messageCount: 0,
      pendingMessageCount: 0,
      steeringQueue: [],
      followUpQueue: [],
    },
  });
}

test("getActiveSnapshot asks get_entries and get_tree and returns the entries response's leafId", async () => {
  const client = new FakeRpcClient();
  client.handlers.set("get_entries", () => ({
    entries: [{ type: "message", id: "e1", parentId: null }],
    leafId: "e1",
  }));
  // A navigation between the two commands makes get_tree's leafId newer; the
  // snapshot must keep the leafId consistent with the entries it returns.
  client.handlers.set("get_tree", () => ({ tree: [{ entry: { id: "e1" }, children: [] }], leafId: "e2" }));
  const session = makeSession(client);

  const snapshot = await session.getActiveSnapshot();

  assert.deepEqual(snapshot.entries, [{ type: "message", id: "e1", parentId: null }]);
  assert.deepEqual(snapshot.tree, [{ entry: { id: "e1" }, children: [] }]);
  assert.equal(snapshot.leafId, "e1");
  assert.deepEqual(client.sent.map((record) => record.type).sort(), ["get_entries", "get_tree"]);
});

test("getActiveSnapshot accepts a null leafId (an empty or reset-to-root session)", async () => {
  const client = new FakeRpcClient();
  client.handlers.set("get_entries", () => ({ entries: [], leafId: null }));
  client.handlers.set("get_tree", () => ({ tree: [], leafId: null }));
  const session = makeSession(client);

  const snapshot = await session.getActiveSnapshot();
  assert.equal(snapshot.leafId, null);
  assert.deepEqual(snapshot.entries, []);
});

test("getActiveSnapshot rejects on malformed answers instead of guessing", async () => {
  const malformed = [
    [{ entries: "nope", leafId: null }, { tree: [] }, /did not return an entries array/],
    [{ entries: [], leafId: null }, { tree: "nope" }, /did not return a tree array/],
    [{ entries: [], leafId: 7 }, { tree: [] }, /did not return a leafId string or null/],
  ];
  for (const [entriesAnswer, treeAnswer, pattern] of malformed) {
    const client = new FakeRpcClient();
    client.handlers.set("get_entries", () => entriesAnswer);
    client.handlers.set("get_tree", () => treeAnswer);
    const session = makeSession(client);
    await assert.rejects(session.getActiveSnapshot(), pattern);
  }
});

test("getActiveSnapshot propagates a failed live query as an explicit error", async () => {
  const client = new FakeRpcClient();
  client.handlers.set("get_entries", () => {
    throw new Error("pi RPC 'get_entries' failed");
  });
  client.handlers.set("get_tree", () => ({ tree: [], leafId: null }));
  const session = makeSession(client);
  await assert.rejects(session.getActiveSnapshot(), /pi RPC 'get_entries' failed/);
});
