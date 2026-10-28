/**
 * Real-pi startup dialog: an extension asks the user while the child is still
 * starting up, i.e. before the host has any relay for the request. No model, no
 * auth, no network:
 *
 *   - the get_state handshake completes WHILE the dialog is still unanswered,
 *     so holding it cannot deadlock the start-up sequence;
 *   - the held dialog keeps its id and reaches the extension only after the
 *     host registers a handler (without the window it would be cancelled
 *     before the relay exists, and the user's approval silently lost);
 *   - nothing runs: no run starts, no user or assistant message is written.
 *
 * One pi behaviour shapes the fixture: a dialog AWAITED INSIDE the
 * `session_start` handler is unanswerable over RPC — pi runs the start-up
 * handlers before attaching its stdin reader, so an awaited dialog leaves the
 * event loop empty and the child exits (code 0) with the answer unread. A
 * startup task that asks the user without blocking the start (a
 * `setTimeout(0)` scheduled from `session_start`, the shape a real extension
 * uses for deferred prompts) is answerable, and that is what is exercised
 * here. Everything lives in one sandbox (cwd, agent dir, session dir); the real
 * ~/.pi/agent store and any user credentials are never touched. Requires
 * PI_CLI_BIN (absolute pi.exe path); skips otherwise.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { cleanupDir, resolvePiCliBin } from "./test-utils.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { PiRpcClient } = await jiti.import("./client.ts");
const { ensureSessionFile } = await jiti.import("./core.ts");
const { startCliRpcSession } = await jiti.import("./factory.ts");

const executable = resolvePiCliBin();

/**
 * A fixture extension whose ONLY behavior is the startup dialog: it defers a
 * confirm out of session_start and records the answer the host gave. It is a
 * fixture, not an installed package, and it spawns nothing.
 */
const STARTUP_CONFIRM_FIXTURE = `
import { appendFileSync, writeFileSync } from "node:fs";

export default function startupConfirmFixture(pi) {
  pi.on("session_start", async (_event, ctx) => {
    appendFileSync(process.env.PI_WEB_STARTUP_PROBE + ".log", "session_start\\n");
    setTimeout(async () => {
      const confirmed = await ctx.ui.confirm("Startup hook", "Run the startup fixture?");
      appendFileSync(process.env.PI_WEB_STARTUP_PROBE + ".log", "answered " + String(confirmed) + "\\n");
      writeFileSync(process.env.PI_WEB_STARTUP_PROBE, JSON.stringify({ confirmed: confirmed ?? null }), "utf8");
    }, 0);
  });
}
`;

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
    }, 50);
    timer.unref?.();
  });
}

