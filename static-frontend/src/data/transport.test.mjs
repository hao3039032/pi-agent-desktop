/**
 * Tests for the static transport wiring (static-frontend/src/data/transport.ts)
 * and the session event source's frame → AgentEvent adaptation.
 *
 * The no-host behavior is frozen here (Node has no __TAURI_INTERNALS__), the
 * host-bridge envelope contract lives in the Rust tests (src-tauri pi_ipc)
 * and this file drives the ADAPTATION logic through a fake transport.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The transport modules import repo TypeScript with extensionless and @/
// specifiers (Vite/TS resolution); Node's strip-types cannot resolve those,
// so these tests load them through jiti with the repo's path alias — the
// convention the root test suites use.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const jiti = createJiti(import.meta.url, {
  alias: { "@": repoRoot },
  interopDefault: true,
});

const transportModule = await jiti.import("./transport.ts");
const { detectTransport, MissingHostTransport, overrideTransportForTests } = transportModule;
const { createSessionEventSource } = await jiti.import("./session-event-source.ts");
const { bindAgentClient, sendAgentCommand, AgentCommandError, isPromptRejectedError } =
  await jiti.import("./agent-client.ts");
const { MockTransport } = await jiti.import("../ipc/client.ts");

test("without a host bridge the transport fails explicitly, never a mock", () => {
  overrideTransportForTests(undefined);
  // No __TAURI_INTERNALS__ in Node: the old code answered a MockTransport
  // here, pretending a host existed; the contract is an explicit failure.
  const detected = detectTransport();
  assert.ok(detected.transport instanceof MissingHostTransport, `label=${detected.label}`);
  assert.equal(detected.label, "MissingHostTransport");
  assert.rejects(
    detected.transport.send({ v: 1, id: "r1", op: "desktop.identity" }, 100),
    /no Tauri host bridge/,
  );
});

test("the missing-host transport reports the stream error through onError", () => {
  const noHost = new MissingHostTransport();
  const errors = [];
  const dispose = noHost.subscribe(
    "agent.subscribeEvents",
    { session: "s" },
    () => {},
    (error) => errors.push(error),
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "no_host");
  dispose();
});

// The host-command mapping for stream ops is wiring THIS file's transport
// owns; a typo would only surface inside the packaged app. Pin it from the
// source (the Rust side pins its own end of the contract in pi_ipc tests).
test("every stream op maps onto its host subscribe command", async () => {
  const source = await import("node:fs").then((fs) => fs.readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "transport.ts"), "utf8",
  ));
  const mappings = [
    ["agent.subscribeEvents", "pi_ipc_subscribe_events"],
    ["agent.subscribeRunning", "pi_ipc_subscribe_running"],
    ["terminal.subscribeOutput", "pi_ipc_subscribe_terminal"],
  ];
  for (const [op, command] of mappings) {
    assert.ok(source.includes(`"${op}"`), `${op} wired in the transport`);
    assert.ok(source.includes(`"${command}"`), `${command} wired in the transport`);
  }
  // The running stream's payload key is the command's own (onFrame), and it
  // unsubscribes through the shared agent.unsubscribeEvents op.
  assert.ok(source.includes("{ onFrame: handle.channel }"), "the running stream sends onFrame");
  assert.ok(/command === "pi_ipc_subscribe_running"/.test(source), "the running stream reuses the unsubscribe path");
});

test("the detection result is cached (one transport per page)", () => {
  overrideTransportForTests(undefined);
  const first = detectTransport();
  const second = detectTransport();
  assert.equal(first, second);
});

// --- the session event source adaptation (pure logic over frames) ---------

function framedSource() {
  let delivery = null;
  const fake = {
    send: () => Promise.resolve({ v: 1, id: "x", ok: true, data: null }),
    subscribe: (_op, _args, onMessage) => {
      delivery = onMessage;
      return () => {
        delivery = null;
      };
    },
  };
  overrideTransportForTests({ transport: fake, label: "fake" });
  try {
    const source = createSessionEventSource("session-1");
    return { source, deliver: (frame) => delivery?.(frame) };
  } finally {
    overrideTransportForTests(undefined);
  }
}

test("the snapshot frame becomes the connected AgentEvent, never a raw frame", () => {
  const { source, deliver } = framedSource();
  const events = [];
  source.onmessage = (message) => events.push(JSON.parse(message.data));
  deliver({
    subscriptionId: "sub-1", epoch: 1, seq: 1, kind: "snapshot",
    payload: { epoch: 1, settledEpoch: 0, state: { sessionId: "file-id", isStreaming: true } },
  });
  assert.equal(events.length, 1, "one event: the synthesized connected event");
  assert.equal(events[0].type, "connected");
  assert.equal(events[0].sessionId, "file-id");
  assert.equal(events[0].isStreaming, true);
  assert.equal(source.readyState, 1, "OPEN after the snapshot");
  // A child record follows as a real event.
  deliver({
    subscriptionId: "sub-1", epoch: 1, seq: 2, kind: "event",
    payload: { type: "agent_start" },
  });
  assert.equal(events.length, 2);
  assert.equal(events[1].type, "agent_start");
  source.close();
});

test("seq ordering, stale generations, and generation bumps", () => {
  const { source, deliver } = framedSource();
  const events = [];
  const errors = [];
  source.onmessage = (message) => events.push(JSON.parse(message.data));
  source.onerror = () => errors.push("error");
  // The FIRST frame establishes the generation (no error, no drop).
  deliver({ subscriptionId: "sub", epoch: 2, seq: 5, kind: "event", payload: { type: "a" } });
  assert.equal(events.length, 1, "the first frame adopts its epoch");
  // Replayed/older seq within the generation never deliver.
  deliver({ subscriptionId: "sub", epoch: 2, seq: 5, kind: "event", payload: { type: "dup" } });
  deliver({ subscriptionId: "sub", epoch: 2, seq: 4, kind: "event", payload: { type: "old" } });
  assert.equal(events.length, 1, "replayed/older seq frames never deliver");
  // A frame from an OLDER generation is stale: silently dropped.
  deliver({ subscriptionId: "sub", epoch: 1, seq: 99, kind: "event", payload: { type: "stale" } });
  assert.equal(events.length, 1, "stale-generation frames never deliver");
  assert.equal(errors.length, 0, "stale frames are not errors");
  // A NEW generation mid-stream is a RESET: the consumer must re-snapshot
  // (error → reconnect), never quietly re-base and continue.
  deliver({ subscriptionId: "sub", epoch: 3, seq: 1, kind: "event", payload: { type: "fresh" } });
  assert.equal(errors.length, 1, "a generation bump surfaces as an error");
  assert.equal(events.length, 1, "the bumped frame itself never delivers");
  // A reset frame is an error → the connection layer reconnects.
  deliver({ subscriptionId: "sub", epoch: 2, seq: 6, kind: "reset", payload: null });
  assert.equal(errors.length, 2);
  source.close();
});

test("the connected event carries pendingExtensionUiIds (the SSE contract)", () => {
  const { source, deliver } = framedSource();
  const events = [];
  source.onmessage = (message) => events.push(JSON.parse(message.data));
  deliver({
    subscriptionId: "sub", epoch: 1, seq: 1, kind: "snapshot",
    payload: {
      epoch: 1, settledEpoch: 0,
      pendingExtensionUiIds: ["ui-1", "ui-2"],
      state: { sessionId: "file-id", isStreaming: false },
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "connected");
  assert.deepEqual(events[0].pendingExtensionUiIds, ["ui-1", "ui-2"],
    "the dialog reconciliation set survives the adaptation");
  // Without the field the event omits it (the UI treats absent as unknown).
  const second = framedSource();
  const seen = [];
  second.source.onmessage = (message) => seen.push(JSON.parse(message.data));
  second.deliver({
    subscriptionId: "s2", epoch: 1, seq: 1, kind: "snapshot",
    payload: { epoch: 1, state: { sessionId: "x" } },
  });
  assert.equal("pendingExtensionUiIds" in seen[0], false);
  second.source.close();
  source.close();
});

test("close detaches the subscription (no further delivery)", () => {
  const { source, deliver } = framedSource();
  let count = 0;
  source.onmessage = () => { count += 1; };
  source.close();
  assert.equal(source.readyState, 2, "CLOSED");
  deliver({ subscriptionId: "sub", epoch: 1, seq: 1, kind: "event", payload: { type: "x" } });
  assert.equal(count, 0, "nothing delivers after close");
});

// --- agent-client error mapping ---------------------------------------------

test("agent-client failures keep the HTTP-shaped error contract", async () => {
  const mock = new MockTransport();
  // The mock answers an error envelope (unknown op) — the client maps it.
  bindAgentClient(mock);
  const error = await sendAgentCommand("s", { type: "get_state" }).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error instanceof AgentCommandError, String(error));
  // The constructor argument ORDER is the original (message, status, code…).
  assert.equal(typeof error.status, "number", `status=${error.status}`);
  // The prompt-rejection predicate requires code+accepted:false together.
  const rejected = new AgentCommandError("child died", 500, "prompt_rejected", false);
  assert.equal(isPromptRejectedError(rejected), true);
  const notRejected = new AgentCommandError("x", 500, "other", true);
  assert.equal(isPromptRejectedError(notRejected), false);

  // An abort stops the WAIT without inventing a result.
  const controller = new AbortController();
  controller.abort();
  const aborted = await sendAgentCommand("s", { type: "get_state" }, { signal: controller.signal })
    .then(() => null, (caught) => caught);
  assert.ok(aborted instanceof AgentCommandError, String(aborted));
  assert.match(aborted.message, /aborted/);
});
