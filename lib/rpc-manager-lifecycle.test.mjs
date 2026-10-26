import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// startRpcSession() builds real SDK sessions here; keep them out of ~/.pi.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-agent-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });

// The route flip (M2) runs normal project sessions on the pi CLI child, so a
// restart that leaves Chat-only crosses onto the CLI engine and needs the
// real binary. resolvePiCliBin() normalizes MSYS "/f/..." paths (a silent
// skip on Git-Bash otherwise) and fails loudly on a set-but-missing path.
const { resolvePiCliBin } = await jiti.import("./pi-rpc/test-utils.mjs");
const piBin = resolvePiCliBin();
process.env.PI_CLI_BIN = piBin;
const {
  AgentSessionWrapper,
  getRpcSession,
  resolveSessionShutdownDeadlineMs,
  setRpcSessionTools,
  startRpcSession,
} = await jiti.import("./rpc-manager.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/** An SDK session whose session_shutdown handlers wait until the test releases them, or forever with `hang`. */
function makeClosingInner(calls, { hang = false } = {}) {
  let release = () => {};
  const held = hang
    ? new Promise(() => {})
    : new Promise((resolve) => { release = resolve; });
  return {
    inner: {
      sessionId: "closing-session",
      isBashRunning: false,
      isStreaming: false,
      isCompacting: false,
      extensionRunner: {
        emit(event) {
          calls.push(["emit", event.type]);
          return held;
        },
      },
      dispose() {
        calls.push(["dispose"]);
      },
    },
    release: () => release(),
  };
}

test("defaults the shutdown deadline to 5 seconds when the env var is unset or blank", () => {
  assert.equal(resolveSessionShutdownDeadlineMs(), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs(""), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs("   "), 5_000);
});

test("uses a positive shutdown deadline in milliseconds", () => {
  assert.equal(resolveSessionShutdownDeadlineMs("250"), 250);
  assert.equal(resolveSessionShutdownDeadlineMs("2147483647"), 2_147_483_647);
});

test("falls back to the 5-second deadline and warns for zero, invalid or out-of-range values", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  // Zero would mean "dispose without telling extensions"; shutdown always has a deadline.
  assert.equal(resolveSessionShutdownDeadlineMs("0"), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs("abc"), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs("-5"), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs("NaN"), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs("Infinity"), 5_000);
  assert.equal(resolveSessionShutdownDeadlineMs("2147483648"), 5_000);
  assert.equal(warn.mock.callCount(), 6);
});

test("a wrapper reports itself dead as soon as shutdown starts", async () => {
  const calls = [];
  const { inner, release } = makeClosingInner(calls);
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push(["unregister"]));

  const shutting = wrapper.shutdown();
  assert.equal(wrapper.isAlive(), false);
  // A second caller (project trust, a deleted session) joins the same shutdown.
  const joined = wrapper.shutdown();

  await nextTurn();
  // Extensions are still handling session_shutdown; nothing is disposed yet.
  assert.deepEqual(calls, [["emit", "session_shutdown"]]);
  assert.equal(wrapper.isAlive(), false);
  assert.equal(wrapper.evictIfDiskAhead(), false);

  release();
  await Promise.all([shutting, joined]);
  assert.deepEqual(calls, [["emit", "session_shutdown"], ["dispose"], ["unregister"]]);
  assert.equal(wrapper.isAlive(), false);
});

test("shutdown disposes the session once the deadline passes even if session_shutdown never settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warn = t.mock.method(console, "warn", () => {});
  const calls = [];
  const { inner } = makeClosingInner(calls, { hang: true });
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push(["unregister"]));

  let settled = false;
  const shutting = wrapper.shutdown().then(() => { settled = true; });
  await nextTurn();
  t.mock.timers.tick(4_999);
  await nextTurn();
  assert.equal(settled, false);
  assert.deepEqual(calls, [["emit", "session_shutdown"]]);

  t.mock.timers.tick(1);
  await shutting;
  assert.deepEqual(calls, [["emit", "session_shutdown"], ["dispose"], ["unregister"]]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(
    warn.mock.calls[0].arguments[0],
    /did not finish session_shutdown for session closing-session within 5000 ms/,
  );
});

