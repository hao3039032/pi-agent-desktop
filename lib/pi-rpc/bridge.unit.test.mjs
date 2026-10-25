/**
 * Unit tests for the bridge extension asset (lib/pi-rpc/assets/pi-web-bridge.mjs)
 * — plain JS, no pi binary: the policies run against a scripted `pi` object
 * the way the child's extension runtime would drive them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const bridgeModule = await jiti.import("./assets/pi-web-bridge.mjs");
const bridge = bridgeModule.default ?? bridgeModule;

function makeHarness({ tools = [], entries = [], sessionId = "sess-1", nonce = "nonce-1", isIdle = true, events } = {}) {
  const harnessNonce = nonce;
  const handlers = new Map();
  const state = {
    activeTools: [],
    appendedEntries: [],
    notifications: [],
  };
  // An in-process event bus, the shape `pi.events` has: the pi-subagents
  // package listens on this, and the bridge proxies to it.
  const busHandlers = new Map();
  const busEmits = [];
  const eventBus = events ?? {
    on: (channel, handler) => {
      const list = busHandlers.get(channel) ?? [];
      list.push(handler);
      busHandlers.set(channel, list);
      return () => {
        const remaining = (busHandlers.get(channel) ?? []).filter((item) => item !== handler);
        if (remaining.length === 0) busHandlers.delete(channel);
        else busHandlers.set(channel, remaining);
      };
    },
    emit: (channel, data) => {
      busEmits.push({ channel, data });
      for (const handler of [...(busHandlers.get(channel) ?? [])]) handler(data);
    },
  };
  const pi = {
    registerCommand: (name, definition) => handlers.set(name, definition),
    on: (event, handler) => handlers.set(`on:${event}`, handler),
    getAllTools: () => tools,
    getActiveTools: () => [...state.activeTools],
    setActiveTools: (names) => { state.activeTools = [...names]; },
    appendEntry: (customType, data) => { state.appendedEntries.push({ customType, data }); },
    ...(events === null ? {} : { events: eventBus }),
  };
  const previousNonce = process.env.PI_WEB_BRIDGE_NONCE;
  bridge(pi);
  if (previousNonce === undefined) delete process.env.PI_WEB_BRIDGE_NONCE;
  else process.env.PI_WEB_BRIDGE_NONCE = previousNonce;
  const call = (event, payload, ctx = { sessionManager: { getEntries: () => entries } }) =>
    handlers.get(`on:${event}`)(payload, ctx);
  /** Run the bridge command the way the child's prompt dispatcher would. */
  const runBridgeCommand = async (args, { nonce: overrideNonce } = {}) => {
    const nonce = overrideNonce ?? harnessNonce;
    if (nonce === undefined) delete process.env.PI_WEB_BRIDGE_NONCE;
    else process.env.PI_WEB_BRIDGE_NONCE = nonce;
    try {
      const ctx = {
        sessionManager: { getEntries: () => entries, getSessionId: () => sessionId },
        ui: { notify: (message, notifyType) => { state.notifications.push({ message, notifyType }); } },
        isIdle: () => isIdle,
      };
      const handler = handlers.get("pi-web:bridge");
      const returnValue = await handler.handler(args, ctx);
      return { returnValue, notification: state.notifications.at(-1) };
    } finally {
      if (previousNonce === undefined) delete process.env.PI_WEB_BRIDGE_NONCE;
      else process.env.PI_WEB_BRIDGE_NONCE = previousNonce;
    }
  };
  const bridgeEnvelope = () => {
    const last = state.notifications.at(-1);
    if (!last || !last.message.startsWith("PI_WEB_BRIDGE_V1 ")) return undefined;
    return JSON.parse(last.message.slice("PI_WEB_BRIDGE_V1 ".length));
  };
  return { handlers, call, pi, state, runBridgeCommand, bridgeEnvelope, busHandlers, busEmits };
}

const bridgePayloadToken = (payload) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

const mcpWriteTool = { name: "mcp__server__write_file", sourceInfo: { path: "builtin:mcp" }, annotations: {} };
const mcpReadTool = { name: "mcp__server__read_file", sourceInfo: { path: "builtin:mcp" }, annotations: { readOnlyHint: true } };
const builtinRead = { name: "read", sourceInfo: {} };

