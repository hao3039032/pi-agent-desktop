/**
 * End-to-end: the REAL AgentSessionWrapper (lib/rpc-manager.ts) running over
 * the pi CLI RPC engine — the exact stack startRpcSession will host once M2
 * flips the routes. Exercises the wrapper's own send()/onEvent()/start()
 * machinery, not just the protocol layer.
 *
 * Requires PI_CLI_BIN (absolute pi.exe path); skips otherwise.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });

const piBin = process.env.PI_CLI_BIN;
const executable = piBin && existsSync(piBin) ? piBin : "";

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

/** Windows: a pi child's cwd handle outlives close() by a beat; rm failures must not fail tests. */
async function cleanupDir(work) {
  const { rm } = await import("node:fs/promises");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(work, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

test("wrapper runs a prompt end-to-end over the child", { skip: executable ? false : "PI_CLI_BIN not set" }, async () => {
  const { startCliRpcSession } = await jiti.import("./factory.ts");

  const work = join(tmpdir(), `pi-rpc-factory-${Date.now()}`);
  await mkdir(work, { recursive: true });
  try {
    const started = await startCliRpcSession({
      sessionId: "factory-e2e",
      cwd: work,
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

    // Session stats read the shared file fresh.
    const stats = await wrapper.send({ type: "get_session_stats" });
    assert.ok(stats);

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
  const { startCliRpcSession } = await jiti.import("./factory.ts");

  const work = join(tmpdir(), `pi-rpc-resume-${Date.now()}`);
  await mkdir(work, { recursive: true });
  try {
    const first = await startCliRpcSession({
      sessionId: "resume-e2e",
      cwd: work,
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
