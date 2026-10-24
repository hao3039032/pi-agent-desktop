/**
 * Binary-free unit tests for RpcAgentSession's event machine: the prompt
 * settle contract, the same-chunk race between the admission response and
 * agent_start, the child-death rejection, the wire shapes of set_model and
 * get_available_models, streaming-message reconstruction from delta-only
 * message_update records, and the executeBash id correlation. The client is
 * a scripted fake implementing the PiRpcClient surface RpcAgentSession reads
 * (onEvent/command/onProcessExit/close), so CI runs this without pi.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { RpcAgentSession } = await jiti.import("./session.ts");

/** Commands that would hang a broken test are failed by the fake instead. */
const FAKE_COMMAND_TIMEOUT_CAP_MS = 5_000;

class FakeRpcClient {
  constructor() {
    this.listeners = new Set();
    this.exitListeners = new Set();
    /** Written command records, in order ({type, ...data}). */
    this.sent = [];
    /** command type -> (data, client) => response data (may throw/reject). */
    this.handlers = new Map();
    this.exited = false;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onUi() {
    return () => {};
  }

  onProcessExit(listener) {
    this.exitListeners.add(listener);
    // The real client calls a listener registered on a dead child synchronously.
    if (this.exited) listener(null);
    return () => this.exitListeners.delete(listener);
  }

  command(type, data = {}, timeoutMs = 120_000) {
    this.sent.push({ type, ...data });
    const handler = this.handlers.get(type);
    if (!handler) return Promise.reject(new Error(`fake client: no handler for '${type}'`));
    const cap = Math.min(timeoutMs ?? Infinity, FAKE_COMMAND_TIMEOUT_CAP_MS);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`fake client: '${type}' did not answer within ${cap} ms`)),
        cap,
      );
      Promise.resolve().then(() => handler(data, this)).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  close() {
    return Promise.resolve(0);
  }

  kill() {}

  // --- test helpers ---------------------------------------------------------

  /** Deliver one child event record exactly like a stdout chunk would. */
  emit(record) {
    for (const listener of [...this.listeners]) listener(record);
  }

  /** The child died; every process-exit listener is called synchronously. */
  exit(code = null) {
    this.exited = true;
    for (const listener of [...this.exitListeners]) listener(code);
  }
}

const INITIAL_STATE = {
  sessionId: "unit-session",
  isStreaming: false,
  isCompacting: false,
  isIdle: true,
  autoCompactionEnabled: true,
  autoRetryEnabled: true,
  retryAttempt: 0,
  messageCount: 0,
  pendingMessageCount: 0,
  steeringQueue: [],
  followUpQueue: [],
};

function makeSession(handlers = {}) {
  const client = new FakeRpcClient();
  for (const [type, handler] of Object.entries(handlers)) client.handlers.set(type, handler);
  const session = new RpcAgentSession({ client, initialState: { ...INITIAL_STATE } });
  return { client, session };
}

