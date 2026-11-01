// Proposed SDK/host contract fixture only: this is not the installed pi RPC
// implementation and must not be used as evidence that production supports it.
import test from "node:test";
import assert from "node:assert/strict";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Models atomic registration and cancellation in the session-owning process.
function summaryFixture() {
  let active;
  let leaf = "source";
  let laterRunAborted = false;
  return {
    start(id, target, provider) {
      if (active) throw new Error("busy");
      const operation = { id, aborted: false };
      active = operation;
      const result = (async () => {
        const summary = await provider.promise;
        if (operation.aborted) return { cancelled: true, aborted: true };
        leaf = target;
        return { cancelled: false, aborted: false, summary };
      })().finally(() => { if (active === operation) active = undefined; });
      return result;
    },
    stop(id) {
      if (!active || active.id !== id) return { matched: false };
      active.aborted = true;
      return { matched: true };
    },
    startLaterRun() { laterRunAborted = false; },
    get leaf() { return leaf; },
    get laterRunAborted() { return laterRunAborted; },
  };
}

test("contract fixture: Stop targets registered summary and preserves leaf", async () => {
  const session = summaryFixture();
  const provider = deferred();
  const result = session.start("one", "target", provider);
  assert.deepEqual(session.stop("other"), { matched: false });
  assert.deepEqual(session.stop("one"), { matched: true });
  provider.resolve("real provider output in production");
  assert.deepEqual(await result, { cancelled: true, aborted: true });
  assert.equal(session.leaf, "source");
});

test("contract fixture: completion wins over late Stop, including a later summary", async () => {
  const session = summaryFixture();
  const first = deferred();
  const completed = session.start("one", "first", first);
  first.resolve("summary");
  assert.deepEqual(await completed, { cancelled: false, aborted: false, summary: "summary" });
  session.startLaterRun();
  assert.deepEqual(session.stop("one"), { matched: false });
  assert.equal(session.laterRunAborted, false);
  const second = deferred();
  const next = session.start("two", "second", second);
  assert.deepEqual(session.stop("one"), { matched: false });
  second.resolve("next");
  assert.deepEqual(await next, { cancelled: false, aborted: false, summary: "next" });
  assert.equal(session.leaf, "second");
});

test("contract fixture: delegated session actions retain source and notify only after target succeeds", async () => {
  for (const action of ["newSession", "fork", "switchSession"]) {
    const source = { id: "source" };
    const registry = new Map([[source.id, source]]);
    const events = [];
    const delegate = async (outcome) => {
      if (outcome.cancelled) return outcome;
      const target = { id: outcome.id };
      registry.set(target.id, target);
      events.push({ type: "session_replaced", sessionId: target.id });
      return { cancelled: false };
    };
    assert.deepEqual(await delegate({ cancelled: true }), { cancelled: true }, action);
    assert.deepEqual(events, [], action);
    assert.deepEqual(await delegate({ id: `${action}-target` }), { cancelled: false }, action);
    assert.equal(registry.get("source"), source, action);
    assert.equal(events[0].sessionId, `${action}-target`, action);
  }
});