test("read-only MCP policy blocks write-capable MCP tools under a read-only pin", () => {
  const readOnlyEntries = [{ type: "custom", customType: "pi-web:tool-selection", data: { version: 1, tools: ["read", "grep"] } }];
  const { call } = makeHarness({ tools: [mcpWriteTool, mcpReadTool, builtinRead], entries: readOnlyEntries });

  const blocked = call("tool_call", { toolName: mcpWriteTool.name });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /read-only tool selection/);

  const allowed = call("tool_call", { toolName: mcpReadTool.name });
  assert.equal(allowed, undefined);

  const builtin = call("tool_call", { toolName: "read" });
  assert.equal(builtin, undefined);
});

test("read-only MCP policy stands down without a pin and after a cleared pin", () => {
  const noPin = makeHarness({ tools: [mcpWriteTool], entries: [] });
  assert.equal(noPin.call("tool_call", { toolName: mcpWriteTool.name }), undefined);

  const clearedPin = makeHarness({
    tools: [mcpWriteTool],
    entries: [
      { type: "custom", customType: "pi-web:tool-selection", data: { version: 1, tools: ["read"] } },
      { type: "custom", customType: "pi-web:tool-selection", data: { version: 1, cleared: true } },
    ],
  });
  assert.equal(clearedPin.call("tool_call", { toolName: mcpWriteTool.name }), undefined);
});

test("read-only MCP policy ignores a pin that names write-capable tools", () => {
  const writablePin = makeHarness({
    tools: [mcpWriteTool],
    entries: [{ type: "custom", customType: "pi-web:tool-selection", data: { version: 1, tools: ["read", "edit"] } }],
  });
  assert.equal(writablePin.call("tool_call", { toolName: mcpWriteTool.name }), undefined);
});