test("direct destruction also disposes the session at the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warn = t.mock.method(console, "warn", () => {});
  const calls = [];
  const { inner } = makeClosingInner(calls, { hang: true });
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => calls.push(["unregister"]));

  wrapper.destroy();
  assert.equal(wrapper.isAlive(), false);
  await nextTurn();
  assert.deepEqual(calls, [["emit", "session_shutdown"]]);

  t.mock.timers.tick(5_000);
  await nextTurn();
  assert.deepEqual(calls, [["emit", "session_shutdown"], ["dispose"], ["unregister"]]);
  assert.equal(warn.mock.callCount(), 1);
});

test("a session_shutdown failure after the deadline is not an unhandled rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  let failLate;
  const calls = [];
  const wrapper = new AgentSessionWrapper({
    sessionId: "late-failure",
    isBashRunning: false,
    extensionRunner: {
      emit: () => new Promise((_resolve, reject) => { failLate = reject; }),
    },
    dispose() {
      calls.push("dispose");
    },
  });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const shutting = wrapper.shutdown();
  await nextTurn();
  t.mock.timers.tick(5_000);
  await shutting;
  assert.deepEqual(calls, ["dispose"]);

  failLate(new Error("closed after the deadline"));
  await nextTurn();
  assert.deepEqual(unhandled, []);
});

test("the shutdown deadline timer does not keep the process alive", async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  const deadlineTimers = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const timer = realSetTimeout(callback, delay, ...args);
    if (delay === 5_000) deadlineTimers.push(timer);
    return timer;
  });
  const calls = [];
  const { inner, release } = makeClosingInner(calls);
  const wrapper = new AgentSessionWrapper(inner);

  const shutting = wrapper.shutdown();
  await nextTurn();
  assert.equal(deadlineTimers.length, 1);
  assert.equal(deadlineTimers[0].hasRef(), false);

  release();
  await shutting;
  assert.deepEqual(calls, [["emit", "session_shutdown"], ["dispose"]]);
});

test("PI_WEB_SHUTDOWN_DEADLINE_MS sets the deadline", async (t) => {
  const previousValue = process.env.PI_WEB_SHUTDOWN_DEADLINE_MS;
  process.env.PI_WEB_SHUTDOWN_DEADLINE_MS = "250";
  try {
    const freshJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
    const { AgentSessionWrapper: FreshWrapper } = await freshJiti.import("./rpc-manager.ts");

    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(console, "warn", () => {});
    const calls = [];
    const { inner } = makeClosingInner(calls, { hang: true });
    const wrapper = new FreshWrapper(inner);

    const shutting = wrapper.shutdown();
    await nextTurn();
    t.mock.timers.tick(249);
    await nextTurn();
    assert.deepEqual(calls, [["emit", "session_shutdown"]]);

    t.mock.timers.tick(1);
    await shutting;
    assert.deepEqual(calls, [["emit", "session_shutdown"], ["dispose"]]);
  } finally {
    if (previousValue === undefined) delete process.env.PI_WEB_SHUTDOWN_DEADLINE_MS;
    else process.env.PI_WEB_SHUTDOWN_DEADLINE_MS = previousValue;
  }
});

// A real SDK session is too large for assert's diff: compare wrappers by identity.
function assertRegistered(sessionId, expected, message) {
  assert.ok(getRpcSession(sessionId) === expected, message);
}

/** Starts a real, registered wrapper for a persisted session file. */
async function startPersistedSession(t, toolNames = []) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-cwd-"));
  // A pi CLI child's cwd handle outlives close() by a beat (Windows).
  t.after(async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(cwd, { recursive: true, force: true });
        return;
      } catch (error) {
        if (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY") throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  });
  const manager = SessionManager.create(cwd);
  manager.appendMessage({ role: "user", content: "persisted before the wrapper starts", timestamp: Date.now() });
  const sessionId = manager.getSessionId();
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile && existsSync(sessionFile));

  // Chat only (an empty pin) keeps the real SDK session free of extensions and skills.
  const { session } = await startRpcSession(sessionId, sessionFile, undefined, { toolNames });
  t.after(() => session.destroy());
  assertRegistered(sessionId, session, "the started wrapper is registered");
  return { sessionId, sessionFile, session };
}

/** The pi-web:tool-selection entries the session file holds, oldest first. */
async function toolSelectionEntries(sessionFile) {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(sessionFile, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.customType === "pi-web:tool-selection")
    .map((entry) => entry.data);
}