test("a startup confirm raised while the child boots survives the pre-attach window", { skip: executable ? false : "PI_CLI_BIN not set" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rpc-startup-confirm-"));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const fixturePath = join(root, "startup-confirm-fixture.mjs");
  const probePath = join(root, "startup-confirm.json");
  await writeFile(fixturePath, STARTUP_CONFIRM_FIXTURE, "utf8");

  const manager = SessionManager.create(cwd, sessionDir);
  const sessionFile = ensureSessionFile(manager);

  const client = new PiRpcClient(executable, {
    cwd,
    // -ne/-ns/-np keep the host's discovered resources out; the fixture is the
    // only extension, and the agent dir is sandboxed so no user auth is read.
    args: [
      "--session", sessionFile,
      "--session-dir", sessionDir,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--extension", fixturePath,
    ],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_WEB_STARTUP_PROBE: probePath,
    },
    onLog: () => {},
  });
  const events = [];
  client.onEvent((record) => events.push(record));

  // The exact sequence factory.ts runs: open the window, then handshake while
  // the wrapper's relay is still missing.
  client.beginUiAttachWindow({ timeoutMs: 30_000 });

  try {
    await waitFor(() => client.pendingUiRequests >= 1, 30_000, "the startup confirm to be held");
    const state = await client.command("get_state", {}, 60_000);
    assert.equal(typeof state.sessionId, "string", "the handshake answered");
    assert.ok(client.pendingUiRequests >= 1, "and it answered WHILE the dialog was still unanswered");

    // The held dialog kept its id: the handler below answers this request.
    client.onUi("confirm", () => ({ confirmed: true }));
    await waitFor(() => client.pendingUiRequests === 0, 30_000, "the held dialog to be replayed");
    const deadline = Date.now() + 30_000;
    let record;
    while (record === undefined) {
      try {
        record = JSON.parse(await readFile(probePath, "utf8"));
      } catch {
        if (Date.now() > deadline) throw new Error("timeout waiting for the fixture's answer record");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.deepEqual(record, { confirmed: true }, "the extension received the host's approval");

    client.endUiAttachWindow();
    const exitCode = await client.close();
    assert.equal(typeof exitCode, "number", "the child exited cleanly after the dialog was answered");

    // No run, no transcript: the dialog was the only thing that happened.
    const entries = (await readFile(sessionFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(entries.filter((entry) => entry.type === "message"), [], "no user or assistant message was written");
    assert.equal(events.some((event) => event.type === "agent_start"), false, "no agent run started");
  } finally {
    client.endUiAttachWindow();
    await client.close().catch(() => null);
    await cleanupDir(root);
  }
});

/**
 * A fixture that raises the fire-and-forget UI the 30s boot deadlock was made
 * of: setStatus/setWidget (whose handler only exists after attachUiRelay) plus
 * a plain notify, all from session_start — i.e. while the child is still
 * booting, before the host's first stdin line is honoured, and therefore
 * ahead of the bridge result that answers refreshTools' tools.list. Written
 * as .ts: that is the extension form pi discovers in <agentDir>/extensions
 * (the parent diagnosis reproduced the deadlock with this exact shape).
 */
const STARTUP_STATUS_FIXTURE = `
export default function startupStatusFixture(pi) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("startup fixture running", "info");
    ctx.ui.setStatus("startup-probe", "probe");
    ctx.ui.setWidget("startup-widget", ["probe"]);
  });
}
`;

test(
  "a startup setStatus/widget does not stall the factory start behind the UI window",
  { skip: executable ? false : "PI_CLI_BIN not set" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rpc-startup-status-"));
    const cwd = join(root, "work");
    const agentDir = join(root, "agent");
    const sessionDir = join(root, "sessions");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    // An isolated agent dir: no user packages, no MCP servers, no credentials —
    // the real ~/.pi/agent store is never read or written.
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }), "utf8");
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    await writeFile(join(agentDir, "extensions", "startup-status-fixture.ts"), STARTUP_STATUS_FIXTURE, "utf8");

    // The REAL factory chain (beginUiAttachWindow → handshake → core →
    // refreshTools → wrapper → attachUiRelay), the way startRpcSession runs it.
    const startedAt = Date.now();
    let started;
    try {
      started = await startCliRpcSession({
        sessionId: "startup-status-smoke",
        cwd,
        sessionDir,
        agentDir,
        executable,
      });
      const elapsed = Date.now() - startedAt;
      // The regression this pins: the tools.list bridge result notify was
      // queued behind the held startup setStatus, so refreshTools waited out
      // its full 30s timeout and the session started degraded (liveTools
      // false) half a minute late.
      assert.ok(elapsed < 15_000, `the factory start answered in ${elapsed} ms, not the bridge timeout`);
      assert.equal(started.core.supportsLiveToolSwitch(), true, "tools.list answered while the startup UI was held");
      assert.equal(started.core.rpc.pendingUiRequests, 0, "the startup window drained into the relay");

      // The startup status/widget reached the wrapper's relay: replayed once,
      // not lost and not duplicated.
      const state = await started.wrapper.send({ type: "get_state" });
      assert.deepEqual(
        (state.extensionStatuses ?? []).filter((status) => status.key === "startup-probe"),
        [{ key: "startup-probe", text: "probe" }],
        "the startup status reached the relay exactly once",
      );
      const widget = (state.extensionWidgets ?? []).find((entry) => entry.key === "startup-widget");
      assert.ok(widget, "the startup widget reached the relay");
      assert.deepEqual(widget.lines, ["probe"]);

      // No run, no model call, no transcript: the fixture only raised UI.
      const entries = (await readFile(started.sessionFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.deepEqual(entries.filter((entry) => entry.type === "message"), [], "no user or assistant message was written");
    } finally {
      if (started) {
        await started.wrapper.shutdown().catch(() => null);
        await started.core.waitForChildExit().catch(() => null);
      }
      await cleanupDir(root);
    }
  },
);
