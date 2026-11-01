import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { resolve } from "node:path";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(process.cwd()) }, interopDefault: true });
const { detectTransport, overrideTransportForTests } = await jiti.import("./transport.ts");
const { IpcClient } = await jiti.import("../ipc/client.ts");
const { bindProviderAuthLogin, subscribeOAuthLogin } = await jiti.import("./provider-auth-login.ts");
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function waitFor(predicate) { for (let i = 0; i < 100 && !predicate(); i++) await tick(); assert.ok(predicate(), "timed out"); }
function harness() {
  const old = globalThis.window;
  const callbacks = new Map();
  const subscriptions = [];
  const calls = [];
  let next = 0;
  globalThis.window = { __TAURI_INTERNALS__: {
    transformCallback(fn) { const id = ++next; callbacks.set(id, fn); return id; },
    unregisterCallback() {},
    invoke(command, args) {
      calls.push({ command, args });
      if (command === "pi_ipc_login_stream") {
        let finish;
        const promise = new Promise((resolve) => { finish = resolve; });
        subscriptions.push({ callback: callbacks.get(next), finish, args, index: 0 });
        return promise;
      }
      return Promise.resolve({ ok: true });
    },
  } };
  overrideTransportForTests(undefined);
  bindProviderAuthLogin(new IpcClient(detectTransport().transport));
  return { subscriptions, calls, restore() { globalThis.window = old; overrideTransportForTests(undefined); } };
}
function frame(sub, message) { sub.callback({ index: sub.index++, message }); }
const snapshot = (id, flow, task) => ({ subscriptionId: id, epoch: 1, seq: 1, kind: "snapshot", payload: { flowId: flow, taskHandle: task } });

test("ACK-only retains original task for reconnect and does not create a snapshot", async () => {
  const h = harness();
  try {
    const events = [], errors = [];
    const stop = subscribeOAuthLogin("ack-only-fixture", (e) => events.push(e), (e) => errors.push(e));
    await waitFor(() => h.subscriptions.length === 1);
    h.subscriptions[0].finish({ subscriptionId: "s1", flowId: "f1", taskHandle: "t1" });
    await tick();
    assert.deepEqual(events, []);
    stop();
    const stop2 = subscribeOAuthLogin("ack-only-fixture", () => {}, () => {});
    await waitFor(() => h.subscriptions.length === 2);
    assert.equal(h.subscriptions[1].args.flowId, "f1");
    assert.equal(h.subscriptions[1].args.taskHandle, "t1");
    stop2();
    h.subscriptions[1].finish({ subscriptionId: "s2", flowId: "f1", taskHandle: "t1" });
    assert.equal(errors.length, 0);
  } finally { h.restore(); }
});

test("ACK without snapshot times out observation without forgetting task", async () => {
  const h = harness();
  const oldSet = globalThis.setTimeout;
  let deadline;
  globalThis.setTimeout = (fn, ms, ...args) => { if (ms === 35_000) { deadline = fn; return oldSet(() => {}, 35_000); } return oldSet(fn, ms, ...args); };
  try {
    const errors = [];
    const stop = subscribeOAuthLogin("missing-snapshot-fixture", () => assert.fail("no event"), (e) => errors.push(e));
    await waitFor(() => h.subscriptions.length === 1);
    h.subscriptions[0].finish({ subscriptionId: "s", flowId: "f", taskHandle: "t" });
    await tick();
    assert.equal(typeof deadline, "function");
    deadline();
    assert.equal(errors.length, 1);
    stop();
    const reconnect = subscribeOAuthLogin("missing-snapshot-fixture", () => {}, () => {});
    await waitFor(() => h.subscriptions.length === 2);
    assert.equal(h.subscriptions[1].args.taskHandle, "t");
    reconnect(); h.subscriptions[1].finish({ subscriptionId: "s2", flowId: "f", taskHandle: "t" });
  } finally { globalThis.setTimeout = oldSet; h.restore(); }
});