/**
 * Lets a replacement start while `wrapper` is still closing, as it does once the bounded
 * wait for a shutdown stuck in extension binding runs out.
 */
function skipClosingWait(wrapper) {
  wrapper.waitUntilDisposed = async () => false;
  // These tests hold the HOST's shutdown callback to test registry identity,
  // not ownership of a live child's file. End that writer before allowing a
  // replacement; a disposal timeout alone must never authorize two children.
  const close = wrapper.inner.rpc.close(100);
  wrapper.inner.waitForChildExit = async () => { await close; };
}

/** Holds session_shutdown open, as an MCP server that never finishes closing does. */
function holdSessionShutdown(wrapper) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  wrapper.inner.extensionRunner.emit = async () => {
    signalStarted();
    await held;
  };
  return { started, release };
}

async function startReplacement(t, sessionId, sessionFile, closing) {
  const { session: replacement, realSessionId } = await startRpcSession(sessionId, sessionFile, undefined);
  t.after(() => replacement.destroy());
  assert.ok(replacement !== closing, "startRpcSession must not return the closing wrapper");
  assert.equal(realSessionId, sessionId);
  assert.equal(replacement.isAlive(), true);
  assert.equal(replacement.isChatOnly(), true);
  assertRegistered(sessionId, replacement, "the replacement takes over the registry entry");
  // The fast path now returns the replacement rather than starting a third wrapper.
  const again = await startRpcSession(sessionId, sessionFile, undefined);
  assert.ok(again.session === replacement, "the fast path returns the replacement");
  return replacement;
}

test("startRpcSession waits for a closing wrapper to dispose before it opens the session again", { skip: piBin ? false : "PI_CLI_BIN not set (chat-only pins run on the pi CLI engine)" }, async (t) => {
  const { sessionId, sessionFile, session: closing } = await startPersistedSession(t);
  const shutdownHook = holdSessionShutdown(closing);
  const order = [];
  const dispose = closing.inner.dispose.bind(closing.inner);
  closing.inner.dispose = () => {
    order.push("closing disposed");
    dispose();
  };

  const shuttingDown = closing.shutdown();
  await shutdownHook.started;
  const replacing = startRpcSession(sessionId, sessionFile, undefined).then((started) => {
    order.push("replacement started");
    return started;
  });
  // Concurrent starts share the wait instead of each starting a wrapper.
  const concurrent = startRpcSession(sessionId, sessionFile, undefined);
  // A failed assertion below must not leave the shutdown held or the replacement running.
  t.after(async () => {
    shutdownHook.release();
    for (const start of [replacing, concurrent]) (await start.catch(() => null))?.session.destroy();
  });
  // An unblocked start of this Chat-only session finishes well within this window.
  await Promise.race([replacing, new Promise((resolve) => setTimeout(resolve, 500))]);
  assert.deepEqual(order, [], "nothing opens the session while its closing wrapper still owns it");
  assertRegistered(sessionId, closing, "the closing wrapper stays registered while it closes");
  assert.ok(globalThis.__piStartLocks.has(sessionId), "callers that check the start lock see the wait");

  shutdownHook.release();
  await shuttingDown;
  const { session: replacement } = await replacing;
  assert.ok((await concurrent).session === replacement, "the concurrent start gets the same replacement");
  assert.deepEqual(order, ["closing disposed", "replacement started"]);
  assert.ok(replacement !== closing);
  assertRegistered(sessionId, replacement, "the replacement takes over the registry entry");
});

test("a tool change made while the session closes applies to the wrapper a concurrent start brings up", { skip: piBin ? false : "PI_CLI_BIN not set (the restarted session runs on the pi CLI engine)" }, async (t) => {
  const { sessionId, sessionFile, session: closing } = await startPersistedSession(t);
  assert.equal(closing.isChatOnly(), true);
  const shutdownHook = holdSessionShutdown(closing);
  const shuttingDown = closing.shutdown();
  await shutdownHook.started;

  // An SSE reconnect starts the session again, then the user picks Read-only.
  const reconnecting = startRpcSession(sessionId, sessionFile, undefined);
  const changingTools = setRpcSessionTools(sessionId, sessionFile, ["read"]);
  t.after(async () => {
    shutdownHook.release();
    for (const start of [reconnecting, changingTools]) (await start.catch(() => null))?.session.destroy();
  });

  shutdownHook.release();
  await shuttingDown;
  const changed = await changingTools;
  await reconnecting;
  assert.equal(changed.session.isAlive(), true);
  assert.equal(changed.session.isChatOnly(), false, "the selection left Chat only");
  assertRegistered(sessionId, changed.session, "the wrapper with the selection is the registered one");
  const tools = await changed.session.send({ type: "get_tools" });
  assert.ok(tools.some((tool) => tool.name === "read" && tool.active), "read is active");
});

