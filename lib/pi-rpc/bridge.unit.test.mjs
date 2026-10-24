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

function makeHarness({ tools = [], entries = [] } = {}) {
  const handlers = new Map();
  const pi = {
    registerCommand: (name, definition) => handlers.set(name, definition),
    on: (event, handler) => handlers.set(`on:${event}`, handler),
    getAllTools: () => tools,
  };
  bridge(pi);
  const call = (event, payload, ctx = { sessionManager: { getEntries: () => entries } }) =>
    handlers.get(`on:${event}`)(payload, ctx);
  return { handlers, call };
}

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
  const { call } = makeHarness();
  const sections = {};
  const event = { systemPromptOptions: { sections } };

  // No settings file (default agent dir in the test env): default-on.
  call("before_agent_start", event);
  assert.match(String(sections.artifacts ?? ""), /:::artifact/);

  const off = { ...event, systemPromptOptions: { sections: {} } };
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-bridge-agent-"));
  mkdirSync(join(agentDir, "pi-web"), { recursive: true });
  writeFileSync(join(agentDir, "pi-web", "settings.json"), JSON.stringify({ artifactsPrompt: false }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    call("before_agent_start", off);
    assert.equal("artifacts" in off.systemPromptOptions.sections, false, "the section is removed when the switch is off");
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    const { rmSync } = await import("node:fs");
    rmSync(agentDir, { recursive: true, force: true });
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
  const result = await navigate.handler("abc123 --summarize --instructions keep it short", ctx);
  assert.equal(result, "navigated");
  assert.equal(navigated.id, "abc123");
  assert.equal(navigated.options.summarize, true);
  assert.equal(navigated.options.customInstructions, "keep it short");
});
