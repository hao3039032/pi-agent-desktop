/**
 * Binary-free unit tests for the host side of the pi-web bridge request/reply
 * protocol (CliAgentSessionCore.bridgeRequest + the notify result channel):
 * correlation by requestId, nonce/session/source validation, the ack-vs-reply
 * order rules, timeouts, child exit, disposal, concurrency, real tool
 * metadata caching and post-switch confirmation. The client is a scripted
 * fake implementing the PiRpcClient surface (onEvent/onUi/onProcessExit/
 * command/close/kill/hasExited) the way the real child behaves: the result
 * notify is emitted BEFORE the prompt ack, both in one stdout chunk.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { CliAgentSessionCore, ensureSessionFile } = await jiti.import("./core.ts");

const BRIDGE_PREFIX = "PI_WEB_BRIDGE_V1 ";
const NONCE = "unit-nonce-1";
const SESSION_ID = "unit-session";
const KNOWN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"];

/** The fake client: one prompt dispatch runs the "child" synchronously. */
class FakeRpcClient {
  constructor(bridgePath, { ackCapMs = 5_000 } = {}) {
    this.bridgePath = bridgePath;
    /** How long a command may stay unanswered before the fake rejects it (the real client's own timeout). */
    this.ackCapMs = ackCapMs;
    this.listeners = new Set();
    this.exitListeners = new Set();
    this.uiHandlers = new Map();
    this.sent = [];
    this.handlers = new Map();
    this.exited = false;
    this.hasExited = false;
    /** In-flight command promises, rejected on exit like PiRpcClient.failAll. */
    this.pendingCommands = new Set();
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onUi(method, handler) {
    this.uiHandlers.set(method, handler);
    return () => this.uiHandlers.delete(method);
  }

  onProcessExit(listener) {
    this.exitListeners.add(listener);
    if (this.exited) listener(null);
    return () => this.exitListeners.delete(listener);
  }

  /** Deliver one notify record the way the child's stdout would. */
  notify(message) {
    const handler = this.uiHandlers.get("notify");
    if (handler) handler({ type: "extension_ui_request", id: "n-1", method: "notify", message });
  }

  exit(code = null) {
    this.exited = true;
    this.hasExited = true;
    // The real client rejects every in-flight command on exit (failAll).
    for (const pending of [...this.pendingCommands]) {
      pending.reject(new Error(`pi process exited during shutdown (code ${code ?? "?"})`));
      this.pendingCommands.delete(pending);
    }
    for (const listener of [...this.exitListeners]) listener(code);
  }

  command(type, data = {}, timeoutMs = 120_000) {
    this.sent.push({ type, ...data });
    const handler = this.handlers.get(type);
    if (!handler) return Promise.reject(new Error(`fake client: no handler for '${type}'`));
    return new Promise((resolve, reject) => {
      const pending = { reject };
      this.pendingCommands.add(pending);
      const timer = setTimeout(() => reject(new Error(`fake client: '${type}' did not answer`)), Math.min(timeoutMs ?? 120_000, this.ackCapMs));
      Promise.resolve().then(() => handler(data, this)).then(
        (value) => { clearTimeout(timer); this.pendingCommands.delete(pending); resolve(value); },
        (error) => { clearTimeout(timer); this.pendingCommands.delete(pending); reject(error instanceof Error ? error : new Error(String(error))); },
      );
    });
  }

  close() { return Promise.resolve(0); }
  kill() {}
}

let sandboxCounter = 0;

/** A core over the fake client, with the bridge command source-verified. */
async function makeCore({
  bridgeCommands = ["pi-web:bridge", "pi-web:navigate", "pi-web:reload"],
  tools,
  active,
  bridgeTimeoutMs,
  childExitTimeoutMs,
  sessionFile,
  sessionDir,
} = {}) {
  const sandbox = join(tmpdir(), `pi-web-bridge-proto-${Date.now()}-${sandboxCounter++}`);
  const bridgePath = join(sandbox, "pi-web-bridge.mjs");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(bridgePath, "// fixture bridge asset\n");

  const client = new FakeRpcClient(bridgePath);
  client.handlers.set("get_commands", () => ({
    commands: bridgeCommands.map((name) => ({
      name,
      description: "pi-web internal",
      source: "extension",
      sourceInfo: { path: bridgePath, source: "cli", scope: "temporary", origin: "top-level" },
    })),
  }));
  const core = new CliAgentSessionCore({
    client,
    initialState: {
      sessionId: SESSION_ID,
      isStreaming: false,
      isCompacting: false,
      isIdle: true,
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      retryAttempt: 0,
      messageCount: 0,
      pendingMessageCount: 0,
      steeringQueue: [],
      followUpQueue: [],
    },
    sessionFile: sessionFile ?? join(sandbox, "session.jsonl"),
    cwd: sandbox,
    knownToolNames: KNOWN_TOOLS,
    bridgeExtensionPath: bridgePath,
    bridgeNonce: NONCE,
    ...(bridgeTimeoutMs !== undefined ? { bridgeTimeoutMs } : {}),
    ...(childExitTimeoutMs !== undefined ? { childExitTimeoutMs } : {}),
    ...(sessionDir !== undefined ? { sessionDir } : {}),
    agentDir: sandbox,
    onLog: () => {},
  });
  await core.refreshCommands();
  const cleanup = () => rm(sandbox, { recursive: true, force: true });

  /** The default child: answers the bridge command with the given envelope. */
  const childAnswers = (envelope) => {
    client.handlers.set("prompt", (data) => {
      const match = /^\/pi-web:bridge (\S+) (\S+)$/.exec(data.message ?? "");
      if (!match) return { disposition: "started" };
      // The real child emits the result notify BEFORE the ack (one chunk).
      client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: SESSION_ID, rid: match[1], nonce: NONCE, ...envelope }));
      return { disposition: "handled" };
    });
  };
  if (tools !== undefined || active !== undefined) {
    childAnswers({ ok: true, result: { tools: tools ?? [], active: active ?? [] } });
  } else {
    // A default healthy child: acknowledges and answers an empty result.
    childAnswers({ ok: true, result: { tools: [], active: [] } });
  }
  return { core, client, childAnswers, cleanup, bridgePath };
}

