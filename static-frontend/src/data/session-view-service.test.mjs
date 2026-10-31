/**
 * Tests for the static session-view service
 * (static-frontend/src/data/session-view-service.ts): the IPC request shapes
 * for sessions.get / sessions.context / sessions.state / sessions.lease /
 * sessions.create and the HTTP-shaped status contract the hooks consume
 * (404 for not_found, the abandon-and-retry-once view read).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const jiti = createJiti(import.meta.url, {
  alias: { "@": repoRoot },
  interopDefault: true,
});

const {
  fetchSessionView,
  fetchSessionContextPage,
  fetchAgentRunningState,
  renewSessionLease,
  createAgentSession,
  bindSessionViewService,
} = await jiti.import("./session-view-service.ts");
const { IpcClient, MockTransport, IpcTimeoutError } = await jiti.import("../ipc/client.ts");

function boundService(configure) {
  const mock = new MockTransport();
  if (configure) configure(mock);
  const client = new IpcClient(mock);
  bindSessionViewService(client);
  return mock;
}

test("sessions.get sends the view flags and maps the answer", async () => {
  const mock = boundService((transport) => {
    transport.on("sessions.get", (args) => {
      assert.deepEqual(
        { ...args },
        {
          session: "s1",
          summaryTree: true,
          deferThinking: true,
          deferMedia: true,
          wholeTurns: true,
        },
        "the load path's exact flags",
      );
      return { sessionId: "s1", leafId: "a3", context: { messages: [] } };
    });
  });
  const response = await fetchSessionView(
    "s1",
    { summaryTree: true, deferThinking: true, deferMedia: true, wholeTurns: true },
  );
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.data.leafId, "a3");
  // Absent flags stay out of the wire args (the info-only reads send less).
  const seen = [];
  const leaner = boundService((transport) => {
    transport.on("sessions.get", (args) => {
      seen.push(args);
      return { sessionId: "s1" };
    });
  });
  await fetchSessionView("s1", { deferThinking: true, deferMedia: true });
  assert.deepEqual(seen, [{ session: "s1", deferThinking: true, deferMedia: true }]);
  bindSessionViewService(new IpcClient(mock));
});

test("a host not_found maps to the 404 the load path's delete handling reads", async () => {
  boundService((transport) => {
    transport.fail("sessions.get", { code: "not_found", message: "Session not found: ghost" });
  });
  const response = await fetchSessionView("ghost", {});
  assert.equal(response.ok, false);
  assert.equal(response.status, 404);
  assert.equal(response.error, "Session not found: ghost");
});

test("a hung view read retries once and keeps a shouldRetry veto", async () => {
  let attempts = 0;
  let vetoed = false;
  boundService((transport) => {
    transport.on("sessions.get", () => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new IpcTimeoutError("sessions.get", "r1"));
      }
      return { sessionId: "s1" };
    });
  });
  const recovered = await fetchSessionView("s1", {}, { shouldRetry: () => true });
  assert.equal(recovered.ok, true, "the second attempt answered");
  assert.equal(attempts, 2);

  attempts = 0;
  vetoed = true;
  boundService((transport) => {
    transport.on("sessions.get", () => {
      attempts += 1;
      return Promise.reject(new IpcTimeoutError("sessions.get", "r2"));
    });
  });
  await assert.rejects(
    () => fetchSessionView("s1", {}, { shouldRetry: () => !vetoed }),
    /timed out/,
    "the veto skipped the retry",
  );
  assert.equal(attempts, 1);
});

test("sessions.context pages with leafId/before/tail and sessions.state polls", async () => {
  const calls = [];
  boundService((transport) => {
    transport.on("sessions.context", (args) => {
      calls.push(args);
      return { context: { messages: [], entryIds: [] }, tail: 50, before: args.before ?? null };
    });
    transport.on("sessions.state", (args) => {
      assert.deepEqual(args, { session: "s1" });
      return { running: true, state: { sessionId: "s1", isStreaming: true } };
    });
  });
  const page = await fetchSessionContextPage("s1", { leafId: "a2", before: "u3", tail: 2 });
  assert.equal(page.context.messages.length, 0);
  assert.deepEqual(calls, [
    {
      session: "s1",
      leafId: "a2",
      before: "u3",
      tail: 2,
    },
  ]);
  const state = await fetchAgentRunningState("s1");
  assert.equal(state.running, true);
  assert.equal(state.state.isStreaming, true);

  // A failed state poll answers null (the callers keep polling).
  boundService((transport) => {
    transport.fail("sessions.state", { code: "io", message: "boom" });
  });
  assert.equal(await fetchAgentRunningState("s1"), null);
});

test("sessions.lease renews and reports the host's relay count", async () => {
  boundService((transport) => {
    transport.on("sessions.lease", (args) => {
      assert.deepEqual(args, { session: "s1" });
      return { renewed: 1 };
    });
  });
  assert.deepEqual(await renewSessionLease("s1"), { renewed: 1 });

  boundService((transport) => {
    transport.fail("sessions.lease", { code: "io", message: "boom" });
  });
  assert.equal(await renewSessionLease("s1"), null, "a failed renewal answers null, not a fake 0");
});

test("createAgentSession surfaces the host's refusal without inventing success", async () => {
  boundService((transport) => {
    transport.fail("agent.create", { code: "unknown_op", message: "unknown operation sessions.create" });
  });
  const refused = await createAgentSession({ cwd: "/w", type: "ensure_session" });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 500);
  assert.match(refused.error ?? "", /sessions\.create/, "the honest unknown-op error reaches the composer");
});

test("createAgentSession preserves the prompt trichotomy's details", async () => {
  // A first prompt sent through agent.create that ends UNKNOWN answers
  // op_failed with error.details {code:"prompt_unknown", accepted:null,
  // sessionId} (src-tauri pi_ipc). The details MUST survive the service
  // mapping: the caller needs the session identity to query the state
  // instead of re-sending, and prompt_rejected's accepted:false to restore
  // the draft. MockTransport.fail carries no details, so this drives the
  // transport interface directly.
  const failing = {
    send: (request) => Promise.resolve({
      v: 1,
      id: request.id,
      ok: false,
      error: {
        code: "op_failed",
        message: "the prompt's outcome is unknown; query the state before resending",
        retryable: false,
        details: { code: "prompt_unknown", accepted: null, sessionId: "s-42" },
      },
    }),
    subscribe: () => () => {},
  };
  bindSessionViewService(new IpcClient(failing));
  const unknown = await createAgentSession({ cwd: "/w", type: "prompt", message: "hi" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 500);
  assert.deepEqual(unknown.details, { code: "prompt_unknown", accepted: null, sessionId: "s-42" });

  const rejected = {
    send: (request) => Promise.resolve({
      v: 1,
      id: request.id,
      ok: false,
      error: {
        code: "op_failed",
        message: "the child refused the prompt",
        retryable: false,
        details: { code: "prompt_rejected", accepted: false },
      },
    }),
    subscribe: () => () => {},
  };
  bindSessionViewService(new IpcClient(rejected));
  const refused = await createAgentSession({ cwd: "/w", type: "prompt", message: "" });
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.details, { code: "prompt_rejected", accepted: false });
});
