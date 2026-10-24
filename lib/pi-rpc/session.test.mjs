import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { cleanupDir, resolvePiCliBin } from "./test-utils.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { PiRpcClient } = await jiti.import("./client.ts");
const { RpcAgentSession } = await jiti.import("./session.ts");

/**
 * End-to-end M1 smoke: a real pi child, an RpcAgentSession driving it, one
 * full prompt round. Requires PI_CLI_BIN (a pi executable); skips without it.
 * The prompt "Reply with exactly: OK" needs whatever provider the machine's
 * ~/.pi is configured with - same as a human smoke test.
 */
const PI_BIN = resolvePiCliBin();

/** Poll until predicate() holds; the event-driven paths are not fixed-delay. */
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

test("rpc session: full round trip over the real pi binary", { skip: PI_BIN ? false : "PI_CLI_BIN not set" }, async (t) => {
  const work = join(tmpdir(), `pi-rpc-session-${Date.now()}`);
  await mkdir(work, { recursive: true });
  t.after(() => cleanupDir(work));

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

  await waitFor(() => settled, 120_000, "agent_settled");
  offSettle();
  assert.ok(settled, "agent_settled arrived");
  assert.ok(sawAgentStart, "agent_start streamed through the state machine");
  assert.equal(session.isStreaming, false);
  assert.equal(session.isIdle, true);

  // 3. The assistant text and stats came through the maintenance path. The
  // model may add punctuation or whitespace around the requested token, so
  // match, don't equal; the post-settle refreshes are event-driven, so poll.
  await waitFor(
    () => typeof session.getLastAssistantText() === "string" && /OK/.test(session.getLastAssistantText()),
    30_000,
    "last assistant text",
  );
  assert.match(session.getLastAssistantText(), /OK/);
  assert.ok(session.messageCount >= 2, `messageCount maintained (${session.messageCount})`);
  await waitFor(() => session.getSessionStats().sessionId === session.sessionId, 30_000, "stats sessionId");
  const stats = session.getSessionStats();
  assert.ok(stats.totalMessages >= 2 || stats.tokens.total > 0, "stats cache refreshed after settle");

  // 4. A steering message is admitted, then aborted - no second full round.
  const steerResult = await session.steer("and nothing else");
  assert.ok(steerResult === "queued" || steerResult === "handled");
  await session.abort();
  await waitFor(() => !session.isStreaming, 30_000, "abort ended the steered run");
  assert.equal(session.isStreaming, false, "abort ended the steered run");

  // 5. Explicitly-unsupported members throw loudly (not silently).
  assert.throws(() => session.setActiveToolsByName(["bash"]), /not available.*upstream PR set_active_tools/);
  assert.throws(() => session.sessionManager, /M2/);

  // 6. Dispose closes the child.
  await session.dispose();
  assert.ok(client.hasExited || (await client.close()) !== undefined);
});