test("artifacts section follows the pi-web settings file", async () => {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  // Sandbox the agent dir for the whole test: a developer machine with
  // artifactsPrompt off would flip the "default-on" half otherwise.
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const sandbox = mkdtempSync(join(tmpdir(), "pi-web-bridge-agentdir-"));
  process.env.PI_CODING_AGENT_DIR = sandbox;
  try {
    const { call } = makeHarness();
    const sections = {};
    const event = { systemPromptOptions: { sections } };

    // No settings file: default-on.
    call("before_agent_start", event);
    assert.match(String(sections.artifacts ?? ""), /:::artifact/);

    const off = { ...event, systemPromptOptions: { sections: {} } };
    mkdirSync(join(sandbox, "pi-web"), { recursive: true });
    writeFileSync(join(sandbox, "pi-web", "settings.json"), JSON.stringify({ artifactsPrompt: false }));
    call("before_agent_start", off);
    assert.equal("artifacts" in off.systemPromptOptions.sections, false, "the section is removed when the switch is off");
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("navigate and reload commands register", async () => {
  const { handlers } = makeHarness();
  assert.ok(handlers.has("pi-web:navigate"));
  assert.ok(handlers.has("pi-web:reload"));
  // The navigate handler parses entry id and flags.
  const navigate = handlers.get("pi-web:navigate");
  let navigated;
  const ctx = { navigateTree: async (id, options) => { navigated = { id, options }; return { cancelled: false }; } };
  const b64 = Buffer.from("keep it --summarize short  with spaces", "utf8").toString("base64");
  const result = await navigate.handler("abc123 --summarize --instructions-b64 " + b64, ctx);
  assert.equal(result, "navigated");
  assert.equal(navigated.id, "abc123");
  assert.equal(navigated.options.summarize, true);
  assert.equal(navigated.options.customInstructions, "keep it --summarize short  with spaces");
});

// --- the pi-web:bridge command (host state request/reply) ------------------

const sampleTools = [
  { name: "read", description: "Read a file", exposure: "direct", sourceInfo: { path: "builtin:read" }, parameters: { type: "object" } },
  { name: "mcp__srv__fetch", description: "Fetch", exposure: "direct", sourceInfo: { path: "builtin:mcp" }, annotations: { readOnlyHint: true } },
  { name: "hidden_helper", description: "Withdrawn", exposure: "hidden", sourceInfo: { path: "builtin:x" } },
];

test("bridge tools.list answers the real list, active set, nonce and session id", async () => {
  const { runBridgeCommand, bridgeEnvelope, state } = makeHarness({ tools: sampleTools });
  state.activeTools = ["read"];

  await runBridgeCommand(`rid-1 ${bridgePayloadToken({ op: "tools.list", nonce: "nonce-1" })}`);

  const envelope = bridgeEnvelope();
  assert.equal(envelope.ok, true);
  assert.equal(envelope.sid, "sess-1");
  assert.equal(envelope.rid, "rid-1");
  assert.equal(envelope.nonce, "nonce-1");
  assert.equal(envelope.result.tools.length, 3);
  assert.deepEqual(envelope.result.tools.map((tool) => tool.name), ["read", "mcp__srv__fetch", "hidden_helper"]);
  // Hidden exposure and annotations survive; functions never serialize.
  assert.equal(envelope.result.tools[2].exposure, "hidden");
  assert.deepEqual(envelope.result.tools[1].annotations, { readOnlyHint: true });
  assert.deepEqual(envelope.result.active, ["read"]);
});

test("bridge rejects a wrong nonce, a malformed requestId and a bad payload without touching state", async () => {
  const { runBridgeCommand, bridgeEnvelope, state } = makeHarness({ tools: sampleTools });

  // Wrong nonce: answered ok:false, no tool state touched.
  await runBridgeCommand(`rid-a ${bridgePayloadToken({ op: "tools.list", nonce: "not-the-nonce" })}`);
  assert.equal(bridgeEnvelope().ok, false);
  assert.match(bridgeEnvelope().error, /nonce/);

  // Unknown op: ok:false with the op named.
  await runBridgeCommand(`rid-b ${bridgePayloadToken({ op: "no.such.op", nonce: "nonce-1" })}`);
  assert.match(bridgeEnvelope().error, /unknown bridge op/);

  // Non-object payload (a JSON array): rejected, not crashed.
  await runBridgeCommand(`rid-c ${bridgePayloadToken(["not", "an", "object"])}`);
  assert.equal(bridgeEnvelope().ok, false);
  assert.match(bridgeEnvelope().error, /JSON object/);

  // Unparseable base64 payload: rejected with a stable message.
  await runBridgeCommand("rid-d !!!not-base64!!!");
  assert.equal(bridgeEnvelope().ok, false);

  // Missing requestId entirely: the reply cannot correlate; the message stays stable.
  await runBridgeCommand(bridgePayloadToken({ op: "tools.list", nonce: "nonce-1" }));
  assert.equal(bridgeEnvelope().ok, false);
  assert.match(bridgeEnvelope().error, /usage/);

  assert.deepEqual(state.appendedEntries, []);
  assert.deepEqual(state.activeTools, []);
});

test("bridge tools.set applies the names and answers with the confirmed active set", async () => {
  const { runBridgeCommand, bridgeEnvelope, state } = makeHarness({ tools: sampleTools });
  state.activeTools = ["read", "mcp__srv__fetch"];

  await runBridgeCommand(`rid-2 ${bridgePayloadToken({ op: "tools.set", nonce: "nonce-1", names: ["read"] })}`);

  assert.equal(bridgeEnvelope().ok, true);
  assert.deepEqual(bridgeEnvelope().result.active, ["read"]);
  assert.deepEqual(state.activeTools, ["read"]);
});

test("bridge tools.set refuses to run while the session is busy", async () => {
  const { runBridgeCommand, bridgeEnvelope, state } = makeHarness({ tools: sampleTools, isIdle: false });
  state.activeTools = ["read"];

  await runBridgeCommand(`rid-3 ${bridgePayloadToken({ op: "tools.set", nonce: "nonce-1", names: ["bash"] })}`);

  assert.equal(bridgeEnvelope().ok, false);
  assert.match(bridgeEnvelope().error, /the session is running/);
  assert.deepEqual(state.activeTools, ["read"], "the loadout is untouched");
});

test("bridge tools.apply sets the loadout and appends the pin in one transaction", async () => {
  const { runBridgeCommand, bridgeEnvelope, state } = makeHarness({ tools: sampleTools });
  state.activeTools = ["read", "mcp__srv__fetch"];

  await runBridgeCommand(`rid-4 ${bridgePayloadToken({
    op: "tools.apply",
    nonce: "nonce-1",
    names: ["read", "mcp__srv__fetch"],
    pin: { tools: ["read"] },
  })}`);

  assert.equal(bridgeEnvelope().ok, true);
  assert.deepEqual(bridgeEnvelope().result.active, ["read", "mcp__srv__fetch"]);
  assert.deepEqual(state.activeTools, ["read", "mcp__srv__fetch"]);
  // The pin entry: pi-web's exact customType and data shape.
  assert.equal(state.appendedEntries.length, 1);
  assert.equal(state.appendedEntries[0].customType, "pi-web:tool-selection");
  assert.deepEqual(state.appendedEntries[0].data, { version: 1, tools: ["read"] });
});

test("bridge tools.apply restores the previous loadout when the pin append fails", async () => {
  const tools = [...sampleTools];
  const { runBridgeCommand, bridgeEnvelope, state } = makeHarness({ tools });
  state.activeTools = ["read"];
  // appendEntry throws only on the pin write (the second call in the op).
  let appendCalls = 0;
  const originalAppend = state.appendedEntries.push.bind(state.appendedEntries);
  state.appendedEntries.push = (...items) => {
    appendCalls += 1;
    if (appendCalls === 1) throw new Error("disk full");
    return originalAppend(...items);
  };

  await runBridgeCommand(`rid-5 ${bridgePayloadToken({
    op: "tools.apply",
    nonce: "nonce-1",
    names: ["bash"],
    pin: { tools: ["bash"] },
  })}`);

  assert.equal(bridgeEnvelope().ok, false);
  assert.match(bridgeEnvelope().error, /persisting the tool pin failed/);
  assert.match(bridgeEnvelope().error, /restored/);
  // The loadout was rolled back to what ran before the transaction.
  assert.deepEqual(state.activeTools, ["read"]);
});

test("bridge tools.apply rejects a pin that names non-built-in tools", async () => {
  const { runBridgeCommand, bridgeEnvelope, state } = makeHarness({ tools: sampleTools });
  state.activeTools = ["read"];

  await runBridgeCommand(`rid-6 ${bridgePayloadToken({
    op: "tools.apply",
    nonce: "nonce-1",
    names: ["read"],
    pin: { tools: ["read", "mcp__srv__fetch"] },
  })}`);

  assert.equal(bridgeEnvelope().ok, false);
  assert.match(bridgeEnvelope().error, /pin/);
  assert.deepEqual(state.appendedEntries, [], "nothing was appended");
  assert.deepEqual(state.activeTools, ["read"], "the loadout is untouched");
});

test("bridge tools.pin appends a pin and a cleared pin in pi-web's format", async () => {
  const { runBridgeCommand, bridgeEnvelope, state } = makeHarness({ tools: sampleTools });

  await runBridgeCommand(`rid-7 ${bridgePayloadToken({ op: "tools.pin", nonce: "nonce-1", tools: ["read", "grep"] })}`);
  assert.equal(bridgeEnvelope().ok, true);
  assert.deepEqual(state.appendedEntries.at(-1), {
    customType: "pi-web:tool-selection",
    data: { version: 1, tools: ["read", "grep"] },
  });

  await runBridgeCommand(`rid-8 ${bridgePayloadToken({ op: "tools.pin", nonce: "nonce-1", cleared: true })}`);
  assert.equal(bridgeEnvelope().ok, true);
  assert.deepEqual(state.appendedEntries.at(-1), {
    customType: "pi-web:tool-selection",
    data: { version: 1, cleared: true },
  });
});

// --- restricted pi-subagents RPC proxy (the child's event bus) -------------
// The package's listener lives in this process; the host reaches it only
// through the bridge. Every case below is a fake bus handler, never the real
// package: the proxy must be provable without pi-subagents installed.

/** Answer the bridge's RPC request the way the package's bridge does. */
function answerSubagentsRpc(busHandlers, replyBuilder) {
  const off = [];
  const handler = (request) => {
    queueMicrotask(() => {
      for (const listener of busHandlers.get(`subagents:rpc:v1:reply:${request.requestId}`) ?? []) {
        listener(replyBuilder(request));
      }
    });
  };
  busHandlers.set("subagents:rpc:v1:request", [...(busHandlers.get("subagents:rpc:v1:request") ?? []), handler]);
  off.push(() => busHandlers.delete("subagents:rpc:v1:request"));
  return () => off.forEach((fn) => fn());
}

const subagentsOp = (method, params, extra = {}) =>
  `rid-${method} ${bridgePayloadToken({ op: `subagents.${method}`, nonce: "nonce-1", ...(params !== undefined ? { params } : {}), ...extra })}`;

test("subagents.ping forwards one v1 request and returns the package's reply body", async () => {
  const harness = makeHarness();
  const { runBridgeCommand, bridgeEnvelope, busHandlers, busEmits } = harness;
  const instance = "pi-subagents-instance";
  answerSubagentsRpc(busHandlers, (request) => ({
    version: 1,
    requestId: request.requestId,
    method: "ping",
    success: true,
    data: { instance, version: 1, methods: ["ping", "status"], capabilities: { status: true } },
  }));

  await runBridgeCommand(subagentsOp("ping"));

  const envelope = bridgeEnvelope();
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.result, { success: true, data: { instance, version: 1, methods: ["ping", "status"], capabilities: { status: true } } });
  // The request went out on the package's documented channel, v1, no params.
  assert.equal(busEmits.length, 1);
  assert.equal(busEmits[0].channel, "subagents:rpc:v1:request");
  assert.equal(busEmits[0].data.version, 1);
  assert.equal(busEmits[0].data.method, "ping");
  assert.equal(busEmits[0].data.params, undefined);
  assert.equal(typeof busEmits[0].data.requestId, "string");
});

test("subagents.status and subagents.steer forward only their documented params", async () => {
  const { runBridgeCommand, bridgeEnvelope, busHandlers, busEmits } = makeHarness();
  answerSubagentsRpc(busHandlers, (request) => ({
    version: 1,
    requestId: request.requestId,
    success: true,
    data: { echoed: request.method, params: request.params },
  }));

  await runBridgeCommand(subagentsOp("status", { id: "run-1", view: "transcript", lines: 40, index: 2 }));
  assert.deepEqual(bridgeEnvelope().result.data.params, { id: "run-1", view: "transcript", lines: 40, index: 2 });

  await runBridgeCommand(subagentsOp("steer", { id: "run-1", message: "keep going", mode: "follow_up" }));
  assert.deepEqual(bridgeEnvelope().result.data.params, { id: "run-1", message: "keep going", mode: "follow_up" });

  await runBridgeCommand(subagentsOp("stop", { id: "run-1", childId: "step:2" }));
  assert.deepEqual(bridgeEnvelope().result.data.params, { id: "run-1", childId: "step:2" });

  await runBridgeCommand(subagentsOp("interrupt", { id: "run-1" }));
  assert.deepEqual(bridgeEnvelope().result.data.params, { id: "run-1" });
  assert.equal(busEmits.length, 4);
});

test("the proxy refuses spawn, resume, manage, cost and unknown methods", async () => {
  const { runBridgeCommand, bridgeEnvelope, busEmits } = makeHarness();

  for (const method of ["spawn", "resume", "manage", "cost", "nope"]) {
    await runBridgeCommand(`rid-x ${bridgePayloadToken({ op: `subagents.${method}`, nonce: "nonce-1" })}`);
    const envelope = bridgeEnvelope();
    assert.equal(envelope.ok, false, `${method} must be refused`);
    assert.match(envelope.error, /unknown pi-subagents RPC method/);
    assert.equal(typeof envelope.code, "string");
  }
  assert.deepEqual(busEmits, [], "nothing reached the package's bus");
});

test("the proxy refuses parameters outside the method's allowlist", async () => {
  const { runBridgeCommand, bridgeEnvelope, busEmits } = makeHarness();

  for (const [method, params] of [
    ["status", { dir: "C:/secret" }],
    ["status", { id: "run-1", path: "x" }],
    ["steer", { id: "run-1", message: "hi", script: "return 1" }],
    ["interrupt", { id: "run-1", message: "hi" }],
    ["ping", { id: "run-1" }],
  ]) {
    await runBridgeCommand(subagentsOp(method, params));
    const envelope = bridgeEnvelope();
    assert.equal(envelope.ok, false, `${method} with ${JSON.stringify(params)} must be refused`);
    assert.equal(envelope.code, "subagents.invalid-params");
  }
  // An id with path separators is not an id.
  await runBridgeCommand(subagentsOp("interrupt", { id: "../../etc/passwd" }));
  assert.equal(bridgeEnvelope().code, "subagents.invalid-params");
  assert.deepEqual(busEmits, []);
});

test("the proxy answers only a well-formed reply for its own request", async () => {
  const { runBridgeCommand, bridgeEnvelope, busHandlers, busEmits } = makeHarness();
  // A foreign requestId, a wrong version and a malformed body must all be ignored.
  busHandlers.set("subagents:rpc:v1:request", [...(busHandlers.get("subagents:rpc:v1:request") ?? []), (request) => {
    const channel = `subagents:rpc:v1:reply:${request.requestId}`;
    queueMicrotask(() => {
      for (const listener of busHandlers.get(channel) ?? []) {
        listener({ version: 1, requestId: "someone-else", success: true, data: { spoofed: true } });
        listener({ version: 2, requestId: request.requestId, success: true, data: { spoofed: true } });
        listener({ version: 1, requestId: request.requestId, success: "yes" });
        listener({ version: 1, requestId: request.requestId, success: true, data: { real: true } });
      }
    });
  }]);

  await runBridgeCommand(subagentsOp("ping", undefined, { timeoutMs: 2_000 }));

  assert.equal(bridgeEnvelope().ok, true);
  assert.deepEqual(bridgeEnvelope().result, { success: true, data: { real: true } });
  assert.equal(busEmits.length, 1);
});

test("a package-side error is forwarded verbatim, with its code", async () => {
  const { runBridgeCommand, bridgeEnvelope, busHandlers } = makeHarness();
  answerSubagentsRpc(busHandlers, (request) => ({
    version: 1,
    requestId: request.requestId,
    method: "status",
    success: false,
    error: { code: "not_found", message: "Async run 'other' was not found." },
  }));

  await runBridgeCommand(subagentsOp("status", { id: "other" }));

  assert.equal(bridgeEnvelope().ok, true, "the transport worked; the package refused the request");
  assert.deepEqual(bridgeEnvelope().result, { success: false, error: { code: "not_found", message: "Async run 'other' was not found." } });
});

test("an unanswered RPC times out with its own code and removes the reply listener", async () => {
  const { runBridgeCommand, bridgeEnvelope, busHandlers, busEmits } = makeHarness();

  await runBridgeCommand(subagentsOp("ping", undefined, { timeoutMs: 250 }));

  const envelope = bridgeEnvelope();
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, "subagents.unresponsive");
  assert.match(envelope.error, /did not answer 'ping' within 250 ms/);
  const replyChannels = [...busHandlers.keys()].filter((channel) => channel.startsWith("subagents:rpc:v1:reply:"));
  assert.deepEqual(replyChannels, [], "the listener is removed when the wait ends");
  // The request itself still went out exactly once.
  assert.equal(busEmits.length, 1);
});

test("the proxy answers while the session is busy (no idle guard)", async () => {
  // The fleet polls status and steers exactly during a run: a busy session must
  // not turn these into 'the session is running' errors.
  const { runBridgeCommand, bridgeEnvelope, busHandlers } = makeHarness({ isIdle: false });
  answerSubagentsRpc(busHandlers, (request) => ({
    version: 1,
    requestId: request.requestId,
    success: true,
    data: { during: "run" },
  }));

  await runBridgeCommand(subagentsOp("status", { id: "run-1" }));

  assert.equal(bridgeEnvelope().ok, true);
  assert.deepEqual(bridgeEnvelope().result.data, { during: "run" });
});

test("a child without an extension event bus says so instead of pretending", async () => {
  const { runBridgeCommand, bridgeEnvelope } = makeHarness({ events: null });

  await runBridgeCommand(subagentsOp("ping"));

  const envelope = bridgeEnvelope();
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, "subagents.no-events");
  assert.match(envelope.error, /no extension event bus/);
});