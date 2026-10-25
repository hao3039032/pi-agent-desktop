/**
 * Startup extension-UI buffering, without a pi binary.
 *
 * The child raises extension UI while it boots (`session_start` runs before the
 * first stdin line is honoured), so a startup confirm can arrive before the
 * get_state handshake answers and long before the wrapper's relay exists. The
 * pre-attach window holds those requests — original id, bounded, arrival
 * ordered — and the cases below pin every way it may end:
 *
 *   - the handshake still answers while a dialog waits (pi dispatches input
 *     lines concurrently, so holding a dialog cannot deadlock get_state);
 *   - held requests replay in arrival order even when their handlers register
 *     one at a time (a later method must not overtake an earlier one);
 *   - the window's deadline, overflow, child exit, close() and kill() all
 *     cancel and clean up — a dialog is never approved on the user's behalf.
 *
 * The "child" is a fake pi script run on this Node binary: PiRpcClient's real
 * spawn/stdio/exit paths are exercised, only the protocol partner is scripted.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { PiRpcClient } = await jiti.import("./client.ts");

/**
 * A scripted `pi --mode rpc` partner. It emits the startup UI from
 * PI_WEB_FAKE_UI before reading stdin (that ordering is the whole point),
 * answers every command, and appends every received line to PI_WEB_FAKE_LOG so
 * a test can assert what reached the child even after it was killed.
 */
const FAKE_PI = `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.PI_WEB_FAKE_LOG;
const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
// Startup UI: exactly what an extension raises from session_start.
for (const record of JSON.parse(process.env.PI_WEB_FAKE_UI ?? "[]")) send(record);

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(message) + "\\n");
  if (message.type === "extension_ui_response") return;
  if (message.type === "fake_exit") process.exit(0);
  send({
    type: "response",
    id: message.id,
    command: message.type,
    success: true,
    data: message.type === "get_state" ? { sessionId: "fake-session", isStreaming: false } : {},
  });
});
lines.on("close", () => process.exit(0));
`;

const work = await mkdtemp(join(tmpdir(), "pi-rpc-startup-ui-"));
const fakeScript = join(work, "fake-pi.mjs");
await writeFile(fakeScript, FAKE_PI, "utf8");

let logCounter = 0;

/** A client over the fake child, with the scripted startup UI it raises. */
function makeClient(t, startupUi = []) {
  const logFile = join(work, `receipts-${logCounter++}.jsonl`);
  const client = new PiRpcClient("fake-pi-not-used", {
    spawnChild: (_executable, args, options) => spawn(process.execPath, [fakeScript, ...args], options),
    env: {
      ...process.env,
      PI_WEB_FAKE_UI: JSON.stringify(startupUi),
      PI_WEB_FAKE_LOG: logFile,
    },
    onLog: () => {},
  });
  t.after(() => client.kill());
  /** What reached the child, as it arrived. */
  const received = () => {
    try {
      return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const responses = () => received().filter((record) => record.type === "extension_ui_response");
  return { client, received, responses };
}

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
    }, 25);
  });
}

const ui = {
  confirm: (id) => ({ type: "extension_ui_request", id, method: "confirm", title: "Continue?", message: "startup" }),
  select: (id) => ({ type: "extension_ui_request", id, method: "select", title: "Pick", options: ["A", "B"] }),
  notify: (id) => ({ type: "extension_ui_request", id, method: "notify", message: "booting", notifyType: "info" }),
  setStatus: (id) => ({ type: "extension_ui_request", id, method: "setStatus", statusKey: "ext", statusText: "booting" }),
};

test("startup UI: the handshake answers while a dialog waits, then the handler's answer reaches the child", async (t) => {
  const { client, responses } = makeClient(t, [ui.confirm("startup-confirm")]);
  client.beginUiAttachWindow({ timeoutMs: 10_000 });

  // The confirm was raised at startup, i.e. before this response was even
  // requested: get_state answering proves the held dialog blocked nothing.
  const state = await client.command("get_state", {}, 5_000);
  assert.equal(state.sessionId, "fake-session");
  await waitFor(() => client.pendingUiRequests === 1, 5_000, "the startup dialog to be held");
  assert.deepEqual(responses(), [], "nothing answered the dialog yet");

  client.onUi("confirm", (record) => ({ confirmed: record.id === "startup-confirm" }));
  await waitFor(() => responses().length === 1, 5_000, "the answer to reach the child");
  assert.deepEqual(
    responses()[0],
    { type: "extension_ui_response", id: "startup-confirm", confirmed: true },
    "the held request kept its id and carried the handler's answer",
  );
  assert.equal(client.pendingUiRequests, 0);

  client.endUiAttachWindow();
  await client.close();
});

