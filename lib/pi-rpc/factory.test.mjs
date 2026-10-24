/**
 * End-to-end: the REAL AgentSessionWrapper (lib/rpc-manager.ts) running over
 * the pi CLI RPC engine — the exact stack startRpcSession will host once M2
 * flips the routes. Exercises the wrapper's own send()/onEvent()/start()
 * machinery, not just the protocol layer.
 *
 * Requires PI_CLI_BIN (absolute pi.exe path); skips otherwise. The pure
 * factory helpers (buildToolArgs, buildCliEnv) run everywhere — the import
 * graph is loaded at the top so CI sees it even in skip mode.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupDir, resolvePiCliBin } from "./test-utils.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { startCliRpcSession, buildToolArgs, buildCliEnv } = await jiti.import("./factory.ts");

const executable = resolvePiCliBin();

function waitFor(predicate, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${what}`));
      }
    }, 100);
    timer.unref?.();
  });
}

test("buildToolArgs pins the whole coding domain, shells included", () => {
  // A read-only selection must switch BOTH shells off explicitly: an
  // unselected shell may otherwise survive through the child's defaults.
  const args = buildToolArgs(["read", "grep", "find", "ls"]);
  assert.deepEqual(args[0], "--tools");
  const entries = args[1].split(",");
  assert.ok(entries.includes("-powershell"), "powershell is explicitly off");
  assert.ok(entries.includes("-bash"), "bash is explicitly off");
  assert.ok(!entries.some((entry) => entry.startsWith("+bash") || entry.startsWith("+powershell")), "no shell is enabled");
  assert.ok(entries.includes("+read"));
  assert.ok(entries.includes("+grep"));
  assert.ok(entries.includes("+find"));
  assert.ok(entries.includes("+ls"));
  assert.ok(entries.includes("-edit"));
  assert.ok(entries.includes("-write"));

  // Every coding tool gets exactly one sign: the entry count is the domain.
  assert.equal(entries.length, 8, "read, bash, powershell, edit, write, grep, find, ls");
});

test("buildToolArgs follows the powershell defaultTools mapping like the in-process engine", () => {
  // Without the powershell switch in defaultTools, a pinned bash stays bash.
  const plain = buildToolArgs(["read", "bash"], ["read", "bash", "edit", "write"]);
  assert.ok(plain[1].split(",").includes("+bash"));
  assert.ok(plain[1].split(",").includes("-powershell"));

  if (process.platform === "win32") {
    // resolveShellTools only maps on win32; mirror rpc-manager's semantics.
    const mapped = buildToolArgs(["read", "bash"], ["read", "powershell", "edit", "write"]);
    const entries = mapped[1].split(",");
    assert.ok(entries.includes("+powershell"), "the pinned bash follows the powershell switch");
    assert.ok(entries.includes("-bash"), "bash itself is switched off");
  }
});

test("buildCliEnv strips the host runtime variables the child's bash would inherit", async () => {
  const env = buildCliEnv({
    PORT: "30141",
    NODE_ENV: "development",
    NEXT_RUNTIME: "edge",
    PI_WEB_PASSWORD: "hunter2",
    PI_PACKAGE_DIR: "C:/packaged/app",
    PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: "C:/packaged/app",
    JITI_ALIAS: "{}",
    PATH: "C:/windows",
    MY_PROJECT_VAR: "keep-me",
  });
  assert.equal(env.PORT, undefined, "PORT is stripped");
  assert.equal(env.NODE_ENV, undefined, "NODE_ENV is stripped");
  assert.equal(env.PI_WEB_PASSWORD, undefined, "the web password never reaches the child");
  assert.equal("NEXT_RUNTIME" in env, false, "NEXT_* is stripped");
  assert.equal(env.PI_PACKAGE_DIR, undefined, "app-shell SDK vars are stripped");
  assert.equal(env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT, undefined);
  assert.equal(env.JITI_ALIAS, undefined);
  assert.equal(env.PATH, "C:/windows", "PATH itself survives");
  assert.equal(env.MY_PROJECT_VAR, "keep-me", "unrelated variables survive");
});

test("startCliRpcSession rejects a chat-only pin before writing anything", async () => {
  const work = join(tmpdir(), `pi-rpc-chatonly-${Date.now()}`);
  await mkdir(work, { recursive: true });
  try {
    // The rejection must happen before the pin is persisted (an empty
    // tool-selection entry appended here would pin the session file to
    // chat-only forever, for a start that never ran).
    await assert.rejects(
      () => startCliRpcSession({ sessionId: "chat-only-pin", cwd: work, sessionDir: join(work, "sessions"), toolNames: [], executable: executable || "pi" }),
      /Chat-only tool pins are not supported/,
    );
  } finally {
    await cleanupDir(work);
  }
});

test("startCliRpcSession rejects an invalid executable quickly", async () => {
  const work = join(tmpdir(), `pi-rpc-missing-${Date.now()}`);
  await mkdir(work, { recursive: true });
  try {
    const started = Date.now();
    await assert.rejects(
      () => startCliRpcSession({ sessionId: "missing-bin", cwd: work, sessionDir: join(work, "sessions"), executable: join(work, "missing.exe") }),
      /failed to start|exited|spawn/i,
    );
    // A spawn failure must surface as a fast rejection, not the 90s handshake
    // timeout: close() must resolve without an 'exit' event to wait for.
    assert.ok(Date.now() - started < 30_000, "rejected without waiting for the handshake timeout");
  } finally {
    await cleanupDir(work);
  }
});

test("wrapper runs a prompt end-to-end over the child", { skip: executable ? false : "PI_CLI_BIN not set" }, async () => {
  const work = join(tmpdir(), `pi-rpc-factory-${Date.now()}`);
  await mkdir(work, { recursive: true });
  // Session files stay inside the sandbox dir: they must never enter the real
  // ~/.pi/agent/sessions store the sidebar lists.
  const sessionDir = join(work, "sessions");
  try {
    const started = await startCliRpcSession({
      sessionId: "factory-e2e",
      cwd: work,
      sessionDir,
      toolNames: ["read", "bash"],
      executable,
    });
    const { wrapper, core } = started;

    const events = [];
    const off = wrapper.onEvent((event) => events.push(event));
    const sawPromptDone = () => events.some((event) => event.type === "agent_settled");


    // The wrapper's own admission path: send() → inner.prompt → settle.
    await wrapper.send({ type: "prompt", message: "Reply with exactly: FACTORY-OK" });
    await waitFor(sawPromptDone, 120_000, "agent_settled through wrapper events");

    // The prompt promise resolved only after the run settled (SDK contract).
    assert.ok(!core.isStreaming, "run settled");
    assert.ok(!wrapper.isRunning(), "wrapper reports idle after settle");

    // Last assistant text flows through the wrapper command.
    const lastText = await wrapper.send({ type: "get_last_assistant_text" });
    assert.match(String(lastText?.text ?? ""), /FACTORY-OK/);

    // get_state through the wrapper: the core's event-maintained members.
    const state = await wrapper.send({ type: "get_state" });
    assert.equal(state.sessionId, started.realSessionId);
    assert.ok(state.model, "a model is selected");
    assert.equal(state.isStreaming, false);

    // The degraded tool list: pinned selection active, others not.
    const tools = await wrapper.send({ type: "get_tools" });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get("read").active, true);
    assert.equal(byName.get("bash").active, true);
    assert.equal(byName.get("edit").active, false);
    assert.equal(byName.get("write").active, false);


    // get_commands through the wrapper's three-source composition.
    const commands = await wrapper.send({ type: "get_commands" });
    assert.ok(Array.isArray(commands.commands));

    // Session stats read the shared file fresh: our session, a real transcript.
    const stats = await wrapper.send({ type: "get_session_stats" });
    assert.ok(stats);
    assert.equal(stats.sessionId, started.realSessionId, "stats describe this session");
    assert.ok(stats.totalMessages >= 2, `stats saw the conversation (${stats.totalMessages} messages)`);

    // The file on disk: our header id, the conversation appended by the child.
    const lines = readFileSync(started.sessionFile, "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]);
    assert.equal(header.id, started.realSessionId);
    assert.ok(lines.length >= 3, "the child appended entries");

    off();
    await wrapper.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    await cleanupDir(work);
  }
});

test("resume reopens the same session over a fresh child", { skip: executable ? false : "PI_CLI_BIN not set" }, async () => {
  const work = join(tmpdir(), `pi-rpc-resume-${Date.now()}`);
  await mkdir(work, { recursive: true });
  const sessionDir = join(work, "sessions");
  try {
    const first = await startCliRpcSession({
      sessionId: "resume-e2e",
      cwd: work,
      sessionDir,
      executable,
    });
    // send() resolves at admission (the wrapper contract); the run settles
    // in the event stream, exactly like the frontend sees it.
    const settled = [];
    const off = first.wrapper.onEvent((event) => settled.push(event.type));
    await first.wrapper.send({ type: "prompt", message: "Reply with exactly: RESUME-OK" });
    await waitFor(() => settled.includes("agent_settled"), 120_000, "agent_settled before shutdown");
    off();
    await first.wrapper.shutdown();
    assert.ok(existsSync(first.sessionFile));

    const second = await startCliRpcSession({
      sessionId: "resume-e2e",
      sessionFile: first.sessionFile,
      executable,
    });
    assert.equal(second.realSessionId, first.realSessionId, "the child adopted our session id");
    const lastText = await second.wrapper.send({ type: "get_last_assistant_text" });
    assert.match(String(lastText?.text ?? ""), /RESUME-OK/, "the resumed session kept its transcript");
    await second.wrapper.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    await cleanupDir(work);
  }
});