test("matching snapshot before ACK is delivered and acknowledged only after binding", async () => {
  const h = harness();
  try {
    const errors = [];
    const stop = subscribeOAuthLogin("snapshot-first-fixture", () => {}, (error) => errors.push(error));
    await waitFor(() => h.subscriptions.length === 1);
    frame(h.subscriptions[0], snapshot("s", "f", "t"));
    assert.equal(h.calls.filter((c) => c.args?.request?.op === "auth.ackLogin").length, 0);
    h.subscriptions[0].finish({ subscriptionId: "s", flowId: "f", taskHandle: "t" });
    await waitFor(() => h.calls.some((c) => c.args?.request?.op === "auth.ackLogin"));
    assert.deepEqual(h.calls.find((c) => c.args?.request?.op === "auth.ackLogin").args.request.args, { subscriptionId: "s", epoch: 1, seq: 1 });
    assert.equal(errors.length, 0);
    stop();
  } finally { h.restore(); }
});

test("snapshot before ACK is held until matching ACK; conflict preserves uncertainty", async () => {
  const h = harness();
  try {
    const events = [], errors = [];
    const stop = subscribeOAuthLogin("conflict-fixture", (e) => events.push(e), (e) => errors.push(e));
    await waitFor(() => h.subscriptions.length === 1);
    frame(h.subscriptions[0], snapshot("s1", "f1", "t1"));
    assert.equal(h.calls.filter((c) => c.args?.request?.op === "auth.ackLogin").length, 0);
    h.subscriptions[0].finish({ subscriptionId: "s1", flowId: "other", taskHandle: "t1" });
    await waitFor(() => errors.length > 0);
    assert.deepEqual(events, []);
    stop();
    const stop2 = subscribeOAuthLogin("conflict-fixture", () => assert.fail("no new flow"), () => {});
    await tick();
    assert.equal(h.subscriptions.length, 1, "conflict must never silently restart OAuth");
    stop2();
  } finally { h.restore(); }
});

test("late ACK cannot replace newer observation and early cancel targets only its own task", async () => {
  const h = harness();
  try {
    const first = subscribeOAuthLogin("late-fixture", () => {}, () => {});
    await waitFor(() => h.subscriptions.length === 1);
    h.subscriptions[0].finish({ subscriptionId: "s0", flowId: "f0", taskHandle: "t0" });
    await tick(); first();
    const old = subscribeOAuthLogin("late-fixture", () => {}, () => {});
    await waitFor(() => h.subscriptions.length === 2);
    old.cancel(); old();
    const newer = subscribeOAuthLogin("late-fixture", () => {}, () => {});
    await waitFor(() => h.subscriptions.length === 3);
    h.subscriptions[2].finish({ subscriptionId: "s2", flowId: "f0", taskHandle: "t0" });
    h.subscriptions[1].finish({ subscriptionId: "s1", flowId: "f0", taskHandle: "t0" });
    await tick();
    assert.equal(h.calls.filter((c) => c.args?.request?.op === "auth.loginCancel").length, 1);
    assert.equal(h.calls.find((c) => c.args?.request?.op === "auth.loginCancel").args.request.args.taskHandle, "t0");
    newer();
  } finally { h.restore(); }
});

test("a disposed older observer ACK cannot overwrite a newer completed-and-restarted task", () => {
  const subscriptions = [];
  bindProviderAuthLogin(new IpcClient({
    send: async () => ({}),
    subscribe: (_op, args, message, error, subscribed) => { subscriptions.push({ args, message, error, subscribed }); return () => {}; },
  }));
  const provider = "generation-fixture";
  let stop = subscribeOAuthLogin(provider, () => {}, () => {});
  subscriptions[0].subscribed({ subscriptionId: "a", flowId: "old", taskHandle: "old-task" });
  stop();
  const delayed = subscribeOAuthLogin(provider, () => {}, () => {});
  delayed();
  stop = subscribeOAuthLogin(provider, () => {}, () => {});
  subscriptions[2].subscribed({ subscriptionId: "c", flowId: "old", taskHandle: "old-task" });
  subscriptions[2].message(snapshot("c", "old", "old-task"));
  subscriptions[2].message({ subscriptionId: "c", epoch: 1, seq: 2, kind: "terminal", payload: { type: "success" } });
  stop();
  stop = subscribeOAuthLogin(provider, () => {}, () => {});
  subscriptions[3].subscribed({ subscriptionId: "d", flowId: "new", taskHandle: "new-task" });
  subscriptions[1].subscribed({ subscriptionId: "b", flowId: "old", taskHandle: "old-task" });
  stop();
  const again = subscribeOAuthLogin(provider, () => {}, () => {});
  assert.equal(subscriptions[4].args.taskHandle, "new-task");
  again();
});