// A chat-only session refuses LIVE tool switches (its spawn flags differ) but
// its child still owns the session file: the pin must be appended by the live
// child, then the child is restarted — never a bridge command to a dead child.
test("leaving Chat only writes the pin in the live child, then restarts", { skip: piBin ? false : "PI_CLI_BIN not set (chat-only pins run on the pi CLI engine)" }, async (t) => {
  const { sessionId, sessionFile, session } = await startPersistedSession(t);
  assert.equal(session.isChatOnly(), true);

  const changed = await setRpcSessionTools(sessionId, sessionFile, ["read"]);
  t.after(() => changed.session.destroy());

  assert.equal(changed.recreated, true, "leaving Chat only restarts the child");
  assert.equal(changed.session.isChatOnly(), false);
  assertRegistered(sessionId, changed.session, "the new wrapper is the registered one");
  const tools = await changed.session.send({ type: "get_tools" });
  assert.ok(tools.some((tool) => tool.name === "read" && tool.active), "read is active after the restart");
  // The chat-only session file was not rewritten by the host beside the child:
  // the live child appended the pin itself, after the empty pin that started it.
  assert.deepEqual(await toolSelectionEntries(sessionFile), [
    { version: 1, tools: [] },
    { version: 1, tools: ["read"] },
  ]);
});

test("entering Chat only restarts the child and records the empty pin", { skip: piBin ? false : "PI_CLI_BIN not set (chat-only pins run on the pi CLI engine)" }, async (t) => {
  const { sessionId, sessionFile, session } = await startPersistedSession(t, ["read"]);
  assert.equal(session.isChatOnly(), false);

  const changed = await setRpcSessionTools(sessionId, sessionFile, []);
  t.after(() => changed.session.destroy());

  assert.equal(changed.recreated, true);
  assert.equal(changed.session.isChatOnly(), true);
  const tools = await changed.session.send({ type: "get_tools" });
  assert.deepEqual(tools, [], "a Chat-only session has no tools");
  assert.deepEqual(await toolSelectionEntries(sessionFile), [
    { version: 1, tools: ["read"] },
    { version: 1, tools: [] },
  ]);
});

test("clearing the pin retracts it and restarts on the configured defaults", { skip: piBin ? false : "PI_CLI_BIN not set (chat-only pins run on the pi CLI engine)" }, async (t) => {
  const { sessionId, sessionFile, session } = await startPersistedSession(t, ["read"]);
  assert.equal(session.isChatOnly(), false);

  const changed = await setRpcSessionTools(sessionId, sessionFile, undefined);
  t.after(() => changed.session.destroy());

  assert.equal(changed.recreated, true);
  assertRegistered(sessionId, changed.session, "the restarted wrapper is the registered one");
  // The retraction is a later entry, not a rewrite: the session log is append-only.
  assert.deepEqual(await toolSelectionEntries(sessionFile), [
    { version: 1, tools: ["read"] },
    { version: 1, cleared: true },
  ]);
});

test("startRpcSession replaces a shutting-down wrapper, which then cannot unregister its replacement", { skip: piBin ? false : "PI_CLI_BIN not set (chat-only pins run on the pi CLI engine)" }, async (t) => {  const { sessionId, sessionFile, session: closing } = await startPersistedSession(t);
  const shutdownHook = holdSessionShutdown(closing);
  skipClosingWait(closing);

  const shuttingDown = closing.shutdown();
  assert.equal(closing.isAlive(), false);
  await shutdownHook.started;
  // Still registered until it is disposed, but no lookup may route work to it.
  assertRegistered(sessionId, closing, "the closing wrapper stays registered until it is disposed");

  const replacement = await startReplacement(t, sessionId, sessionFile, closing);

  shutdownHook.release();
  await shuttingDown;
  assertRegistered(sessionId, replacement, "the closed wrapper left its replacement registered");
  assert.equal(replacement.isAlive(), true);

  await replacement.shutdown();
  assertRegistered(sessionId, undefined, "a wrapper still unregisters itself");
});