test("startup UI: replay keeps arrival order when handlers register one at a time", async (t) => {
  const { client, responses } = makeClient(t, [
    ui.notify("n-1"),
    ui.setStatus("s-1"),
    ui.confirm("c-1"),
    ui.select("q-1"),
  ]);
  client.beginUiAttachWindow({ timeoutMs: 10_000 });
  await waitFor(() => client.pendingUiRequests === 4, 5_000, "the startup UI to be held");

  const delivered = [];
  // The LAST arrival first: a flush that only drained the newly registered
  // method would deliver q-1 before n-1/s-1/c-1.
  client.onUi("select", (record) => {
    delivered.push(record.id);
    return { value: "A" };
  });
  assert.deepEqual(delivered, [], "a later method must not overtake the unregistered head");
  assert.equal(client.pendingUiRequests, 4);

  client.onUi("notify", (record) => {
    delivered.push(record.id);
    return undefined;
  });
  assert.deepEqual(delivered, ["n-1"], "only the head was deliverable");

  client.onUi("setStatus", (record) => {
    delivered.push(record.id);
    return undefined;
  });
  assert.deepEqual(delivered, ["n-1", "s-1"]);

  client.onUi("confirm", (record) => {
    delivered.push(record.id);
    return { confirmed: true };
  });
  assert.deepEqual(delivered, ["n-1", "s-1", "c-1", "q-1"], "arrival order, across methods");
  assert.equal(client.pendingUiRequests, 0);

  await waitFor(() => responses().length === 2, 5_000, "the two dialog answers");
  assert.deepEqual(responses().map((record) => record.id), ["c-1", "q-1"]);
  assert.equal(
    responses().some((record) => record.id === "n-1" || record.id === "s-1"),
    false,
    "fire-and-forget methods are never answered",
  );

  client.endUiAttachWindow();
  await client.close();
});

test("startup UI: the window's deadline cancels a dialog and never approves it", async (t) => {
  const { client, responses } = makeClient(t, [ui.confirm("deadline-1")]);
  // Long enough to cover the fake child's own start-up (the window opens on
  // spawn, not on the first request).
  client.beginUiAttachWindow({ timeoutMs: 2_000 });
  await waitFor(() => client.pendingUiRequests === 1, 10_000, "the dialog to be held");
  await waitFor(() => client.pendingUiRequests === 0, 10_000, "the window to expire");

  await waitFor(() => responses().length === 1, 5_000, "the cancellation to reach the child");
  assert.deepEqual(responses()[0], { type: "extension_ui_response", id: "deadline-1", cancelled: true });
  assert.equal("confirmed" in responses()[0], false, "expiry cancels, it never approves");
  await client.close();
});

test("startup UI: overflow cancels the oldest held requests and keeps the newest", async (t) => {
  const held = ["o-1", "o-2", "o-3", "o-4", "o-5", "o-6"].map(ui.confirm);
  const { client, responses } = makeClient(t, held);
  client.beginUiAttachWindow({ timeoutMs: 10_000, maxEntries: 4 });
  await waitFor(() => client.pendingUiRequests === 4, 5_000, "the buffer to fill");
  await waitFor(() => responses().length === 2, 5_000, "the two evictions");

  client.onUi("confirm", () => ({ confirmed: true }));
  await waitFor(() => responses().length === 6, 5_000, "the surviving requests");
  assert.deepEqual(
    responses().map((record) => [record.id, record.cancelled === true]),
    [["o-1", true], ["o-2", true], ["o-3", false], ["o-4", false], ["o-5", false], ["o-6", false]],
    "the oldest were cancelled in order; the four newest were answered",
  );
  client.endUiAttachWindow();
  await client.close();
});

