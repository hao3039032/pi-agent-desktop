import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cleanupDir, resolvePiCliBin } from "./test-utils.mjs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

const faux = fauxProvider({ provider: "faux" });
const fauxDefaultModel = faux.models[0].id;
faux.setResponses([fauxAssistantMessage("LOCAL-OK"), fauxAssistantMessage("LOCAL-STILL-OK")]);
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { startRpcSession } = await jiti.import("../rpc-manager.ts");
const { createSideSession } = await jiti.import("../session-fork.ts");
const { buildSideChatToolArgs } = await jiti.import("./factory.ts");
const { sideToolNames } = await jiti.import("../side-session.ts");
const executable = resolvePiCliBin();

function waitFor(predicate, what, timeoutMs = 20_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        if (predicate()) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timeout waiting for ${what}`));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, 100);
    timer.unref?.();
  });
}

/** Real manager -> production startRpcSession -> CLI factory -> real wrapper. */
async function parentWithTranscript(cwd, sessionDir) {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage({
    role: "system", content: "parent",
    toolsAdded: ["read", "bash", "edit", "write", "ext_tool", "mcp__radius__write", "codemode", "tool_search", "Agent"].map((name) => ({ name, description: name, parameters: {} })),
    timestamp: Date.now(),
  });
  manager.appendMessage({ role: "user", content: "detour", timestamp: Date.now() });
  return { path: manager.getSessionFile() };
}

async function toolState(wrapper) {
  const tools = await wrapper.send({ type: "get_tools" });
  return {
    names: tools.map((tool) => tool.name),
    active: tools.filter((tool) => tool.active).map((tool) => tool.name),
  };
}

test("side chat spawn uses a closed plain-name allow-list, never the relative normal-project syntax", () => {
  const args = buildSideChatToolArgs(["read", "grep", "find", "ls"]);
  assert.deepEqual(args, ["--tools", "read,grep,find,ls"]);
  assert.ok(!args[1].includes("+") && !args[1].includes("-"));
  // An empty pin is explicitly closed, not the default or full coding domain.
  assert.deepEqual(buildSideChatToolArgs([]), ["--tools", ""]);
  // Normal project sessions continue through buildToolArgs (+/-), not this.
});

test("real CLI: side chat names its first prompt, stays quiet and closes extension/MCP/subagent tools", { skip: executable ? false : "PI_CLI_BIN not set" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-side-cli-"));
  const agentDir = join(root, "agent"), cwd = join(root, "work"), sessionDir = join(root, "sessions");
  await mkdir(agentDir, { recursive: true }); await mkdir(cwd); await mkdir(sessionDir);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: faux.provider.id, defaultModel: fauxDefaultModel }));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let wrapper;
  try {
    // A non-direct MCP tool must also be unreachable from a script; --tools
    // alone does not gate codemode access, --no-mcp is required.
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { radius: { url: "http://127.0.0.1:9", exposure: "codemode" } } }));
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "extra-tool.js"), `import { fauxAssistantMessage, fauxProvider } from "${process.cwd().replaceAll("\\", "/")}/node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
export default async function (pi) {
  const faux = fauxProvider({ provider: "faux" });
  faux.setResponses([fauxAssistantMessage("LOCAL-OK"), fauxAssistantMessage("LOCAL-STILL-OK")]);
  pi.registerTool({ name: "ext_tool", label: "extra", description: "extra", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "must not run" }], details: {} }) });
  pi.registerProvider(faux.provider);
}
`);
    const parent = await parentWithTranscript(cwd, sessionDir);
    const side = createSideSession(parent.path);
    const started = await startRpcSession(side.sessionId, side.path, undefined);
    wrapper = started.session;

    const first = await toolState(wrapper);
    assert.deepEqual(first.names, ["read", "bash"]);
    assert.deepEqual(first.active, ["read", "bash"]);
    const model = (await wrapper.send({ type: "get_state" })).model;
    assert.deepEqual(model, { provider: faux.provider.id, id: fauxDefaultModel });

    const settled = [];
    const off = wrapper.onEvent((event) => settled.push(event.type));
    t.after(off);
    await wrapper.send({ type: "prompt", message: "Reply with exactly: SIDE-NAME-OK" });
    await waitFor(() => SessionManager.open(side.path, sessionDir).getSessionName() === "Reply with exactly: SIDE-NAME-OK", "the first prompt name landed on disk");
    assert.equal(wrapper.hasSuppressedCompletionNotifications(), true);
    await waitFor(() => settled.filter((type) => type === "agent_settled").length >= 1, "the first handled command to settle");

    await wrapper.send({ type: "prompt", message: "Do not rename this session; reply with exactly: SIDE-STILL-OK" });
    assert.equal(SessionManager.open(side.path, sessionDir).getSessionName(), "Reply with exactly: SIDE-NAME-OK");
    await waitFor(() => settled.filter((type) => type === "agent_settled").length >= 2, "the second handled command to settle");

    // set_tools is refused by metadata, and a live reload cannot re-activate
    // the extension tool or indirect MCP/codemode reachability.
    await assert.rejects(wrapper.send({ type: "set_tools", toolNames: ["read", "edit", "ext_tool"] }), /fixed when it is forked/);
    await wrapper.send({ type: "reload" });
    assert.deepEqual(await toolState(wrapper), first);
    const firstUser = SessionManager.open(side.path, sessionDir).getEntries().find((entry) => entry.type === "message" && entry.message?.role === "user");
    const nav = await wrapper.send({ type: "navigate_tree", targetId: firstUser.id });
    assert.equal(nav.cancelled, false);
    assert.deepEqual(await toolState(wrapper), first);
    await wrapper.shutdown();

    // Reopening must recompute the same closed spawn set, not restore the
    // parent's or any later extension loadout.
    const resumed = await startRpcSession(side.sessionId, side.path, undefined);
    try { assert.deepEqual(await toolState(resumed.session), first); }
    finally { await resumed.session.shutdown(); }
  } finally {
    if (wrapper?.isAlive()) await wrapper.shutdown();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await cleanupDir(root);
  }
});

test("real CLI: read-only and Chat-only side chats stay within the parent's pin", { skip: executable ? false : "PI_CLI_BIN not set" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-side-pin-"));
  const cwd = join(root, "work"), sessionDir = join(root, "sessions");
  await mkdir(cwd, { recursive: true }); await mkdir(sessionDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  await mkdir(join(root, "agent"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const parent = await parentWithTranscript(cwd, sessionDir);
    const { appendSessionToolSelection } = await jiti.import("../session-tool-selection.ts");
    const manager = SessionManager.open(parent.path, sessionDir);
    appendSessionToolSelection(manager, ["read", "grep", "find", "ls"]);
    const side = createSideSession(parent.path);
    const started = await startRpcSession(side.sessionId, side.path, undefined);
    try {
      const state = await toolState(started.session);
      assert.deepEqual(state.names, ["read", "grep", "find", "ls"]);
      assert.equal(started.session.isChatOnly(), false);
      await assert.rejects(started.session.send({ type: "set_tools", toolNames: ["read", "bash"] }), /fixed when it is forked/);
    } finally { await started.session.shutdown(); }

    const chatManager = SessionManager.create(cwd, sessionDir);
    chatManager.appendMessage({ role: "user", content: "chat", timestamp: Date.now() });
    appendSessionToolSelection(chatManager, []);
    const chatSide = createSideSession(chatManager.getSessionFile());
    const chat = await startRpcSession(chatSide.sessionId, chatSide.path, undefined);
    try {
      assert.equal(chat.session.isChatOnly(), true);
      assert.deepEqual(await toolState(chat.session), { names: [], active: [] });
    } finally { await chat.session.shutdown(); }

    // An explicitly empty parent pin is distinct from Chat only: it takes the
    // side allow-list branch with --tools "" (not --no-tools), and stays closed.
    const emptyManager = SessionManager.create(cwd, sessionDir);
    emptyManager.appendMessage({ role: "user", content: "empty", timestamp: Date.now() });
    appendSessionToolSelection(emptyManager, ["edit", "write"]);
    assert.deepEqual(sideToolNames(["edit", "write"], []), []);
    const emptySide = createSideSession(emptyManager.getSessionFile());
    const empty = await startRpcSession(emptySide.sessionId, emptySide.path, undefined);
    try {
      assert.equal(empty.session.isChatOnly(), false);
      assert.deepEqual(await toolState(empty.session), { names: [], active: [] });
    } finally { await empty.session.shutdown(); }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await cleanupDir(root);
  }
});
