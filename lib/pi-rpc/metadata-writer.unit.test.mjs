/**
 * Unit tests for the single-writer metadata chain on the CLI engine:
 *
 *   - the scheduled-run marker goes through the bridge's enumerated
 *     `meta.scheduled-run` op, and every failure mode (child refusal, child
 *     exit, silence) rejects — never a silent success;
 *   - the chat unlock entry is host-written only once the child process
 *     REALLY exited (a disposed wrapper is not an exited child);
 *   - FileSessionManagerView exposes no generic appendCustomEntry — the host
 *     can only append the enumerated entry types, after the child is gone.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { CliAgentSessionCore, ensureSessionFile, initialCoreState } = await jiti.import("./core.ts");

const BRIDGE_PREFIX = "PI_WEB_BRIDGE_V1 ";
const SESSION_ID = "metadata-writer";

/**
 * A scripted child: prompts are dispatched like the real extension runtime
 * (the bridge command runs, the result notify comes back), and process exit is
 * under the test's control.
 */
class ScriptedChild {
  constructor({ sessionId = SESSION_ID, nonce = "meta-nonce-1" } = {}) {
    this.sessionId = sessionId;
    this.nonce = nonce;
    this.uiHandlers = new Map();
    this.exits = new Set();
    this.exited = false;
    this.hasExited = false;
    this.prompts = [];
    /** (payload, requestId) => reply envelope, or null for silence. */
    this.replyFor = () => ({ ok: true, result: { entry: "scheduled-run" } });
  }
  onUi(method, handler) {
    this.uiHandlers.set(method, handler);
    return () => this.uiHandlers.delete(method);
  }
  onEvent() { return () => {}; }
  onProcessExit(listener) {
    this.exits.add(listener);
    if (this.exited) listener(0);
    return () => this.exits.delete(listener);
  }
  emitNotify(payload) {
    const handler = this.uiHandlers.get("notify");
    if (handler) handler({ type: "extension_ui_request", id: "n-1", method: "notify", ...payload });
  }
  exit(code = 0) {
    this.exited = true;
    this.hasExited = true;
    for (const listener of [...this.exits]) listener(code);
  }
  async command(type, payload) {
    if (type !== "prompt") {
      if (type === "get_commands") {
        return { commands: [{ name: "pi-web:bridge", source: "extension", sourceInfo: { path: this.bridgePath } }] };
      }
      return Promise.reject(new Error(`scripted child: '${type}' is not scripted`));
    }
    this.prompts.push(payload.message);
    const match = /^\/pi-web:bridge (pwb-[A-Za-z0-9-]+) ([A-Za-z0-9_-]+)$/.exec(payload.message);
    if (match) {
      const requestId = match[1];
      const parsed = JSON.parse(Buffer.from(match[2], "base64url").toString("utf8"));
      const reply = this.replyFor(parsed, requestId);
      if (reply) {
        queueMicrotask(() => this.emitNotify({
          message: BRIDGE_PREFIX + JSON.stringify({
            sid: this.sessionId, rid: requestId, nonce: parsed.nonce, ...reply,
          }),
        }));
      }
    }
    return { disposition: "handled" };
  }
  close() { return Promise.resolve(0); }
  kill() { this.exit(null); }
}

const MARKER = {
  version: 1,
  taskId: "00000000-0000-4000-8000-000000000001",
  runId: "11111111-2222-4333-8444-555555555555",
  taskName: "Daily review",
  trigger: "schedule",
};

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-rpc-metadata-writer-"));
  const cwd = join(root, "work");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const bridgePath = join(root, "pi-web-bridge.mjs");
  await writeFile(bridgePath, "export default () => {};\n", "utf8");
  return { root, cwd, sessionDir, bridgePath };
}

function makeCore(child, root, extra = {}) {
  child.bridgePath = root.bridgePath;
  return new CliAgentSessionCore({
    client: child,
    initialState: initialCoreState({ sessionId: child.sessionId }),
    sessionFile: root.sessionFile,
    cwd: root.cwd,
    knownToolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    bridgeExtensionPath: root.bridgePath,
    bridgeNonce: child.nonce,
    agentDir: root.cwd,
    onLog: () => {},
    ...extra,
  });
}

test("the scheduled-run marker asks the child's writer and only accepts its confirmation", async () => {
  const root = await makeRoot();
  const manager = SessionManager.create(root.cwd, root.sessionDir);
  root.sessionFile = ensureSessionFile(manager);
  const child = new ScriptedChild();
  const core = makeCore(child, root, { bridgeTimeoutMs: 2_000 });
  try {
    await core.refreshCommands();
    await core.appendScheduledRunMarker(MARKER);
    assert.equal(child.prompts.length, 1, "one bridge command");
    assert.match(child.prompts[0], /^\/pi-web:bridge pwb-[A-Za-z0-9-]+ /);
    // The nonce is the host's own; the op cannot be retargeted by the payload.
    const token = child.prompts[0].split(" ")[2];
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    assert.equal(parsed.op, "meta.scheduled-run");
    assert.equal(parsed.nonce, child.nonce);
    assert.deepEqual(
      (({ op, nonce, ...rest }) => rest)(parsed),
      MARKER,
      "the payload carries exactly the marker fields",
    );
  } finally {
    core.dispose();
    await rm(root.root, { recursive: true, force: true });
  }
});