test("startup UI: a child exit drops the held UI without answering it", async (t) => {
  const { client, responses } = makeClient(t, [ui.confirm("exit-1")]);
  client.beginUiAttachWindow({ timeoutMs: 10_000 });
  await waitFor(() => client.pendingUiRequests === 1, 5_000, "the dialog to be held");

  await assert.rejects(() => client.command("fake_exit", {}, 5_000), /exited/i);
  await waitFor(() => client.hasExited, 5_000, "the child to exit");
  assert.equal(client.pendingUiRequests, 0, "the held UI was cleaned up");
  assert.deepEqual(responses(), [], "a dead child is written nothing — and nothing is approved");
});

test("startup UI: close() and kill() clean up the held UI", async (t) => {
  const { client } = makeClient(t, [ui.confirm("close-1")]);
  client.beginUiAttachWindow({ timeoutMs: 10_000 });
  await waitFor(() => client.pendingUiRequests === 1, 5_000, "the dialog to be held");
  await client.close();
  assert.equal(client.pendingUiRequests, 0, "close() cancelled and cleaned the held dialog");

  const killed = makeClient(t, [ui.confirm("kill-1")]);
  killed.client.beginUiAttachWindow({ timeoutMs: 10_000 });
  await waitFor(() => killed.client.pendingUiRequests === 1, 5_000, "the second dialog to be held");
  const exited = new Promise((resolve) => killed.client.onProcessExit(resolve));
  killed.client.kill();
  assert.equal(killed.client.pendingUiRequests, 0, "kill() cancelled and cleaned the held dialog");
  await exited;
  assert.deepEqual(killed.responses(), [], "shutdown never approves a dialog");
});

test("startup UI: without a window an unregistered dialog still cancels at once", async (t) => {
  // The plain client contract stays: no window, no hold. This is what keeps
  // the real-pi "unregistered dialog is auto-cancelled" case honest.
  const { client, responses } = makeClient(t, [ui.confirm("plain-1")]);
  await client.command("get_state", {}, 5_000);
  await waitFor(() => responses().length === 1, 5_000, "the immediate cancellation");
  assert.deepEqual(responses()[0], { type: "extension_ui_response", id: "plain-1", cancelled: true });
  assert.equal(client.pendingUiRequests, 0);
  await client.close();
});

test("startup UI: a dialog whose own timeout lapsed while held is never delivered", async (t) => {
  // The child sends `timeout` on the request (rpc-mode's createDialogPromise);
  // a replay after that point would answer a dialog pi already gave up on.
  const expired = { ...ui.confirm("late-1"), timeout: 150 };
  const { client, responses } = makeClient(t, [expired]);
  client.beginUiAttachWindow({ timeoutMs: 10_000 });
  await waitFor(() => client.pendingUiRequests === 1, 5_000, "the dialog to be held");
  await new Promise((resolve) => setTimeout(resolve, 250));

  let delivered = 0;
  client.onUi("confirm", () => {
    delivered += 1;
    return { confirmed: true };
  });
  await waitFor(() => client.pendingUiRequests === 0, 5_000, "the expired entry to leave the buffer");
  assert.equal(delivered, 0, "the handler never saw the expired dialog");
  await waitFor(() => responses().length === 1, 5_000, "the cancellation");
  assert.deepEqual(responses()[0], { type: "extension_ui_response", id: "late-1", cancelled: true });
  await client.close();
});

test("startup UI: a request whose handler is registered while an earlier one waits still queues behind it", async (t) => {
  // notify has no handler yet; select already does. Arrival order must win:
  // the select may not jump the notify even though it could be answered now.
  const { client, responses } = makeClient(t, [ui.notify("ahead-1"), ui.select("behind-1")]);
  client.beginUiAttachWindow({ timeoutMs: 10_000 });
  await waitFor(() => client.pendingUiRequests === 2, 5_000, "both requests to be held");

  const delivered = [];
  client.onUi("select", (record) => {
    delivered.push(record.id);
    return { value: "B" };
  });
  assert.deepEqual(delivered, [], "a registered later method does not overtake the head");
  assert.equal(client.pendingUiRequests, 2);

  client.onUi("notify", (record) => {
    delivered.push(record.id);
    return undefined;
  });
  assert.deepEqual(delivered, ["ahead-1", "behind-1"], "arrival order across methods");
  await waitFor(() => responses().length === 1, 5_000, "only the select needs an answer");
  assert.deepEqual(responses()[0], { type: "extension_ui_response", id: "behind-1", value: "B" });
  client.endUiAttachWindow();
  await client.close();
});
