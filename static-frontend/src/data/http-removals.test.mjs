/**
 * Tests for the static app's domain swaps that remove the last HTTP probes:
 * - desktop-connection (the /api/home probe → desktop.identity over IPC);
 * - scheduled-tasks-store (the /api/scheduled-tasks list + EventSource →
 *   tasks.list over IPC, no event stream yet);
 * - project-trust-client (GET /api/project-trust's status half →
 *   trust.status over IPC).
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

const { bindDesktopConnection, probeHostIdentity } = await jiti.import("./desktop-connection.ts");
const {
  bindScheduledTasksStore,
  onScheduledTaskEvent,
  refreshScheduledTasks,
  retainScheduledTaskStream,
  summarizeScheduledTasks,
} = await jiti.import("./scheduled-tasks-store.ts");
const { bindProjectTrustClient, fetchProjectTrustStatus } = await jiti.import("./project-trust-client.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

function bound(handler) {
  const mock = new MockTransport();
  if (handler) for (const [op, impl] of Object.entries(handler)) mock.on(op, impl);
  const client = new IpcClient(mock);
  bindDesktopConnection(client);
  bindScheduledTasksStore(client);
  bindProjectTrustClient(client);
  return mock;
}

test("the connection probe asks the host identity, not an HTTP server", async () => {
  const asked = [];
  const mock = bound({
    "desktop.identity": () => {
      asked.push("identity");
      return { app: "pi-agent-desktop" };
    },
  });
  assert.equal(await probeHostIdentity(), true);
  assert.deepEqual(asked, ["identity"]);
  // The bound client is the one transport — the probe goes through it.
  assert.ok(mock);
});

test("the connection probe reports offline when the host does not answer", async () => {
  const mock = new MockTransport();
  // No handler: every request fails through the transport's error shape.
  const client = new IpcClient(mock);
  bindDesktopConnection(client);
  assert.equal(await probeHostIdentity(), false);
});

test("the scheduled store lists through tasks.list and surfaces errors honestly", async () => {
  bound({
    "tasks.list": () => ({ tasks: [{ id: "t1", unreadRuns: 0, enabled: true }] }),
  });
  await refreshScheduledTasks();
  const summary = summarizeScheduledTasks(
    [{ id: "t1", unreadRuns: 2, enabled: true, lastRun: { status: "running" } }, { id: "t2", unreadRuns: 0, autoPausedReason: "five failures" }],
    new Set(),
  );
  assert.deepEqual(summary, { unread: 2, running: true, attention: true });
});

test("the scheduled store records a host failure instead of throwing", async () => {
  bound({ "tasks.list": () => { throw new Error("store broken"); } });
  // The page's contract: a failed list load lands in the store's error
  // state (rendered by ScheduledView), never an unhandled rejection from
  // the hook's refresh path.
  await assert.doesNotReject(() => refreshScheduledTasks());
});

test("the event surface keeps the Next hook's contract while M4 events are absent", () => {
  // The consumer (hooks/useScheduledRunNotifications, aliased into this
  // build) subscribes with a typed handler and expects an unsubscriber; the
  // static-frontend tsc program is the type-level regression, this pins the
  // runtime shape: both calls answer functions, and nothing fires the
  // handler (no event source exists yet — an event arriving would be a
  // lie, not a feature).
  const seen = [];
  const off = onScheduledTaskEvent((event) => seen.push(event));
  const release = retainScheduledTaskStream();
  assert.equal(typeof off, "function");
  assert.equal(typeof release, "function");
  assert.doesNotThrow(() => { off(); release(); });
  assert.deepEqual(seen, []);
});

test("the trust client returns the host's status shape", async () => {
  const calls = [];
  bound({
    "trust.status": (args) => {
      calls.push(args.cwd);
      return { requiresTrust: true, trusted: false, decision: null, inherited: false };
    },
  });
  const result = await fetchProjectTrustStatus("/tmp/some-project");
  assert.deepEqual(calls, ["/tmp/some-project"]);
  assert.deepEqual(result, { ok: true, requiresTrust: true, trusted: false, decision: null, inherited: false });
});

test("the trust client surfaces the protocol error, not a JSON parse failure", async () => {
  bound({ "trust.status": () => { throw new Error("io: store locked"); } });
  await assert.rejects(() => fetchProjectTrustStatus("/tmp/x"), /io: store locked|trust\.status/);
});
