/**
 * Tests for the static session-list service
 * (static-frontend/src/data/session-list-service.ts): the IPC shapes for
 * sessions.list / cwd.home, and the running-set stream's frame adaptation
 * (snapshot/event frames → RunningSetFrame) including the 1.5s resubscribe
 * the HTTP EventSource version carried.
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

const { fetchSessionList, fetchHomeDirectory, subscribeRunningSessions, bindSessionListService } =
  await jiti.import("./session-list-service.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

test("the catalogue rides sessions.list argument-free with the sidebar payload shape", async () => {
  const calls = [];
  const mock = new MockTransport().on("sessions.list", (args) => {
    calls.push(args);
    return {
      sessions: [{ id: "s1", name: "One" }],
      sessionListVersion: 3,
      runningSessionIds: ["s1"],
      completionNotificationSuppressedSessionIds: [],
      chatWorkspaceCwd: "/tmp/chats",
    };
  });
  bindSessionListService(new IpcClient(mock));
  // summary/force are transport modes, not host args: the host catalogue
  // always scans.
  const data = await fetchSessionList({ summary: true, force: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], undefined);
  assert.equal(data.sessionListVersion, 3);
  assert.equal(data.sessions.length, 1);
  assert.deepEqual(data.runningSessionIds, ["s1"]);
});

test("a catalogue failure rejects with the host's message", async () => {
  const mock = new MockTransport().fail("sessions.list", { code: "io", message: "scan failed" });
  bindSessionListService(new IpcClient(mock));
  await assert.rejects(fetchSessionList(), /scan failed/);
});

test("the home directory rides cwd.home and stays null on failure", async () => {
  const mock = new MockTransport().on("cwd.home", () => ({ home: "/home/tester" }));
  bindSessionListService(new IpcClient(mock));
  assert.equal(await fetchHomeDirectory(), "/home/tester");

  const failing = new MockTransport().fail("cwd.home", { code: "io", message: "no home" });
  bindSessionListService(new IpcClient(failing));
  assert.equal(await fetchHomeDirectory(), null);
});

/** A fake transport whose agent.subscribeRunning pushes scripted frames. */
function runningStreamTransport(frames, failAfterFrames = false) {
  const state = { subscriptions: 0, unsubscribed: 0 };
  const transport = {
    send: () => Promise.resolve({ v: 1, id: "x", ok: true, data: null }),
    subscribe(op, _args, onMessage, onError) {
      assert.equal(op, "agent.subscribeRunning");
      state.subscriptions += 1;
      for (const frame of frames) {
        onMessage({
          subscriptionId: "run-1",
          epoch: 1,
          seq: frame.seq,
          kind: frame.kind,
          payload: frame.payload,
        });
      }
      if (failAfterFrames) {
        setTimeout(() => onError({ code: "no_host", message: "relay ended", retryable: false }), 0);
      }
      return () => {
        state.unsubscribed += 1;
      };
    },
  };
  return { transport, state };
}

test("running frames adapt onto RunningSetFrame (snapshot then events)", () => {
  const seen = [];
  const frames = [
    { seq: 1, kind: "snapshot", payload: { type: "running", runningSessionIds: ["a"], sessionListVersion: 1 } },
    { seq: 2, kind: "event", payload: { type: "running", runningSessionIds: ["a", "b"], sessionListVersion: 2 } },
    { seq: 3, kind: "event", payload: { type: "other", runningSessionIds: [] } },
  ];
  const { transport, state } = runningStreamTransport(frames);
  bindSessionListService(new IpcClient(transport));
  const dispose = subscribeRunningSessions((frame) => seen.push(frame));
  dispose();
  assert.deepEqual(seen, [
    { runningSessionIds: ["a"], sessionListVersion: 1 },
    { runningSessionIds: ["a", "b"], sessionListVersion: 2 },
  ], "only running frames adapt; other payloads are ignored");
  assert.equal(state.subscriptions, 1);
});

test("a stream error resubscribes after 1.5s (the SSE reconnect contract)", async () => {
  const seen = [];
  const frames = [{ seq: 1, kind: "snapshot", payload: { type: "running", runningSessionIds: [], sessionListVersion: 1 } }];
  const { transport, state } = runningStreamTransport(frames, true);
  bindSessionListService(new IpcClient(transport));
  const dispose = subscribeRunningSessions((frame) => seen.push(frame));
  assert.equal(state.subscriptions, 1);
  await new Promise((done) => setTimeout(done, 2_000));
  assert.equal(state.subscriptions, 2, "the error path resubscribed once");
  assert.equal(seen.length, 2, "the fresh subscription re-snapshotted");
  dispose();
});

test("the disposer ends the subscription", () => {
  const { transport, state } = runningStreamTransport([]);
  bindSessionListService(new IpcClient(transport));
  const dispose = subscribeRunningSessions(() => {});
  dispose();
  assert.equal(state.unsubscribed, 1, "one unsubscribe for one subscription");
});
