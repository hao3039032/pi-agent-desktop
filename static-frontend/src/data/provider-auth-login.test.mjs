/**
 * Tests for the provider-auth OAuth login IPC service (the static build's
 * alias target for lib/provider-auth-login.ts): the ops it calls, the
 * stream frames it handles, the error surfacing, and the no-HTTP contract.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const jiti = createJiti(import.meta.url, {
  alias: { "@": repoRoot },
  interopDefault: true,
});

const { bindProviderAuthLogin, subscribeOAuthLogin, submitOAuthLoginCode } =
  await jiti.import("./provider-auth-login.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

function bound(handlers) {
  const mock = new MockTransport();
  if (handlers) {
    for (const [op, impl] of Object.entries(handlers)) {
      mock.on(op, impl);
    }
  }
  const client = new IpcClient(mock);
  bindProviderAuthLogin(client);
  return mock;
}

test("subscribeOAuthLogin opens auth.loginStream and receives frames", async () => {
  const mock = bound({
    "auth.loginStream": (args) => {
      assert.deepEqual(args, { provider: "anthropic" });
      return null;
    },
  });

  const events = [];
  const errors = [];
  const dispose = subscribeOAuthLogin(
    "anthropic",
    (event) => events.push(event),
    (err) => errors.push(err),
  );

  mock.emit({ subscriptionId: "sub-1", epoch: 1, seq: 1, kind: "snapshot", payload: { flowId: "f", taskHandle: "t" } });
  mock.emit({
    subscriptionId: "sub-1",
    epoch: 1,
    seq: 2,
    kind: "event",
    payload: {
      type: "auth",
      url: "https://auth.example.com/login",
      instructions: "Sign in and copy redirect code",
      token: "anthropic-tok-1",
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "auth");
  assert.equal(events[0].url, "https://auth.example.com/login");
  assert.equal(events[0].token, "anthropic-tok-1");
  assert.equal(errors.length, 0);

  mock.emit({
    subscriptionId: "sub-1",
    epoch: 1,
    seq: 3,
    kind: "terminal",
    payload: { type: "success" },
  });

  assert.equal(events.length, 2);
  assert.equal(events[1].type, "success");

  dispose();
});

test("reconnect binds the original task after observation loss and clears only on terminal", () => {
  const subscriptions = [];
  const transport = {
    send: async (request) => ({ v: 1, id: request.id, ok: true, data: {} }),
    subscribe: (_op, args, onMessage, onError) => {
      subscriptions.push({ args, onMessage, onError });
      return () => {};
    },
  };
  bindProviderAuthLogin(new IpcClient(transport));
  const events = [];
  let dispose = subscribeOAuthLogin("fixture-reconnect", (event) => events.push(event), () => {});
  subscriptions[0].onMessage({ subscriptionId: "one", epoch: 1, seq: 1, kind: "snapshot", payload: { flowId: "flow-1", taskHandle: "task-1" } });
  subscriptions[0].onMessage({ subscriptionId: "one", epoch: 1, seq: 2, kind: "heartbeat", payload: null });
  assert.deepEqual(events, []);
  dispose();
  dispose = subscribeOAuthLogin("fixture-reconnect", (event) => events.push(event), () => {});
  assert.deepEqual(subscriptions[1].args, { provider: "fixture-reconnect", flowId: "flow-1", taskHandle: "task-1" });
  subscriptions[1].onMessage({ subscriptionId: "two", epoch: 1, seq: 1, kind: "snapshot", payload: { flowId: "flow-1", taskHandle: "task-1" } });
  subscriptions[1].onMessage({ subscriptionId: "two", epoch: 1, seq: 2, kind: "unknown", payload: { type: "error", message: "outcome unknown" } });
  dispose();
  dispose = subscribeOAuthLogin("fixture-reconnect", (event) => events.push(event), () => {});
  assert.equal(subscriptions[2].args.taskHandle, "task-1");
  subscriptions[2].onMessage({ subscriptionId: "three", epoch: 1, seq: 1, kind: "snapshot", payload: { flowId: "flow-1", taskHandle: "task-1" } });
  subscriptions[2].onMessage({ subscriptionId: "three", epoch: 1, seq: 2, kind: "terminal", payload: { type: "success" } });
  dispose();
  dispose = subscribeOAuthLogin("fixture-reconnect", () => {}, () => {});
  assert.deepEqual(subscriptions[3].args, { provider: "fixture-reconnect" });
  dispose();
});

test("bind failure preserves the started task for reconnect", () => {
  const subscriptions = [];
  bindProviderAuthLogin(new IpcClient({
    send: async () => ({}),
    subscribe: (_op, args, onMessage, onError) => { subscriptions.push({ args, onMessage, onError }); return () => {}; },
  }));
  const dispose = subscribeOAuthLogin("fixture-bind-error", () => {}, () => {});
  subscriptions[0].onError({ code: "io", message: "observer unavailable", retryable: false, details: { subscriptionId: "s-bind", flowId: "f-bind", taskHandle: "t-bind" } });
  dispose();
  const reconnect = subscribeOAuthLogin("fixture-bind-error", () => {}, () => {});
  assert.deepEqual(subscriptions[1].args, { provider: "fixture-bind-error", flowId: "f-bind", taskHandle: "t-bind" });
  reconnect();
});

test("explicit cancel targets the original task while ordinary detach does not", async () => {
  const requests = [];
  let deliver;
  bindProviderAuthLogin(new IpcClient({
    send: async (request) => { requests.push(request); return { v: 1, id: request.id, ok: true, data: {} }; },
    subscribe: (_op, _args, onMessage) => { deliver = onMessage; return () => {}; },
  }));
  const dispose = subscribeOAuthLogin("fixture-cancel", () => {}, () => {});
  deliver({ subscriptionId: "s", epoch: 1, seq: 1, kind: "snapshot", payload: { flowId: "f-cancel", taskHandle: "t-cancel" } });
  dispose();
  assert.equal(requests.length, 0);
  dispose.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests[0].op, "auth.loginCancel");
  assert.deepEqual(requests[0].args, { taskHandle: "t-cancel" });
});

test("early explicit cancel waits for task identity before detaching", async () => {
  let acknowledge;
  let detached = false;
  const requests = [];
  bindProviderAuthLogin(new IpcClient({
    send: async (request) => { requests.push(request); return { v: 1, id: request.id, ok: true, data: {} }; },
    subscribe: (_op, _args, _onMessage, _onError, onSubscribe) => { acknowledge = onSubscribe; return () => { detached = true; }; },
  }));
  const dispose = subscribeOAuthLogin("fixture-early-cancel", () => {}, () => {});
  dispose.cancel();
  dispose();
  assert.equal(detached, false);
  acknowledge({ subscriptionId: "s", flowId: "f-early", taskHandle: "t-early" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(detached, true);
  assert.deepEqual(requests[0].args, { taskHandle: "t-early" });
});

test("submitOAuthLoginCode sends auth.loginManualCode with trimmed code", async () => {
  const calls = [];
  bound({
    "auth.loginManualCode": (args) => {
      calls.push(args);
      return { ok: true };
    },
  });

  await submitOAuthLoginCode("anthropic", "anthropic-uuid-1", "  auth-code-123  ");
  assert.deepEqual(calls, [
    { provider: "anthropic", token: "anthropic-uuid-1", code: "auth-code-123" },
  ]);
});

test("submitOAuthLoginCode surfaces protocol errors verbatim", async () => {
  const mock = new MockTransport();
  mock.fail("auth.loginManualCode", {
    code: "not_found",
    message: "No pending login for token",
  });
  const client = new IpcClient(mock);
  bindProviderAuthLogin(client);

  await assert.rejects(
    submitOAuthLoginCode("anthropic", "bad-token", "code"),
    (err) => err instanceof Error && err.message === "No pending login for token",
  );
});

test("the login IPC service never issues raw HTTP or EventSource calls", async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), "provider-auth-login.ts"),
    "utf8",
  );
  assert.equal(/\bfetch\s*\(/.test(source), false, "no fetch in static provider-auth-login");
  assert.equal(/EventSource/.test(source), false, "no EventSource in static provider-auth-login");
  assert.equal(source.includes("`/api"), false, "no templated /api URLs at runtime");
  assert.equal(source.includes('"/api'), false, "no literal /api URLs at runtime");
});
