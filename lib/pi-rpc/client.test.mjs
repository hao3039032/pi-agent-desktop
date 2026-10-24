import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { cleanupDir, resolvePiCliBin } from "./test-utils.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { PiRpcClient } = await jiti.import("./client.ts");

/**
 * These tests drive the real pi CLI over its documented RPC protocol. Set
 * PI_CLI_BIN to a pi executable (e.g. the standalone pi.exe); without it they
 * skip, so CI without the binary still runs the rest of the suite.
 */
const PI_BIN = resolvePiCliBin();
const piAvailable = PI_BIN !== "";
const { tmpdir } = await import("node:os");

test("pi rpc: handshake, state, events and orderly shutdown", { skip: piAvailable ? false : "PI_CLI_BIN not set" }, async (t) => {
  const work = join(tmpdir(), `pi-rpc-client-${Date.now()}`);
  await mkdir(work, { recursive: true });
  t.after(() => cleanupDir(work));

  const logs = [];
  const events = [];
  let exitCode = null;
  const client = new PiRpcClient(PI_BIN, {
    args: ["--no-session"],
    cwd: work,
    onLog: (line) => logs.push(line),
    onExit: (code) => (exitCode = code),
  });
  t.after(() => client.kill());

  // Events must be subscribable before the first prompt (docs: subscribe early).
  const off = client.onEvent((record) => events.push(record));

  // 1. Handshake: get_state answers with the documented fields.
  const state = await client.command("get_state", {}, 30_000);
  assert.equal(typeof state.sessionId, "string");
  assert.equal(state.isStreaming, false);

  // 2. Failure correlation: an unknown command rejects with pi's error.
  await assert.rejects(
    () => client.command("definitely_not_a_command", {}, 30_000),
    /Unknown command|failed/i,
  );

  // 3. A second command correlates independently (id multiplexing).
  const again = await client.command("get_state", {}, 30_000);
  assert.equal(again.sessionId, state.sessionId);

  // 4. Bash tool executes through the child; a caller-supplied `id` is BOTH
  //    the response correlation id and the bash_execution_update event id
  //    (docs/rpc-commands.md). A client that overwrote it with its own
  //    generated id would never correlate the response.
  const bash = await client.command(
    "bash",
    { command: "echo rpc-client-ok", id: "bash-probe-1" },
    60_000,
  );
  assert.equal(bash.exitCode, 0);
  assert.ok(bash.output.includes("rpc-client-ok"));
  const bashUpdates = events.filter((event) => event.type === "bash_execution_update");
  assert.ok(bashUpdates.length > 0, "bash output streamed as events");
  assert.ok(
    bashUpdates.every((event) => event.id === "bash-probe-1"),
    "streamed chunks repeat the caller's command id",
  );

  // 5. A clean close resolves with the exit code.
  off();
  const code = await client.close();
  assert.equal(typeof code, "number");
  assert.equal(exitCode, code);
  // A command after close rejects instead of hanging.
  await assert.rejects(() => client.command("get_state", {}, 1_000), /exited|exit/i);
});

/**
 * An extension loaded straight from a temp file (pi --extension) raises
 * deterministic extension_ui_requests, so the client's UI subprotocol is
 * asserted for real: async handlers are awaited and answered (not answered
 * with a promise object), and an unregistered dialog method is auto-cancelled
 * so pi cannot block on it.
 */
const UI_PROBE_EXTENSION = `export default function (pi) {
  pi.registerCommand("ui_probe", {
    description: "Raise extension UI for the client test",
    handler: async (_name, ctx) => {
      ctx.ui.notify("ui-probe-started", "info");
      const choice = await ctx.ui.select("Pick one", ["A", "B"]);
      ctx.ui.notify("ui-probe-choice=" + choice, "info");
      // No "input" handler is registered by the test client: this must come
      // back as an auto-cancel (undefined), not block the child.
      const typed = await ctx.ui.input("Type something", "placeholder");
      ctx.ui.notify("ui-probe-input=" + (typed === undefined ? "cancelled" : typed), "info");
    },
  });
};
`;

test("pi rpc: extension ui requests are answerable from the host", { skip: piAvailable ? false : "PI_CLI_BIN not set" }, async (t) => {
  const work = join(tmpdir(), `pi-rpc-ui-${Date.now()}`);
  await mkdir(work, { recursive: true });
  t.after(() => cleanupDir(work));

  const extensionPath = join(work, "ui-probe.mjs");
  await writeFile(extensionPath, UI_PROBE_EXTENSION, "utf8");

  const client = new PiRpcClient(PI_BIN, {
    // --no-extensions keeps the machine's user extensions out; explicit
    // --extension paths still load, so the probe is fully self-contained.
    args: ["--no-session", "--no-extensions", "--extension", extensionPath],
    cwd: work,
  });
  t.after(() => client.kill());

  await client.command("get_state", {}, 30_000);

  const notifications = [];
  client.onUi("notify", (params) => {
    notifications.push(String(params.message));
    return undefined; // fire-and-forget
  });
  // An async handler: the client must await it and answer with the resolved
  // value, never serialise the promise object into extension_ui_response.
  client.onUi("select", async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { value: "B" };
  });
  // "input" stays unregistered on purpose (auto-cancel path).

  const response = await client.command("prompt", { message: "/ui_probe" }, 60_000);
  assert.equal(response?.disposition, "handled", "the extension command consumed the prompt");

  // The probe reports what each dialog returned, through notify events.
  const deadline = Date.now() + 30_000;
  const saw = (needle) => notifications.some((message) => message.includes(needle));
  while (!saw("ui-probe-input=") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(saw("ui-probe-started"), "notify (fire-and-forget) reached the handler");
  assert.ok(saw("ui-probe-choice=B"), "the async select handler's resolved value reached pi");
  assert.ok(saw("ui-probe-input=cancelled"), "an unregistered dialog method is auto-cancelled");

  await client.close();
});

/** A spawn failure (missing executable) must reject commands and close() promptly. */
test("pi rpc: a failed spawn rejects commands and does not hang close()", async () => {
  const client = new PiRpcClient(join(tmpdir(), "definitely-missing-pi-binary.exe"), {
    args: ["--no-session"],
    onLog: () => {},
  });
  await assert.rejects(
    () => client.command("get_state", {}, 10_000),
    /failed to start|exited/i,
  );
  // The force-kill grace must not gate a child that never existed.
  const started = Date.now();
  const code = await client.close(60_000);
  assert.ok(Date.now() - started < 5_000, "close resolves without waiting for a non-existent child");
  assert.equal(code, null);
});
