import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { PiRpcClient } = await jiti.import("./client.ts");
const { RpcAgentSession } = await jiti.import("./session.ts");

/**
 * End-to-end M1 smoke: a real pi child, an RpcAgentSession driving it, one
 * full prompt round. Requires PI_CLI_BIN (a pi executable); skips without it.
 * The prompt "Reply with exactly: OK" needs whatever provider the machine's
 * ~/.pi is configured with - same as a human smoke test.
 */
const PI_BIN = process.env.PI_CLI_BIN ?? "";

test("rpc session: full round trip over the real pi binary", { skip: PI_BIN ? false : "PI_CLI_BIN not set" }, async (t) => {
  assert.ok(existsSync(PI_BIN), `${PI_BIN} does not exist`);
  const work = join(tmpdir(), `pi-rpc-session-${Date.now()}`);
  await mkdir(work, { recursive: true });
  t.after(() => rm(work, { recursive: true, force: true }));

  const client = new PiRpcClient(PI_BIN, {
    args: ["--no-session"],
    cwd: work,
    onLog: (line) => { if (process.env.PI_RPC_TEST_VERBOSE) console.error("[pi]", line); },
  });
  t.after(() => client.kill());

  const events = [];
  const session = new RpcAgentSession({
    client,
    initialState: {
      sessionId: "",
      isStreaming: false,
      isCompacting: false,
      isIdle: true,
      autoCompactionEnabled: true,
      autoRetryEnabled: true,
      retryAttempt: 0,
      messageCount: 0,
      pendingMessageCount: 0,
      steeringQueue: [],
      followUpQueue: [],
    },
  });
  session.subscribe((event) => events.push(event));

  // 1. Factory step: refresh state from the child.
  await session.refreshState();
  assert.equal(typeof session.sessionId, "string");
  assert.ok(session.sessionId.length > 0, "sessionId resolved from get_state");

  // 2. Prompt round trip: admission, event stream, settled.
  let settled = false;
  let sawAgentStart = false;
  const offSettle = session.subscribe((event) => {
    if (event.type === "agent_settled") settled = true;
    if (event.type === "agent_start") sawAgentStart = true;
  });
  let disposition = "";
  await session.prompt("Reply with exactly: OK", {
    preflightResult: (value) => (disposition = value),
  });
  assert.equal(disposition, "started");

  const deadline = Date.now() + 120_000;
  while (!settled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  offSettle();
  assert.ok(settled, "agent_settled arrived");
  assert.ok(sawAgentStart, "agent_start streamed through the state machine");
  assert.equal(session.isStreaming, false);
  assert.equal(session.isIdle, true);

  // 3. The assistant text and stats came through the maintenance path.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(session.getLastAssistantText(), "OK");
  assert.ok(session.messageCount >= 2, `messageCount maintained (${session.messageCount})`);
  const stats = session.getSessionStats();
  assert.equal(stats.sessionId, session.sessionId);
  assert.ok(stats.totalMessages >= 2 || stats.tokens.total > 0, "stats cache refreshed after settle");

  // 4. A steering message is admitted, then aborted - no second full round.
  const steerResult = await session.steer("and nothing else");
  assert.ok(steerResult === "queued" || steerResult === "handled");
  await session.abort();
  const abortDeadline = Date.now() + 30_000;
  while (Date.now() < abortDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!session.isStreaming) break;
  }
  assert.equal(session.isStreaming, false, "abort ended the steered run");

  // 5. Explicitly-unsupported members throw loudly (not silently).
  assert.throws(() => session.setActiveToolsByName(["bash"]), /not available.*upstream PR set_active_tools/);
  assert.throws(() => session.sessionManager, /M2/);

  // 6. Dispose closes the child.
  await session.dispose();
  assert.ok(client.hasExited || (await client.close()) !== undefined);
});