test("a malformed marker payload never reaches the child", async () => {
  const root = await makeRoot();
  const child = new ScriptedChild();
  const core = makeCore(child, root);
  try {
    await core.refreshCommands();
    await assert.rejects(
      core.appendScheduledRunMarker({ ...MARKER, trigger: "cron" }),
      /scheduled-run marker needs/,
    );
    await assert.rejects(core.appendScheduledRunMarker({ ...MARKER, taskId: "not-a-uuid" }), /needs/);
    assert.deepEqual(child.prompts, [], "no command was sent");
  } finally {
    core.dispose();
    await rm(root.root, { recursive: true, force: true });
  }
});

test("a child refusal, a wrong confirmation, silence and child exit all reject", async () => {
  const root = await makeRoot();
  const manager = SessionManager.create(root.cwd, root.sessionDir);
  root.sessionFile = ensureSessionFile(manager);

  const refused = new ScriptedChild();
  refused.replyFor = () => ({ ok: false, error: "the session is running" });
  const coreRefused = makeCore(refused, root, { bridgeTimeoutMs: 2_000 });
  try {
    await coreRefused.refreshCommands();
    await assert.rejects(coreRefused.appendScheduledRunMarker(MARKER), /the session is running/);
  } finally { coreRefused.dispose(); }

  const wrongShape = new ScriptedChild();
  wrongShape.replyFor = () => ({ ok: true, result: { pinned: "pinned" } });
  const coreWrong = makeCore(wrongShape, root, { bridgeTimeoutMs: 2_000 });
  try {
    await coreWrong.refreshCommands();
    await assert.rejects(coreWrong.appendScheduledRunMarker(MARKER), /did not confirm the entry/);
  } finally { coreWrong.dispose(); }

  const silent = new ScriptedChild();
  silent.replyFor = () => null;
  const coreSilent = makeCore(silent, root, { bridgeTimeoutMs: 40 });
  try {
    await coreSilent.refreshCommands();
    await assert.rejects(coreSilent.appendScheduledRunMarker(MARKER), /did not answer within 40 ms/);
  } finally { coreSilent.dispose(); }

  const dying = new ScriptedChild();
  dying.replyFor = () => { queueMicrotask(() => dying.exit(0)); return null; };
  const coreDying = makeCore(dying, root, { bridgeTimeoutMs: 2_000 });
  try {
    await coreDying.refreshCommands();
    await assert.rejects(coreDying.appendScheduledRunMarker(MARKER), /pi process exited during bridge/);
  } finally { coreDying.dispose(); }

  await rm(root.root, { recursive: true, force: true });
});

test("the chat unlock entry is host-written only once the child really exited", async () => {
  const root = await makeRoot();
  const manager = SessionManager.create(root.cwd, root.sessionDir);
  root.sessionFile = ensureSessionFile(manager);
  const child = new ScriptedChild();
  const core = makeCore(child, root);
  try {
    // The child is alive: the write must wait, and a child that never exits
    // within the deadline is refused (a disposed wrapper is not an exit).
    // The engine's wait timer is deliberately unref'd, so hold the loop open
    // for the assertion.
    child.exited = false;
    child.hasExited = false;
    const never = makeCore(new ScriptedChild(), root, { childExitTimeoutMs: 25 });
    const holdOpen = setTimeout(() => {}, 5_000);
    try {
      await assert.rejects(never.appendChatUnlockAfterExit(true), /still running after 25 ms/);
    } finally {
      clearTimeout(holdOpen);
      never.dispose();
    }

    // A live child that then exits: the entry lands exactly once, after exit.
    let exited = false;
    const exiting = new ScriptedChild();
    const coreExiting = makeCore(exiting, root, { childExitTimeoutMs: 2_000 });
    const write = coreExiting.appendChatUnlockAfterExit(true).then(() => { exited = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(exited, false, "the write did not happen while the child lived");
    const before = (await readFile(root.sessionFile, "utf8")).split("\n").filter(Boolean);
    assert.equal(before.filter((line) => line.includes("pi-web:chat-unlock")).length, 0);
    exiting.exit(0);
    await write;
    assert.equal(exited, true);
    const lines = (await readFile(root.sessionFile, "utf8")).split("\n").filter(Boolean);
    const unlockEntries = lines.map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "custom" && entry.customType === "pi-web:chat-unlock");
    assert.equal(unlockEntries.length, 1, "exactly one unlock entry");
    assert.deepEqual(unlockEntries[0].data, { version: 1, unlocked: true });
    coreExiting.dispose();
  } finally {
    core.dispose();
    await rm(root.root, { recursive: true, force: true });
  }
});

test("FileSessionManagerView exposes only enumerated appends, never a generic one", async () => {
  const root = await makeRoot();
  const child = new ScriptedChild();
  const core = makeCore(child, root);
  try {
    const view = core.sessionManager;
    assert.equal(typeof view.appendCustomEntry, "undefined", "no caller-chosen entry type");
    for (const member of ["appendToolSelectionEntry", "appendClearedToolSelectionEntry", "appendChatUnlockEntry"]) {
      assert.equal(typeof view[member], "function", member);
    }
  } finally {
    core.dispose();
    await rm(root.root, { recursive: true, force: true });
  }
});
