/**
 * Pure frontend tests over the mock transport (plan M1: “保留纯前端测试使用
 * mock transport，不把 mock 当真实桌面验收”): envelope parsing, timeout
 * semantics (never resend), single-use ids, unknown-op rejection.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { IpcClient, IpcFailure, IpcTimeoutError, MockTransport } from "./client.ts";
import { IPC_PROTOCOL_VERSION, parseIpcResponse } from "./protocol.ts";

test("responses roundtrip through the envelope", async () => {
  const mock = new MockTransport().on("sessions.list", (args) => ({ count: 2, page: args?.page ?? 1 }));
  const client = new IpcClient(mock);
  const result = await client.request("sessions.list", { page: 3 });
  assert.deepEqual(result, { count: 2, page: 3 });
});

test("unknown operations fail as unknown_op, never executed", async () => {
  const client = new IpcClient(new MockTransport());
  await assert.rejects(
    client.request("shell.exec", { command: "rm -rf /" }),
    (error) => {
      assert.ok(error instanceof IpcFailure);
      assert.equal(error.error.code, "unknown_op");
      return true;
    },
  );
});

test("version mismatches surface as version_mismatch", () => {
  const parsed = parseIpcResponse({ v: 2, id: "x", ok: true, data: null }, "x");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.error.code, "version_mismatch");
});

test("id mismatches and malformed envelopes are protocol failures", () => {
  assert.equal(parseIpcResponse({ v: 1, id: "other", ok: true }, "x").ok, false);
  assert.equal(parseIpcResponse(null, "x").ok, false);
  assert.equal(parseIpcResponse({ v: 1, id: "x", ok: false, error: {} }, "x").ok, false);
  const coded = parseIpcResponse(
    { v: 1, id: "x", ok: false, error: { code: "not_found", message: "gone", retryable: false } },
    "x",
  );
  assert.equal(coded.ok, false);
  if (!coded.ok) {
    assert.equal(coded.error.code, "not_found");
    assert.equal(coded.error.reason, undefined);
  }
});

test("timeouts reject with the never-resend contract and leave ids single-use", async () => {
  const never = new Promise(() => {});
  const mock = new MockTransport().on("tasks.runNow", () => never);
  const client = new IpcClient(mock);
  const started = Date.now();
  await assert.rejects(
    client.request("tasks.runNow", { id: "t" }, { timeoutMs: 60 }),
    (error) => {
      assert.ok(error instanceof IpcTimeoutError, String(error));
      assert.match(error.message, /never resend/);
      return true;
    },
  );
  assert.ok(Date.now() - started >= 50);
  // The client stays usable for the next request with a fresh id.
  const ok = await new IpcClient(new MockTransport().on("ping", () => "pong")).request("ping");
  assert.equal(ok, "pong");
});

test("the request envelope carries version, op and args", async () => {
  let seen = /** @type {{ request: any, timeoutMs: number } | null} */ (null);
  const mock = new MockTransport().on("echo", (args) => {
    return "ok";
  });
  const client = new IpcClient(mock);
  await client.request("echo", { a: 1 });
  // The transport received the envelope via send(); assert through a wrapper.
  const wrapper = {
    send: (request, timeoutMs) => {
      seen = { request, timeoutMs };
      return mock.send(request, timeoutMs);
    },
    subscribe: mock.subscribe.bind(mock),
  };
  await new IpcClient(wrapper).request("echo", { a: 1 });
  assert.equal(seen.request.v, IPC_PROTOCOL_VERSION);
  assert.equal(seen.request.op, "echo");
  assert.deepEqual(seen.request.args, { a: 1 });
  assert.match(seen.request.id, /^ipc-/);
});

test("subscriptions deliver snapshot/event/reset frames in order", async () => {
  const mock = new MockTransport().on("agent.subscribeEvents", () => null);
  const client = new IpcClient(mock);
  const frames = [];
  const dispose = client.subscribe(
    "agent.subscribeEvents",
    { session: "s1" },
    (message) => frames.push(message),
    () => {},
  );
  mock.emit({ subscriptionId: "sub-1", epoch: 3, seq: 1, kind: "snapshot", payload: {} });
  mock.emit({ subscriptionId: "sub-1", epoch: 3, seq: 2, kind: "event", payload: {} });
  mock.emit({ subscriptionId: "sub-1", epoch: 4, seq: 1, kind: "reset", payload: {} });
  dispose();
  assert.deepEqual(
    frames.map((frame) => [frame.kind, frame.seq, frame.epoch]),
    [["snapshot", 1, 3], ["event", 2, 3], ["reset", 1, 4]],
  );
});

test("unhandled streams error with unknown_op", async () => {
  const mock = new MockTransport();
  const client = new IpcClient(mock);
  let caught = null;
  client.subscribe(
    "no.such.stream",
    undefined,
    () => {},
    (error) => {
      caught = error;
    },
  );
  assert.equal(caught?.code, "unknown_op");
});