test("a wrapper evicted for a newer file on disk cannot unregister the wrapper that reloaded it", { skip: piBin ? false : "PI_CLI_BIN not set (chat-only pins run on the pi CLI engine)" }, async (t) => {
  const { sessionId, sessionFile, session: stale } = await startPersistedSession(t);
  const shutdownHook = holdSessionShutdown(stale);
  skipClosingWait(stale);
  // Another pi process appends to the same session file.
  SessionManager.open(sessionFile).appendMessage({
    role: "user",
    content: "written by the other process",
    timestamp: Date.now(),
  });

  // The CLI engine's session view reads the file on every access, so the
  // externally appended entry is visible immediately and there is nothing
  // stale to evict — unlike the in-process manager's frozen index.
  assert.equal(stale.evictIfDiskAhead(), false);
  // The registry guard still holds when a wrapper is destroyed out from
  // under a replacement: evict the stale one explicitly and reload.
  assert.equal(stale.isAlive(), true);
  stale.destroy();
  assert.equal(stale.isAlive(), false);
  await shutdownHook.started;

  const replacement = await startReplacement(t, sessionId, sessionFile, stale);

  shutdownHook.release();
  await nextTurn();
  assertRegistered(sessionId, replacement, "the destroyed wrapper left its replacement registered");
  assert.equal(replacement.isAlive(), true);
});

test("a wrapper registered before a hot reload cannot unregister its replacement either", { skip: piBin ? false : "PI_CLI_BIN not set (chat-only pins run on the pi CLI engine)" }, async (t) => {
  const { sessionId, sessionFile, session: closing } = await startPersistedSession(t);
  // registerRpcWrapper() before this change removed the entry by id alone.
  closing.onDestroy(() => globalThis.__piSessions.delete(sessionId));
  const shutdownHook = holdSessionShutdown(closing);
  skipClosingWait(closing);

  const shuttingDown = closing.shutdown();
  await shutdownHook.started;
  const replacement = await startReplacement(t, sessionId, sessionFile, closing);

  shutdownHook.release();
  await shuttingDown;
  assertRegistered(sessionId, replacement, "the old cleanup left its replacement registered");
});

test("a folder chat runs on the CLI engine with its policy enforced", { skip: piBin ? false : "PI_CLI_BIN not set (chats run on the pi CLI engine)" }, async (t) => {
  // Sandbox the agent dir so the chat folder and session land outside the
  // user's real store; getAgentDir() reads the env at call time.
  const sandbox = await mkdtemp(join(tmpdir(), "pi-web-chat-e2e-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = sandbox;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(sandbox, { recursive: true, force: true });
        return;
      } catch (error) {
        if (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY") throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  });

  const chatRoot = join(sandbox, "chats");
  await mkdir(chatRoot, { recursive: true });
  const { session, realSessionId } = await startRpcSession("chat-e2e", undefined, chatRoot);
  assert.ok(session.isChat(), "the session adopts the chat policy");
  assert.notEqual(session.cwd, chatRoot, "the chat got a folder of its own");
  const folder = session.cwd;

  // The prompt round trip runs on the child with the chat preamble.
  // (Needs provider auth, which the sandbox hides; the pi-rpc suites carry
  // the prompt coverage. Here: the policy and spawn selection.)
  const settled = [];
  const off = session.onEvent((event) => settled.push(event.type));
  off();

  // The wrapper refuses shell commands and tool changes in a chat outright.
  await assert.rejects(() => session.send({ type: "bash", command: "echo hi" }), /unavailable in chats/);
  await assert.rejects(() => session.send({ type: "set_tools", toolNames: ["read", "bash"] }), /Chats have no tools/);

  // The child-side policy keeps the shell tools off the active set; the
  // wrapper additionally never lists a chat's blocked coding tools at all.
  const tools = await session.send({ type: "get_tools" });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.has("bash"), false, "a chat never lists the shell tools");
  assert.equal(byName.get("write")?.active, true, "a folder chat keeps its file tools");

  await session.shutdown();
  void realSessionId;
  void folder;
});
