/**
 * Unit tests for the chat policy asset (lib/pi-rpc/assets/pi-web-chat.mjs) —
 * plain JS, no pi binary: folder confinement, shell blocks, legacy read
 * scoping and the selectedTools filter, driven against a scripted `pi`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const chatModule = await jiti.import("./assets/pi-web-chat.mjs");
const chat = chatModule.default ?? chatModule;

function makeHarness({ mode = "folder", files = "1", tools = [], entries = [] } = {}) {
  const previousMode = process.env.PI_WEB_CHAT_MODE;
  const previousFiles = process.env.PI_WEB_CHAT_FILES;
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_WEB_CHAT_MODE = mode;
  if (files) process.env.PI_WEB_CHAT_FILES = files;
  else delete process.env.PI_WEB_CHAT_FILES;
  // No pi-web settings file: defaults (no extra tools, no instructions).
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-chat-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const handlers = new Map();
  const registered = [];
  const pi = {
    on: (event, handler) => handlers.set(`on:${event}`, handler),
    registerTool: (tool) => registered.push(tool),
    getAllTools: () => tools,
  };
  try {
    chat(pi);
  } finally {
    if (previousMode === undefined) delete process.env.PI_WEB_CHAT_MODE;
    else process.env.PI_WEB_CHAT_MODE = previousMode;
    if (previousFiles === undefined) delete process.env.PI_WEB_CHAT_FILES;
    else process.env.PI_WEB_CHAT_FILES = previousFiles;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    // keep agentDir for the test body; cleaned by the caller
  }
  const workdir = process.cwd();
  const call = (event, payload, ctx = { sessionManager: { getEntries: () => entries } }) =>
    handlers.get(`on:${event}`)(payload, ctx);
  return { handlers, call, registered, agentDir, workdir };
}

const bashTool = { name: "bash", sourceInfo: {} };
const readTool = { name: "read", sourceInfo: {} };
const writeTool = { name: "write", sourceInfo: {} };
const mcpWrite = { name: "mcp__s__put", sourceInfo: { path: "builtin:mcp" }, annotations: {} };
const mcpRead = { name: "mcp__s__get", sourceInfo: { path: "builtin:mcp" }, annotations: { readOnlyHint: true } };

test("folder chat: file tools stay inside the chat folder", () => {
  const folder = mkdtempSync(join(tmpdir(), "pi-web-chat-folder-"));
  const previousCwd = process.cwd();
  process.chdir(folder);
  const agentDirs = [];
  try {
    writeFileSync(join(folder, "inside.txt"), "data", "utf8");
    const h = makeHarness({ mode: "folder", tools: [bashTool, readTool, writeTool, mcpWrite, mcpRead] });
    agentDirs.push(h.agentDir);

    const inside = h.call("tool_call", { toolName: "write", input: { path: "new.txt", content: "x" } });
    assert.equal(inside, undefined, "a relative write into the folder is allowed");

    const outside = h.call("tool_call", { toolName: "write", input: { path: join(folder, "..", "escape.txt") } });
    assert.equal(outside.block, true);
    assert.match(outside.reason, /only works inside this chat's own folder/);

    const shell = h.call("tool_call", { toolName: "bash", input: { command: "echo hi" } });
    assert.equal(shell.block, true);
    assert.match(shell.reason, /chat has no shell/);

    const mcp = h.call("tool_call", { toolName: mcpWrite.name, input: {} });
    assert.equal(mcp.block, true, "a write-capable MCP tool is blocked");
    const mcpOk = h.call("tool_call", { toolName: mcpRead.name, input: {} });
    assert.equal(mcpOk, undefined, "a read-only MCP tool runs");
  } finally {
    process.chdir(previousCwd);
    rmSync(folder, { recursive: true, force: true });
    for (const dir of agentDirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("folder chat: before_agent_start filters the selected tools and sets the date", () => {
  const folder = mkdtempSync(join(tmpdir(), "pi-web-chat-folder-"));
  const previousCwd = process.cwd();
  process.chdir(folder);
  const agentDirs = [];
  try {
    const h = makeHarness({ mode: "folder", tools: [bashTool, readTool, writeTool] });
    agentDirs.push(h.agentDir);
    const sections = {};
    const event = { systemPromptOptions: { sections, selectedTools: ["read", "bash", "write", "unknown_ext"] } };
    h.call("before_agent_start", event, { sessionManager: { getEntries: () => [] } });
    assert.deepEqual(event.systemPromptOptions.selectedTools, ["read", "write"]);
    assert.match(sections.date, /Today's date is/);
    assert.equal(event.systemPromptOptions.cwd, folder);
  } finally {
    process.chdir(previousCwd);
    rmSync(folder, { recursive: true, force: true });
    for (const dir of agentDirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy chat: read is scoped to skills and user-named files", () => {
  const folder = mkdtempSync(join(tmpdir(), "pi-web-chat-legacy-"));
  const previousCwd = process.cwd();
  process.chdir(folder);
  const agentDirs = [];
  try {
    const skillDir = join(folder, "skill");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(skillFile, "# skill", "utf8");
    const skills = [{ filePath: skillFile }];
    // legacy mode: no pi.getSkills on the harness; the handler receives skills
    // from pi.getSkills() — emulate by monkey-patching the harness pi
    const agentDir = mkdtempSync(join(tmpdir(), "pi-web-chat-agent-"));
    agentDirs.push(agentDir);
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_WEB_CHAT_MODE = "legacy";
    process.env.PI_WEB_CHAT_FILES = "1";
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const handlers = new Map();
    const registered = [];
    const pi = {
      on: (event, handler) => handlers.set(`on:${event}`, handler),
      registerTool: (tool) => registered.push(tool),
      getAllTools: () => [readTool, writeTool, bashTool],
      getSkills: () => skills,
    };
    chat(pi);
    process.env.PI_WEB_CHAT_MODE = undefined;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;

    const skillRead = handlers.get("on:tool_call")({ toolName: "read", input: { path: join(skillDir, "ref.md") } }, { sessionManager: { getEntries: () => [] } });
    // Write a file beside the skill so the read exists on disk
    writeFileSync(join(skillDir, "ref.md"), "ref", "utf8");
    const skillRead2 = handlers.get("on:tool_call")({ toolName: "read", input: { path: join(skillDir, "ref.md") } }, { sessionManager: { getEntries: () => [] } });
    assert.equal(skillRead2, undefined, "a file inside a skill folder is readable");

    const secret = join(process.env.USERPROFILE || process.env.HOME, ".ssh", "id_rsa");
    const secretRead = handlers.get("on:tool_call")({ toolName: "read", input: { path: secret } }, { sessionManager: { getEntries: () => [] } });
    assert.equal(secretRead.block, true, "credentials are never readable");
    assert.match(secretRead.reason, /Credentials and keys/);

    const write = handlers.get("on:tool_call")({ toolName: "write", input: { path: "x.txt" } }, { sessionManager: { getEntries: () => [] } });
    assert.equal(write.block, true, "legacy chats never write with the coding write tool");

    // save_to_downloads registered for a files-enabled legacy chat
    assert.ok(registered.some((tool) => tool.name === "save_to_downloads"));
  } finally {
    process.chdir(previousCwd);
    rmSync(folder, { recursive: true, force: true });
    for (const dir of agentDirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("unlocked chat: no tool guards, no downloads tool", () => {
  const h = makeHarness({ mode: "unlocked", tools: [bashTool] });
  try {
    assert.equal(h.handlers.has("on:tool_call"), false, "no tool guard when unlocked");
    assert.equal(h.registered.length, 0, "no save_to_downloads when unlocked");
  } finally {
    rmSync(h.agentDir, { recursive: true, force: true });
  }
});

test("network-exposed chat (PI_WEB_CHAT_FILES unset): no grants, no downloads tool", () => {
  const h = makeHarness({ mode: "legacy", files: "", tools: [readTool] });
  try {
    const folder = h.workdir;
    const blocked = h.call("tool_call", { toolName: "read", input: { path: join(folder, "whatever.txt") } });
    assert.equal(blocked.block, true, "with files disabled, only skills are readable");
    assert.match(blocked.reason, /only read skill files/);
    assert.equal(h.registered.length, 0, "no save_to_downloads without files");
  } finally {
    rmSync(h.agentDir, { recursive: true, force: true });
  }
});
