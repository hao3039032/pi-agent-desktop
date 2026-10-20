import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  SUBAGENT_RPC_PROTOCOL_VERSION,
  SUBAGENT_RPC_REQUEST_EVENT,
  SUBAGENT_RPC_REPLY_EVENT_PREFIX,
  SubagentRpcTimeoutError,
  callSubagentRpc,
  parseSubagentRpcReply,
  subagentRpcErrorStatus,
} = await jiti.import("./pi-subagents-rpc.ts");

/** An event bus that records subscriptions and lets the test emit on any channel. */
function createFakeBus() {
  const handlers = new Map();
  const requests = [];
  return {
    requests,
    liveHandlerCount: () => handlers.size,
    emit(channel, data) {
      if (channel === SUBAGENT_RPC_REQUEST_EVENT) requests.push(data);
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    /** Deliver a reply without going through emit(), to test isolation. */
    deliver(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => {
        const remaining = (handlers.get(channel) ?? []).filter((item) => item !== handler);
        if (remaining.length === 0) handlers.delete(channel);
        else handlers.set(channel, remaining);
      };
    },
  };
}

test("callSubagentRpc sends a versioned request and settles on the matching reply", async () => {
  const bus = createFakeBus();
  const pending = callSubagentRpc(bus, "ping", undefined, { requestId: "req-1" });
  const request = await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (bus.requests.length > 0) { clearInterval(timer); resolve(bus.requests[0]); }
    }, 1);
  });

  assert.equal(request.version, SUBAGENT_RPC_PROTOCOL_VERSION);
  assert.equal(request.requestId, "req-1");
  assert.equal(request.method, "ping");
  assert.equal("params" in request, false);

  bus.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}req-1`, {
    version: 1,
    requestId: "req-1",
    method: "ping",
    success: true,
    data: { version: 1, methods: ["ping"] },
  });
  const reply = await pending;
  assert.equal(reply.requestId, "req-1");
  assert.deepEqual(reply.data, { version: 1, methods: ["ping"] });
  // The listener is gone once the call settled.
  assert.equal(bus.liveHandlerCount(), 0);
});

test("callSubagentRpc forwards params and maps error replies", async () => {
  const bus = createFakeBus();
  const settled = bus.on(SUBAGENT_RPC_REQUEST_EVENT, (request) => {
    bus.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      method: request.method,
      success: false,
      error: { code: "not_found", message: "Async run 'x' was not found in the active session." },
    });
  });
  const reply = await callSubagentRpc(bus, "stop", { id: "x" }, { requestId: "req-2" });
  settled();
  assert.equal(reply.error.code, "not_found");
  assert.match(reply.error.message, /not found/);
  assert.equal(bus.requests[0].params.id, "x");
  assert.equal(bus.liveHandlerCount(), 0);
});

test("concurrent requests are correlated by requestId", async () => {
  const bus = createFakeBus();
  const a = callSubagentRpc(bus, "status", undefined, { requestId: "a" });
  const b = callSubagentRpc(bus, "status", undefined, { requestId: "b" });
  assert.equal(bus.liveHandlerCount(), 2);

  // Replies arrive out of order and interleaved with noise.
  bus.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}b`, { version: 1, requestId: "b", success: true, data: { text: "b" } });
  bus.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}a`, { version: 1, requestId: "a", success: true, data: { text: "a" } });

  assert.equal((await a).data.text, "a");
  assert.equal((await b).data.text, "b");
  assert.equal(bus.liveHandlerCount(), 0);
});

test("malformed or foreign replies are ignored until the real one arrives", async () => {
  const bus = createFakeBus();
  const pending = callSubagentRpc(bus, "status", undefined, { requestId: "mine", timeoutMs: 5_000 });

  const junk = [
    "string",
    null,
    42,
    { requestId: "mine" }, // no success
    { requestId: "mine", success: "true" }, // success not boolean
    { requestId: "mine", success: false }, // error without shape
    { requestId: "mine", success: false, error: { code: 1, message: "x" } },
    { requestId: "other", success: true, data: {} }, // foreign id on this channel
  ];
  for (const payload of junk) bus.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}mine`, payload);
  // Still waiting, exactly one listener.
  assert.equal(bus.liveHandlerCount(), 1);

  bus.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}mine`, { version: 1, requestId: "mine", success: true, data: { ok: 1 } });
  assert.deepEqual((await pending).data, { ok: 1 });
  assert.equal(bus.liveHandlerCount(), 0);
});

test("a request that nothing answers rejects with a timeout and removes its listener", async (t) => {
  const bus = createFakeBus();
  const pending = callSubagentRpc(bus, "ping", undefined, { timeoutMs: 20, requestId: "lonely" });
  const rejection = pending.then(
    () => { throw new Error("should not settle"); },
    (error) => error,
  );
  const error = await rejection;
  assert.ok(error instanceof SubagentRpcTimeoutError);
  assert.match(error.message, /ping/);
  assert.equal(bus.liveHandlerCount(), 0);
  assert.equal(bus.requests[0].requestId, "lonely");
  t.diagnostic(`timed out after 20ms as configured`);
});

test("parseSubagentRpcReply validates the documented reply shape", () => {
  const good = parseSubagentRpcReply(
    { version: 1, requestId: "r", method: "status", success: true, data: { text: "x" } },
    "r",
  );
  assert.deepEqual(good, { requestId: "r", method: "status", data: { text: "x" } });

  const failed = parseSubagentRpcReply(
    { version: 1, requestId: "r", success: false, error: { code: "invalid_state", message: "run is paused" } },
    "r",
  );
  assert.deepEqual(failed, { requestId: "r", error: { code: "invalid_state", message: "run is paused" } });

  assert.equal(parseSubagentRpcReply({ version: 1, requestId: "r", success: true }, "other"), null);
  // A reply without the protocol version is not a v1 reply: ignored, so the
  // call keeps waiting for the real one instead of settling on a guess.
  assert.equal(parseSubagentRpcReply({ requestId: "r", success: true, data: { text: "x" } }, "r"), null);
  assert.equal(parseSubagentRpcReply({ version: 2, requestId: "r", success: true, data: { text: "x" } }, "r"), null);
  assert.equal(parseSubagentRpcReply([], "r"), null);
  assert.equal(parseSubagentRpcReply(undefined, "r"), null);
});

test("subagentRpcErrorStatus maps package error codes to HTTP statuses", () => {
  assert.equal(subagentRpcErrorStatus("invalid_params"), 400);
  assert.equal(subagentRpcErrorStatus("unsupported_version"), 400);
  assert.equal(subagentRpcErrorStatus("not_found"), 404);
  assert.equal(subagentRpcErrorStatus("invalid_state"), 409);
  assert.equal(subagentRpcErrorStatus("no_active_session"), 409);
  assert.equal(subagentRpcErrorStatus("execution_failed"), 500);
  assert.equal(subagentRpcErrorStatus("something_new"), 500);
});