/** Fail a promise that never settles: the hangs these tests guard against. */
function withDeadline(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${what} did not settle in ${ms} ms`)), ms)),
  ]);
}

function fullRun(client, { text = "OK" } = {}) {
  // The order a real child emits inside one run.
  client.emit({ type: "agent_start" });
  client.emit({
    type: "message_start",
    message: { role: "assistant", content: [], stopReason: "pending", usage: {} },
  });
  client.emit({
    type: "message_update",
    usage: { input: 1, output: 1 },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  });
  client.emit({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: {} },
  });
  client.emit({ type: "agent_settled", aborted: false });
}

test("prompt started: resolves only after the run settles", async () => {
  const { client, session } = makeSession({
    prompt: () => ({ disposition: "started" }),
  });
  let disposition = "";
  let resolved = false;
  const promptPromise = session.prompt("hi", { preflightResult: (value) => (disposition = value) });
  void promptPromise.then(() => (resolved = true));
  await new Promise((resolve) => setTimeout(resolve, 30));
  // The admission response was processed, but no run event arrived yet: the
  // SDK-shaped promise must still be pending.
  assert.equal(disposition, "started");
  assert.equal(resolved, false, "admission alone does not resolve the prompt");
  fullRun(client);
  await withDeadline(promptPromise, 2_000, "prompt after settle");
  assert.equal(session.isStreaming, false);
  assert.equal(session.isIdle, true);
});

test("prompt started: response and the whole run in one chunk must not hang", async () => {
  // The regression: reading runEpoch after the await saw the same-chunk
  // agent_start already, waited one epoch too many and hung forever.
  const { client, session } = makeSession({
    prompt: () => {
      // Emit synchronously inside the handler: exactly the ordering of a
      // single stdout chunk carrying response + agent_start + agent_settled.
      fullRun(client);
      return { disposition: "started" };
    },
  });
  await withDeadline(session.prompt("hi"), 2_000, "same-chunk prompt");
  assert.equal(session.isStreaming, false, "the run was processed");
});

test("prompt queued: waits for the current epoch's settle, then resolves", async () => {
  const { client, session } = makeSession({
    prompt: () => ({ disposition: "queued" }),
  });
  // A run is in flight (epoch 1) and settles after the admission response.
  client.emit({ type: "agent_start" });
  const promptPromise = session.prompt("hi");
  let resolved = false;
  void promptPromise.then(() => (resolved = true));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(resolved, false, "still waiting for the in-flight epoch");
  client.emit({ type: "agent_settled", aborted: false });
  await withDeadline(promptPromise, 2_000, "queued prompt");
});

test("prompt queued: a settle that already happened satisfies the wait", async () => {
  const { client, session } = makeSession({
    prompt: () => {
      // The queued message's delivery run started AND settled inside the
      // response chunk; the wait must notice the already-recorded epoch.
      client.emit({ type: "agent_start" });
      client.emit({ type: "agent_settled", aborted: false });
      return { disposition: "queued" };
    },
  });
  await withDeadline(session.prompt("hi"), 2_000, "queued prompt with same-chunk settle");
});

test("prompt handled: an extension command starts no run and needs no settle", async () => {
  const { client, session } = makeSession({
    prompt: () => ({ disposition: "handled" }),
  });
  let disposition = "";
  await withDeadline(session.prompt("/mycommand", { preflightResult: (v) => (disposition = v) }), 2_000, "handled prompt");
  assert.equal(disposition, "handled");
  assert.equal(session.isStreaming, false);
});

test("prompt rejects when the child dies mid-run", async () => {
  const { client, session } = makeSession({
    prompt: () => {
      client.emit({ type: "agent_start" });
      // Dying before the wait even registers exercises the synchronous
      // onProcessExit callback path on an already-exited client.
      client.exit(1);
      return { disposition: "started" };
    },
  });
  await assert.rejects(
    () => withDeadline(session.prompt("hi"), 2_000, "child death rejection"),
    /pi process exited during the run/,
  );
});

test("set_model sends the flat wire shape {provider, modelId}", async () => {
  const { client, session } = makeSession({
    set_model: () => ({}),
  });
  await session.setModel({ id: "claude-sonnet-4", provider: "anthropic", name: "Sonnet" });
  const record = client.sent.find((entry) => entry.type === "set_model");
  assert.ok(record, "set_model was sent");
  assert.equal(record.provider, "anthropic");
  assert.equal(record.modelId, "claude-sonnet-4");
  assert.equal("model" in record, false, "no nested model object on the wire");
});

test("get_available_models parses {models} and the cache survives getter reads", async () => {
  const models = [
    { id: "m1", provider: "anthropic", name: "One" },
    { id: "m2", provider: "openai", name: "Two" },
  ];
  const { client, session } = makeSession({
    get_available_models: () => ({ models }),
  });
  const runtime = session.modelRuntime;
  await runtime.refresh();
  assert.equal(runtime.getModel("anthropic", "m1")?.name, "One");
  // The regression: a cache recreated per getter read was always empty here.
  assert.equal(session.modelRuntime.getModel("openai", "m2")?.name, "Two");
  assert.equal(session.modelRuntime.getModel("anthropic", "missing"), undefined);
});

test("get_available_models accepts a bare array as a fallback", async () => {
  const { client, session } = makeSession({
    get_available_models: () => [{ id: "bare", provider: "p", name: "Bare" }],
  });
  await session.modelRuntime.refresh();
  assert.equal(session.modelRuntime.getModel("p", "bare")?.name, "Bare");
});

test("streaming message is reconstructed from delta-only message_update records", async () => {
  const { client, session } = makeSession({});
  client.emit({ type: "agent_start" });
  client.emit({
    type: "message_start",
    message: { role: "assistant", content: [], stopReason: "pending", usage: {} },
  });
  client.emit({
    type: "message_update",
    usage: { input: 10 },
    assistantMessageEvent: { type: "text_start", contentIndex: 0 },
  });
  client.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
  });
  client.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
  });
  let streaming = session.agent.state.streamingMessage;
  assert.equal(streaming.content[0].type, "text");
  assert.equal(streaming.content[0].text, "Hello", "text deltas accumulate");
  assert.equal(streaming.usage?.input, 10, "cumulative usage is carried");

  // A tool call block: start, argument fragments, authoritative end.
  client.emit({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call_1", toolName: "bash" },
  });
  client.emit({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"command":"ls"}' },
  });
  streaming = session.agent.state.streamingMessage;
  assert.equal(streaming.content[1].type, "toolCall");
  assert.equal(streaming.content[1].name, "bash");
  client.emit({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } } },
  });
  streaming = session.agent.state.streamingMessage;
  assert.deepEqual(streaming.content[1].arguments, { command: "ls" }, "toolcall_end replaces the partial");

  // message_end replaces the whole message; agent_settled clears it.
  client.emit({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "final" }], stopReason: "stop", usage: {} },
  });
  assert.equal(session.agent.state.streamingMessage.content[0].text, "final");
  assert.equal(session.getLastAssistantText(), "final");
  client.emit({ type: "agent_settled", aborted: false });
  assert.equal(session.agent.state.streamingMessage, undefined, "settled clears the streaming view");
});

test("auto_retry_start parses the attempt number from the wire event", async () => {
  const { client, session } = makeSession({});
  client.emit({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1000, errorMessage: "529" });
  assert.equal(session.retryAttempt, 2);
  client.emit({ type: "agent_settled", aborted: false });
  assert.equal(session.retryAttempt, 0, "settle resets the attempt");
});

test("executeBash: the caller id correlates updates and the response", async () => {
  const { client, session } = makeSession({
    bash: (data, fake) => {
      assert.equal(typeof data.id, "string", "executeBash sends its correlation id");
      // Streamed chunks repeat the SAME id; a response keyed to a generated
      // id would never correlate and the call would hang (the 600s timeout).
      fake.emit({ type: "bash_execution_update", id: data.id, delta: "part-1\n" });
      fake.emit({ type: "bash_execution_update", id: "other-id", delta: "ignored\n" });
      fake.emit({ type: "bash_execution_update", id: data.id, delta: "part-2\n" });
      return { output: "part-1\npart-2\n", exitCode: 0, cancelled: false, truncated: false };
    },
  });
  const chunks = [];
  const result = await withDeadline(
    session.executeBash("echo hello", (chunk) => chunks.push(chunk)),
    2_000,
    "executeBash correlation",
  );
  assert.deepEqual(chunks, ["part-1\n", "part-2\n"], "only our id's chunks stream");
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "part-1\npart-2\n");
  assert.equal(session.isBashRunning, false, "the running flag clears in finally");
});

test("a stale get_state after settle cannot flip a new run back to idle", async () => {
  // agent_settled fires a fire-and-forget get_state; a new run may start
  // before its response arrives. The volatile fields must be dropped.
  const { client, session } = makeSession({
    get_state: () => {
      // Simulate the reply landing after a new agent_start.
      client.emit({ type: "agent_start" });
      return { isStreaming: false, isIdle: true, messageCount: 99, sessionName: "kept" };
    },
    get_session_stats: () => ({}),
    get_last_assistant_text: () => ({ text: "stale text" }),
  });
  client.emit({ type: "agent_start" }); // epoch 1
  client.emit({ type: "agent_settled", aborted: false });
  // The get_state handler above started epoch 2 before answering.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(session.isStreaming, true, "the live run's streaming flag survives the stale snapshot");
  assert.equal(session.isIdle, false, "the live run's idle flag survives the stale snapshot");
  assert.equal(session.messageCount, 0, "a stale messageCount is dropped");
  assert.equal(session.getLastAssistantText(), undefined, "a stale lastText does not overwrite");
});