function withDeadline(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what} did not settle in ${ms} ms`)), ms)),
  ]);
}

test("bridgeRequest correlates a reply by requestId and returns the result", async () => {
  const { core, childAnswers, cleanup } = await makeCore();
  try {
    childAnswers({ ok: true, result: { value: 42 } });
    const result = await withDeadline(core.bridgeRequest("tools.list"), 2_000, "reply");
    assert.equal(result.value, 42);
    // The command line carried the nonce and the machine-token grammar only.
    const command = clientSentPrompt(core);
    assert.match(command, /^\/pi-web:bridge pwb-[0-9a-f-]{36} [A-Za-z0-9_-]+$/);
    const payload = decodePayload(command);
    assert.equal(payload.op, "tools.list");
    assert.equal(payload.nonce, NONCE);
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("a request's args cannot retarget the op or replay another nonce", async () => {
  const { core, cleanup } = await makeCore();
  try {
    // The wire payload is built by the host: op and nonce come last.
    await withDeadline(
      core.bridgeRequest("tools.list", { nonce: "spoofed-nonce", op: "tools.apply", names: ["bash"] }),
      2_000,
      "spoofed args",
    );
    const payload = decodePayload(clientSentPrompt(core));
    assert.equal(payload.op, "tools.list");
    assert.equal(payload.nonce, NONCE);
    assert.deepEqual(payload.names, ["bash"], "the op's own arguments still travel");
  } finally {
    core.dispose();
    await cleanup();
  }
});

function clientSentPrompt(core) {
  // The fake client keeps every sent record; find the last bridge prompt.
  // The rpc getter is the core's documented client surface.
  return core.rpc.sent.filter((record) => record.type === "prompt").at(-1).message;
}

function decodePayload(command) {
  const token = command.split(" ")[2];
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
}

test("a normal notify relays to the UI and never resolves a bridge request", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    let relayed = 0;
    core.attachUiRelay({
      relayExternalUiRequest: async () => ({ cancelled: true }),
      relayExternalUiEvent: () => { relayed += 1; },
    });
    // Both are ordinary notifies: one plain message, one JSON body WITHOUT the
    // bridge prefix. Neither may be swallowed — they relay unchanged — and
    // neither resolves a pending request.
    client.notify("Command blocked by user");
    client.notify(JSON.stringify({ sid: SESSION_ID, rid: "pwb-nope", nonce: NONCE, ok: true, result: {} }));
    assert.equal(relayed, 2, "ordinary notifies reached the relay, none swallowed");
    // A child that never answers: the request must time out on its own timer,
    // never resolved by the earlier notifies.
    client.handlers.set("prompt", () => ({ disposition: "handled" }));
    const request = core.bridgeRequest("tools.list", undefined, 100);
    await assert.rejects(request, /did not answer/, "no notify was mistaken for the reply");
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("a reply with the wrong nonce or session id rejects its request", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    client.handlers.set("prompt", (data) => {
      const match = /^\/pi-web:bridge (\S+) /.exec(data.message ?? "");
      client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: SESSION_ID, rid: match[1], nonce: "other-nonce", ok: true, result: 1 }));
      return { disposition: "handled" };
    });
    await assert.rejects(core.bridgeRequest("tools.list"), /wrong session nonce/);

    client.handlers.set("prompt", (data) => {
      const match = /^\/pi-web:bridge (\S+) /.exec(data.message ?? "");
      client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: "another-session", rid: match[1], nonce: NONCE, ok: true, result: 1 }));
      return { disposition: "handled" };
    });
    await assert.rejects(core.bridgeRequest("tools.list"), /answered for session/);
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("a malformed envelope (null, array, unparseable, unknown rid) never throws or resolves", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    client.handlers.set("prompt", () => ({ disposition: "handled" }));
    // None of these may throw out of the notify handler.
    client.notify(BRIDGE_PREFIX + "null");
    client.notify(BRIDGE_PREFIX + "[1,2,3]");
    client.notify(BRIDGE_PREFIX + "{not json");
    client.notify(BRIDGE_PREFIX + JSON.stringify({ rid: 123, ok: true }));
    client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: SESSION_ID, rid: "unknown-rid", nonce: NONCE, ok: true }));
    // A pending request is unaffected by the garbage and times out cleanly.
    await assert.rejects(
      core.bridgeRequest("tools.list", undefined, 100),
      /did not answer within 100 ms/,
    );
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("an ok:false reply propagates the child's error message", async () => {
  const { core, childAnswers, cleanup } = await makeCore();
  try {
    childAnswers({ ok: false, error: "the session is running; wait for it to finish before changing tools" });
    await assert.rejects(
      core.bridgeRequest("tools.set", { names: ["read"] }),
      /the session is running/,
    );
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("no reply within the timeout rejects with a diagnosable error", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    client.handlers.set("prompt", () => ({ disposition: "handled" }));
    await assert.rejects(
      core.bridgeRequest("tools.list", undefined, 120),
      /did not answer within 120 ms/,
    );
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("child exit during a bridge request rejects immediately (same chunk as the ack)", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    // The exit arrives while the prompt command is still in flight.
    client.handlers.set("prompt", () => new Promise(() => {
      // Never acks: the child died first.
      client.exit(1);
    }));
    await assert.rejects(
      withDeadline(core.bridgeRequest("tools.list"), 2_000, "exit rejection"),
      /pi process exited during bridge 'tools.list' \(code 1\)/,
    );
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("a reply that arrives before a FAILED ack still completes the request", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    client.handlers.set("prompt", (data) => {
      const match = /^\/pi-web:bridge (\S+) /.exec(data.message ?? "");
      client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: SESSION_ID, rid: match[1], nonce: NONCE, ok: true, result: { done: true } }));
      // The ack breaks after the result was delivered.
      throw new Error("ack transport exploded");
    });
    const result = await withDeadline(core.bridgeRequest("tools.list"), 2_000, "reply-despite-ack-failure");
    assert.deepEqual(result, { done: true });
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("a reply that arrives AFTER the ack still completes the request", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    client.handlers.set("prompt", (data) => {
      const match = /^\/pi-web:bridge (\S+) /.exec(data.message ?? "");
      // The ack wins the race; the child's result follows on a later tick.
      setTimeout(() => {
        client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: SESSION_ID, rid: match[1], nonce: NONCE, ok: true, result: { late: true } }));
      }, 20);
      return { disposition: "handled" };
    });
    const result = await withDeadline(core.bridgeRequest("tools.list"), 2_000, "reply-after-ack");
    assert.deepEqual(result, { late: true });
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("a failed ack without a reply surfaces the ack error, not a timeout", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    client.handlers.set("prompt", () => Promise.reject(new Error("prompt channel died")));
    await assert.rejects(
      core.bridgeRequest("tools.list", undefined, 5_000),
      /prompt channel died/,
    );
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("a disposition other than handled refuses to guess the result", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    client.handlers.set("prompt", () => ({ disposition: "started" }));
    await assert.rejects(
      core.bridgeRequest("tools.list", undefined, 5_000),
      /did not treat the message as an extension command/,
    );
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("concurrent requests correlate to their own replies", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    const deferred = new Map();
    client.handlers.set("prompt", (data) => {
      const match = /^\/pi-web:bridge (\S+) /.exec(data.message ?? "");
      return new Promise((resolve) => { deferred.set(match[1], resolve); });
    });
    const first = core.bridgeRequest("tools.list");
    const second = core.bridgeRequest("tools.set", { names: ["read"] });
    // Let both command handlers register their deferred acks (microtasks).
    await new Promise((resolve) => setImmediate(resolve));
    // Answer the second FIRST, out of order.
    for (const record of [...client.sent].reverse()) {
      const match = /^\/pi-web:bridge (\S+) /.exec(record.message ?? "");
      if (!match || !deferred.has(match[1])) continue;
      client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: SESSION_ID, rid: match[1], nonce: NONCE, ok: true, result: { which: match[1] } }));
      deferred.get(match[1])({ disposition: "handled" });
      deferred.delete(match[1]);
      if (deferred.size === 0) break;
    }
    assert.equal(deferred.size, 0, "both requests were answered");
    const [a, b] = await Promise.all([first, second]);
    assert.notEqual(a.which, b.which);
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("dispose rejects pending requests immediately instead of waiting for the timer", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    client.handlers.set("prompt", () => ({ disposition: "handled" }));
    const request = core.bridgeRequest("tools.list", undefined, 30_000);
    core.dispose();
    await assert.rejects(
      withDeadline(request, 1_000, "dispose rejection"),
      /cancelled: the session is being disposed/,
    );
  } finally {
    await cleanup();
  }
});

test("dispose rejects a request whose prompt ack NEVER arrives", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    // The child neither acks nor answers: only the result channel can settle.
    client.ackCapMs = 10_000;
    client.handlers.set("prompt", () => new Promise(() => {}));
    const request = core.bridgeRequest("tools.list", undefined, 30_000);
    await new Promise((resolve) => setImmediate(resolve));
    core.dispose();
    // Not the 40s ack deadline: dispose settles the request at once.
    await assert.rejects(
      withDeadline(request, 1_000, "dispose without an ack"),
      /cancelled: the session is being disposed/,
    );
  } finally {
    await cleanup();
  }
});

test("the request timeout rejects without waiting for a missing ack", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    // The ack would only fail after 10s; the 100ms result timer must decide.
    client.ackCapMs = 10_000;
    client.handlers.set("prompt", () => new Promise(() => {}));
    await assert.rejects(
      withDeadline(core.bridgeRequest("tools.list", undefined, 100), 1_500, "timeout without an ack"),
      /did not answer within 100 ms/,
    );
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("a signal aborted before the call rejects without sending anything to the child", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    const sent = client.sent.filter((record) => record.type === "prompt").length;
    const controller = new AbortController();
    controller.abort(new Error("session closed"));
    await assert.rejects(
      () => core.bridgeRequest("subagents.status", undefined, undefined, controller.signal),
      /session closed/,
    );
    assert.equal(
      client.sent.filter((record) => record.type === "prompt").length,
      sent,
      "an aborted caller writes nothing to the child",
    );
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("aborting mid-flight rejects at once, and the late reply is dropped, not resolved", async () => {
  const { core, client, cleanup } = await makeCore({ bridgeTimeoutMs: 60_000 });
  try {
    let replyWith;
    client.handlers.set("prompt", (data) => {
      const match = /^\/pi-web:bridge (\S+) (\S+)$/.exec(data.message ?? "");
      if (!match) return { disposition: "started" };
      // Hold the reply: the abort lands while the child is still working.
      replyWith = match[1];
      return { disposition: "handled" };
    });
    const controller = new AbortController();
    const pending = core.bridgeRequest("subagents.stop", undefined, undefined, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(() => withDeadline(pending, 1_000, "abort rejection"), /AbortError|cancelled/);
    // The child's late result notify finds no pending entry and is dropped.
    client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: SESSION_ID, rid: replyWith, nonce: NONCE, ok: true, result: { success: true } }));
    await new Promise((resolve) => setImmediate(resolve));
    const leaked = core["bridgePending"];
    assert.equal(leaked ? leaked.size : 0, 0, "no pending entry leaks after the abort");
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("createBridgeSubagentTransport forwards the caller's signal to the bridge request", async () => {
  const { createBridgeSubagentTransport } = await jiti.import("../pi-subagents-rpc.ts");
  const seen = [];
  const controller = new AbortController();
  const transport = createBridgeSubagentTransport((method, params, options) => {
    seen.push({ timeoutMs: options?.timeoutMs, signal: options?.signal });
    return Promise.reject(new Error(`unknown bridge op 'subagents.${method}'`));
  });
  // The unsupported-op mapping is incidental; the signal must survive the transport.
  await assert.rejects(
    () => transport.call("status", undefined, { signal: controller.signal }),
    /cannot forward pi-subagents RPC/,
  );
  assert.equal(seen.at(-1).signal, controller.signal, "the transport forwards the AbortSignal");
});

test("a reply resolves the request before a never-arriving ack, and the late ack failure is handled", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    client.ackCapMs = 120;
    client.handlers.set("prompt", (data) => {
      const match = /^\/pi-web:bridge (\S+) /.exec(data.message ?? "");
      client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: SESSION_ID, rid: match[1], nonce: NONCE, ok: true, result: { early: true } }));
      return new Promise(() => {});
    });
    const result = await withDeadline(core.bridgeRequest("tools.list"), 1_000, "reply before a never-ack");
    assert.deepEqual(result, { early: true });
    // The abandoned ack rejects on the fake's own deadline after this test's
    // assertions; an unhandled rejection here would fail the run, so waiting
    // past it is the proof that the loser of the race is handled.
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("an error ack that arrives before the reply rejects with the ack error", async () => {
  const { core, client, cleanup } = await makeCore();
  try {
    client.handlers.set("prompt", () => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("prompt transport broke")), 20);
    }));
    await assert.rejects(
      withDeadline(core.bridgeRequest("tools.list", undefined, 5_000), 2_000, "ack before reply"),
      /prompt transport broke/,
    );
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("refreshTools caches the real list; getAllTools/getActiveToolNames answer it", async () => {
  const tools = [
    { name: "read", description: "Read a file", exposure: "direct", parameters: { type: "object" } },
    { name: "mcp__srv__fetch", description: "Fetch", exposure: "direct", annotations: { readOnlyHint: true } },
    { name: "codemode", description: "Scripts", exposure: "codemode" },
  ];
  const { core, cleanup } = await makeCore({ tools, active: ["read", "mcp__srv__fetch", "codemode"] });
  try {
    await withDeadline(core.refreshTools(), 2_000, "refreshTools");
    assert.equal(core.supportsLiveToolSwitch(), true);
    const listed = core.getAllTools();
    assert.deepEqual(listed.map((tool) => tool.name), ["read", "mcp__srv__fetch", "codemode"]);
    assert.equal(listed[0].description, "Read a file");
    assert.deepEqual(listed[0].parameters, { type: "object" });
    assert.equal(listed[2].exposure, "codemode");
    assert.deepEqual(core.getActiveToolNames(), ["read", "mcp__srv__fetch", "codemode"]);
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("setActiveToolsByName confirms the new active set from the child's reply", async () => {
  const { core, cleanup } = await makeCore({ tools: [], active: ["read", "bash"] });
  try {
    await withDeadline(core.refreshTools(), 2_000, "refreshTools");
    const client = core.rpc;
    // The child applies and answers with the confirmed set.
    client.handlers.set("prompt", (data) => {
      const match = /^\/pi-web:bridge (\S+) (\S+)$/.exec(data.message ?? "");
      const payload = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
      assert.equal(payload.op, "tools.set");
      assert.deepEqual(payload.names, ["read", "grep"]);
      client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: SESSION_ID, rid: match[1], nonce: NONCE, ok: true, result: { active: ["read"] } }));
      return { disposition: "handled" };
    });
    await withDeadline(core.setActiveToolsByName(["read", "grep"]), 2_000, "setActiveToolsByName");
    assert.deepEqual(core.getActiveToolNames(), ["read"]);
    // A switch whose reply carries no active list is a protocol failure.
    client.handlers.set("prompt", (data) => {
      const match = /^\/pi-web:bridge (\S+) /.exec(data.message ?? "");
      client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: SESSION_ID, rid: match[1], nonce: NONCE, ok: true, result: {} }));
      return { disposition: "handled" };
    });
    await assert.rejects(core.setActiveToolsByName(["read"]), /did not confirm with an active tool list/);
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("the pin capability follows the child's life, not the switching policy", async () => {
  const { core, client, cleanup } = await makeCore({ tools: [], active: ["read"] });
  try {
    await withDeadline(core.refreshTools(), 2_000, "refreshTools");
    // A chat-only session is the real case: no live switching, but the child
    // still owns its session file and must append the pin itself.
    assert.equal(core.canPersistToolPinLive(), true);
    client.exit(0);
    assert.equal(core.canPersistToolPinLive(), false, "a dead child cannot be the pin's writer");
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("a tools.list protocol failure is explicit: no static fallback, every read fails", async () => {
  const { core, client, cleanup } = await makeCore({ bridgeTimeoutMs: 150 });
  try {
    client.handlers.set("prompt", () => ({ disposition: "handled" })); // no reply ever
    await assert.rejects(core.refreshTools(), /did not answer/);
    assert.equal(core.supportsLiveToolSwitch(), false);
    assert.throws(() => core.getAllTools(), /pi-web bridge tool listing failed/);
    await assert.rejects(core.setActiveToolsByName(["read"]), /restart the session/);
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("an older bridge asset (no bridge command) degrades explicitly, not silently", async () => {
  const { core, cleanup } = await makeCore({ bridgeCommands: ["pi-web:navigate", "pi-web:reload"], childExitTimeoutMs: 100 });
  try {
    await withDeadline(core.refreshTools(), 2_000, "refreshTools");
    assert.equal(core.supportsLiveToolSwitch(), false);
    // The spawn-time universe stands — the honest answer for a child with no
    // tool query — and switching reports the restart requirement.
    assert.equal(core.canPersistToolPinLive(), false, "no tool operations means the host writes the pin after exit");
    assert.deepEqual(core.getAllTools().map((tool) => tool.name), KNOWN_TOOLS);
    await assert.rejects(core.setActiveToolsByName(["read"]), /restart the session/);
    // The pin is never appended beside a live child: the host waits for the
    // exit the restart path performs, then gives up loudly.
    await assert.rejects(
      core.persistToolSelection(["read"]),
      /the pi child is still running after 100 ms; refusing to append the tool pin beside a live session writer/,
    );
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("a degraded pin is appended by the host once the child exited", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "pi-web-bridge-pin-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  // The file (header included) exists on disk before the core opens it, the
  // same precondition the factory gives the child.
  const sessionFile = ensureSessionFile(manager);
  const { core, client, cleanup } = await makeCore({
    bridgeCommands: ["pi-web:navigate", "pi-web:reload"],
    sessionFile,
    sessionDir,
  });
  try {
    await withDeadline(core.refreshTools(), 2_000, "refreshTools");
    client.exit(0);
    await withDeadline(core.persistToolSelection(["read", "grep"]), 2_000, "degraded pin write");
    const { readSessionToolSelection } = await jiti.import("../session-tool-selection.ts");
    assert.deepEqual(
      readSessionToolSelection(SessionManager.open(sessionFile, sessionDir).getEntries()),
      ["read", "grep"],
    );
  } finally {
    core.dispose();
    await cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("a same-named bridge command from ANOTHER extension is not the bridge", async () => {
  const sandbox = join(tmpdir(), `pi-web-bridge-proto-${Date.now()}-${sandboxCounter++}`);
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(sandbox, { recursive: true });
  const shippedPath = join(sandbox, "pi-web-bridge.mjs");
  writeFileSync(shippedPath, "// shipped\n");
  const strangerPath = join(sandbox, "stranger.mjs");
  writeFileSync(strangerPath, "// another extension\n");
  const client = new FakeRpcClient(shippedPath);
  client.handlers.set("get_commands", () => ({
    commands: [
      { name: "pi-web:bridge", source: "extension", sourceInfo: { path: strangerPath } },
      { name: "pi-web:navigate", source: "extension", sourceInfo: { path: shippedPath } },
    ],
  }));
  const core = new CliAgentSessionCore({
    client,
    initialState: {
      sessionId: SESSION_ID, isStreaming: false, isCompacting: false, isIdle: true,
      autoCompactionEnabled: true, autoRetryEnabled: true, retryAttempt: 0,
      messageCount: 0, pendingMessageCount: 0, steeringQueue: [], followUpQueue: [],
    },
    sessionFile: join(sandbox, "session.jsonl"),
    cwd: sandbox,
    knownToolNames: KNOWN_TOOLS,
    bridgeExtensionPath: shippedPath,
    bridgeNonce: NONCE,
    agentDir: sandbox,
    onLog: () => {},
  });
  try {
    await core.refreshCommands();
    assert.equal(core.hasBridgeCommand("pi-web:bridge"), false, "the stranger's same-named command is not trusted");
    assert.equal(core.hasBridgeCommand("pi-web:navigate"), true, "the shipped asset's command is");
    await assert.rejects(
      core.bridgeRequest("tools.list"),
      /bridge command is not registered/,
    );
  } finally {
    core.dispose();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("persistToolSelection routes the pin through the live child", async () => {
  const { core, cleanup } = await makeCore({ tools: [], active: ["read"] });
  try {
    await withDeadline(core.refreshTools(), 2_000, "refreshTools");
    const client = core.rpc;
    client.handlers.set("prompt", (data) => {
      const match = /^\/pi-web:bridge (\S+) (\S+)$/.exec(data.message ?? "");
      const payload = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
      assert.equal(payload.op, "tools.pin");
      assert.deepEqual(payload.tools, ["read", "grep"]);
      client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: SESSION_ID, rid: match[1], nonce: NONCE, ok: true, result: { pinned: "pinned" } }));
      return { disposition: "handled" };
    });
    await withDeadline(core.persistToolSelection(["read", "grep"]), 2_000, "persistToolSelection");
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("applyToolSelection runs the atomic tools.apply transaction", async () => {
  const { core, cleanup } = await makeCore({ tools: [], active: ["read", "bash"] });
  try {
    await withDeadline(core.refreshTools(), 2_000, "refreshTools");
    const client = core.rpc;
    client.handlers.set("prompt", (data) => {
      const match = /^\/pi-web:bridge (\S+) (\S+)$/.exec(data.message ?? "");
      const payload = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
      assert.equal(payload.op, "tools.apply");
      assert.deepEqual(payload.names, ["read", "grep"]);
      assert.deepEqual(payload.pin, { tools: ["read", "grep"] });
      client.notify(BRIDGE_PREFIX + JSON.stringify({ sid: SESSION_ID, rid: match[1], nonce: NONCE, ok: true, result: { active: ["read", "grep"], pinned: "pinned" } }));
      return { disposition: "handled" };
    });
    await withDeadline(core.applyToolSelection(["read", "grep"], ["read", "grep"]), 2_000, "applyToolSelection");
    assert.deepEqual(core.getActiveToolNames(), ["read", "grep"]);
  } finally {
    core.dispose();
    await cleanup();
  }
});

test("a refused op's machine-readable code reaches the caller on BridgeOpError", async () => {
  // The route maps a package refusal (not_found, unsupported_method, …) onto
  // an HTTP status through the error's `code`; dropping it here would turn
  // every refusal into a generic 500.
  const { core, childAnswers, cleanup } = await makeCore();
  try {
    childAnswers({ ok: false, code: "subagents.unresponsive", error: "no answer from the package" });
    const error = await core.bridgeRequest("subagents.status", { params: {} }).then(
      () => assert.fail("a refused op must reject"),
      (thrown) => thrown,
    );
    assert.equal(error.name, "BridgeOpError");
    assert.equal(error.code, "subagents.unresponsive");
    assert.match(error.message, /no answer from the package/);

    // An answer without a code still rejects, with no invented code.
    childAnswers({ ok: false, error: "plain failure" });
    const plain = await core.bridgeRequest("tools.list").then(
      () => assert.fail("a refused op must reject"),
      (thrown) => thrown,
    );
    assert.equal(plain.name, "BridgeOpError");
    assert.equal(plain.code, undefined);
  } finally {
    core.dispose();
    await cleanup();
  }
});
