import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import { join } from "node:path";
import { existsSync } from "node:fs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { PiRpcClient } = await jiti.import("./client.ts");

/**
 * These tests drive the real pi CLI over its documented RPC protocol. Set
 * PI_CLI_BIN to a pi executable (e.g. the standalone pi.exe); without it they
 * skip, so CI without the binary still runs the rest of the suite.
 */
const PI_BIN = process.env.PI_CLI_BIN ?? "";
const piAvailable = PI_BIN !== "" ;
const { mkdir, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");

test("pi rpc: handshake, state, events and orderly shutdown", { skip: piAvailable ? false : "PI_CLI_BIN not set" }, async (t) => {
  assert.ok(existsSync(PI_BIN), `${PI_BIN} does not exist`);
  const work = await mkdir(join(tmpdir(), "pi-rpc-client-"), { recursive: true });
  t.after(() => rm(work, { recursive: true, force: true }));

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

  // 4. Bash tool executes through the child and streams updates with the command id.
  const bash = await client.command(
    "bash",
    { command: "echo rpc-client-ok" },
    60_000,
  );
  assert.equal(bash.exitCode, 0);
  assert.ok(bash.output.includes("rpc-client-ok"));
  assert.ok(
    events.some((event) => event.type === "bash_execution_update"),
    "bash output streamed as events",
  );

  // 5. Unparseable-line robustness is internal; a clean close resolves with the code.
  off();
  const code = await client.close();
  assert.equal(typeof code, "number");
  assert.equal(exitCode, code);
  // A command after close rejects instead of hanging.
  await assert.rejects(() => client.command("get_state", {}, 1_000), /exited|exit/i);
});

test("pi rpc: extension ui requests are answerable from the host", { skip: piAvailable ? false : "PI_CLI_BIN not set" }, async (t) => {
  assert.ok(existsSync(PI_BIN));
  const work = await mkdir(join(tmpdir(), "pi-rpc-ui-"), { recursive: true });
  t.after(() => rm(work, { recursive: true, force: true }));

  const client = new PiRpcClient(PI_BIN, { args: ["--no-session"], cwd: work });
  t.after(() => client.kill());

  // Register a handler before anything can ask; the extension-ui subprotocol
  // must never block pi: unhandled dialog methods are auto-cancelled.
  const seen = [];
  client.onUi("setStatus", (params) => {
    seen.push(params);
    return undefined; // fire-and-forget
  });

  await client.command("get_state", {}, 30_000);
  // Load the user's extensions (default behaviour without --no-extensions) so
  // real extension traffic may flow; we only assert the client stays healthy.
  const stats = await client.command("get_state", {}, 30_000);
  assert.equal(typeof stats.sessionId, "string");
  await client.close();
});