test("validated recovery reset renders current input and retains original task", async () => {
  const h = harness();
  try {
    const events = [], errors = [];
    const stop = subscribeOAuthLogin("reset-fixture", (event) => events.push(event), (error) => errors.push(error));
    await waitFor(() => h.subscriptions.length === 1);
    h.subscriptions[0].finish({ subscriptionId: "s", flowId: "f", taskHandle: "t" });
    await tick();
    frame(h.subscriptions[0], snapshot("s", "f", "t"));
    await tick();
    frame(h.subscriptions[0], { subscriptionId: "s", epoch: 1, seq: 2, kind: "reset", payload: { events: [{ type: "prompt_request", message: "Fake code", placeholder: null, token: "live-token" }] } });
    await waitFor(() => events.length === 1);
    assert.equal(events[0].token, "live-token");
    assert.equal(errors.length, 0);
    stop();
    const reconnect = subscribeOAuthLogin("reset-fixture", () => {}, () => {});
    await waitFor(() => h.subscriptions.length === 2);
    assert.equal(h.subscriptions[1].args.taskHandle, "t");
    reconnect(); h.subscriptions[1].finish({ subscriptionId: "s2", flowId: "f", taskHandle: "t" });
  } finally { h.restore(); }
});

test("early explicit cancellation uses ACK identity once even when snapshot is absent", async () => {
  const h = harness();
  try {
    const stop = subscribeOAuthLogin("early-cancel-fixture", () => {}, () => {});
    await waitFor(() => h.subscriptions.length === 1);
    stop.cancel(); stop();
    h.subscriptions[0].finish({ subscriptionId: "s", flowId: "f", taskHandle: "t" });
    await waitFor(() => h.calls.some((c) => c.args?.request?.op === "auth.loginCancel"));
    assert.equal(h.calls.filter((c) => c.args?.request?.op === "auth.loginCancel").length, 1);
    assert.equal(h.calls.find((c) => c.args?.request?.op === "auth.loginCancel").args.request.args.taskHandle, "t");
  } finally { h.restore(); }
});

test("invalid epoch, subscription, sequence and pre-snapshot terminal cannot succeed or extend liveness", async () => {
  const realSetTimeout = globalThis.setTimeout;
  let livenessArms = 0;
  globalThis.setTimeout = (fn, ms, ...args) => { if (ms === 35_000) livenessArms++; return realSetTimeout(fn, ms, ...args); };
  try {
    const cases = [
      { subscriptionId: "s", epoch: 2, seq: 2, kind: "heartbeat", payload: null },
      { subscriptionId: "other", epoch: 1, seq: 2, kind: "terminal", payload: { type: "success" } },
      { subscriptionId: "s", epoch: 1, seq: 3, kind: "terminal", payload: { type: "success" } },
      { subscriptionId: "s", epoch: 1, seq: 1, kind: "terminal", payload: { type: "success" } },
      { subscriptionId: "s", epoch: 1, seq: 1, kind: "heartbeat", payload: null },
    ];
    for (let i = 0; i < cases.length; i++) {
      const h = harness();
      try {
        const events = [], errors = [];
        const stop = subscribeOAuthLogin(`invalid-fixture-${i}`, (e) => events.push(e), (e) => errors.push(e));
        await waitFor(() => h.subscriptions.length === 1);
        h.subscriptions[0].finish({ subscriptionId: "s", flowId: `f${i}`, taskHandle: `t${i}` });
        await tick();
        if (i !== 3) { frame(h.subscriptions[0], snapshot("s", `f${i}`, `t${i}`)); await tick(); }
        const before = livenessArms;
        frame(h.subscriptions[0], cases[i]);
        await waitFor(() => errors.length > 0);
        assert.equal(livenessArms, before);
        assert.ok(!events.some((e) => e.type === "success"));
        stop();
        const reconnect = subscribeOAuthLogin(`invalid-fixture-${i}`, () => {}, () => {});
        await waitFor(() => h.subscriptions.length === 2);
        assert.equal(h.subscriptions[1].args.taskHandle, `t${i}`);
        reconnect();
        h.subscriptions[1].finish({ subscriptionId: "new", flowId: `f${i}`, taskHandle: `t${i}` });
      } finally { h.restore(); }
    }
  } finally { globalThis.setTimeout = realSetTimeout; }
});
