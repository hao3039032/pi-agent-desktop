import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./route.ts");

const PI_SUBAGENTS_EXTENSION = {
  path: "C:/pi-seed/npm/node_modules/pi-subagents/index.js",
  sourceInfo: { source: "npm:pi-subagents@0.79.1" },
};

/**
 * An extension-responder fake: `emit` answers requests the way the package's
 * RPC bridge does (by requestId), delivering through `handlers`, the registry
 * the wrapped `on` below fills.
 */
function createResponder({ sessionId, runs = [], foreignRunIds = new Set(), capabilities, methods, statusError } = {}) {
  return {
    requests: [],
    respond(request, payload) {
      queueMicrotask(() => {
        for (const handler of handlers.get(`subagents:rpc:v1:reply:${request.requestId}`) ?? []) {
          handler(payload);
        }
      });
    },
    handle(request) {
      this.requests.push(request);
      const reply = (success, data, error) =>
        this.respond(request, success
          ? { version: 1, requestId: request.requestId, method: request.method, success: true, data }
          : { version: 1, requestId: request.requestId, method: request.method, success: false, error });
      if (request.method === "ping") {
        return reply(true, {
          version: 1,
          methods: methods ?? ["ping", "status", "steer", "interrupt", "stop"],
          capabilities: capabilities ?? {
            status: true,
            fleetStatus: { version: 1 },
            asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 },
            steer: true,
            nonRecoveringSteer: true,
            interrupt: true,
            stop: true,
            resume: true,
          },
          session: { sessionId, cwd: "C:/work", sessionFile: null },
        });
      }
      if (request.method === "status") {
        if (statusError) return reply(false, undefined, statusError);
        const target = request.params?.id;
        if (target !== undefined && foreignRunIds.has(target)) {
          return reply(false, undefined, { code: "not_found", message: `Async run '${target}' was not found in the active session.` });
        }
        if (target !== undefined) {
          return reply(true, { text: `transcript tail of ${target}\nlast line`, details: { mode: "single", results: [] } });
        }
        return reply(true, {
          text: "In-memory subagent status: 1 active child.",
          fleet: { version: 1, entries: [], totalActive: 1, omitted: 0 },
          asyncSnapshot: {
            kind: "pi-subagents.async-status-snapshot",
            version: 1,
            generatedAt: 1_800_000_000_000,
            runs,
            omitted: { runs: 0, children: 0, byteLimitExceeded: false },
          },
        });
      }
      if (request.method === "stop") {
        const target = request.params?.id;
        if (foreignRunIds.has(target)) {
          return reply(false, undefined, { code: "not_found", message: `Async run '${target}' was not found in the active session.` });
        }
        return reply(true, { runId: target, state: "stopping", previousState: "running", message: `Stop requested for async run ${target}.` });
      }
      if (request.method === "steer") {
        // The package's steer goes through executeChecked/dataFromToolResult and
        // answers with a tool-result shape: { text, details? }.
        return reply(true, { text: "Steering message delivered." });
      }
      if (request.method === "interrupt") {
        return reply(true, { text: "Interrupt requested for foreground run run-1." });
      }
      reply(false, undefined, { code: "unsupported_method", message: "no" });
    },
  };
}

// The client registers reply handlers here; the responder delivers through it.
const handlers = new Map();

function bridgeBus(options) {
  const responder = createResponder(options);
  return {
    requests: responder.requests,
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
    emit(channel, data) {
      if (channel === "subagents:rpc:v1:request") responder.handle(data);
    },
  };
}

function createWrapper({ chatWorkspace = false, alive = true, bus, extensions, closeController = new AbortController() } = {}) {
  return {
    isChatWorkspace: () => chatWorkspace,
    isAlive: () => alive,
    getSubagentsEventBus: () => bus,
    getLifecycleAbortSignal: () => closeController.signal,
    inner: {
      resourceLoader: {
        getExtensions: () => ({ extensions: extensions ?? [PI_SUBAGENTS_EXTENSION] }),
      },
    },
  };
}

function installSessions(t, entries) {
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map(Object.entries(entries));
  t.after(() => {
    globalThis.__piSessions = previous;
    handlers.clear();
  });
}

const RUNS = [
  {
    id: "run-1",
    kind: "subagent",
    label: "reviewer",
    state: "running",
    startedAt: 100,
    updatedAt: 200,
    activity: { currentTool: "read" },
  },
];

function context(id) {
  return { params: Promise.resolve({ id }) };
}

function post(body) {
  return new Request("http://localhost/api/agent/x/subagents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GET returns a normalized snapshot through the session's own bridge", async (t) => {
  const bus = bridgeBus({ sessionId: "session-a", runs: RUNS });
  installSessions(t, { "session-a": createWrapper({ bus }) });

  const response = await GET(new Request("http://localhost/api/agent/session-a/subagents"), context("session-a"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.available, true);
  assert.equal(body.activeCount, 1);
  assert.equal(body.runs[0].runId, "run-1");
  assert.equal(body.runs[0].status, "running");
  assert.deepEqual(body.runs[0].operations, { stop: true, steer: true, interrupt: true, inspect: true });
  assert.equal(body.capabilities.protocolVersion, 1);

  // The poll went through ping then status, both on this session's bus.
  assert.deepEqual(bus.requests.map((request) => request.method), ["ping", "status"]);
});

test("GET degrades without errors: unknown session, chat, missing package, missing bus", async (t) => {
  const chatBus = bridgeBus({ sessionId: "chat" });
  installSessions(t, {
    "chat": createWrapper({ chatWorkspace: true, bus: chatBus }),
    "bare": createWrapper({ extensions: [] }),
    "legacy": createWrapper({ bus: undefined }),
    "closing": Object.assign(createWrapper({ bus: bridgeBus({ sessionId: "closing" }) }), { isAlive: () => false }),
  });

  let response = await GET(new Request("http://localhost/x"), context("nope"));
  assert.equal(response.status, 404);

  response = await GET(new Request("http://localhost/x"), context("chat"));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, "chat-workspace");
  // The chat session never even initialized the package: its bus was never contacted.
  assert.deepEqual(chatBus.requests, []);

  response = await GET(new Request("http://localhost/x"), context("bare"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { available: false, reason: "not-loaded" });

  response = await GET(new Request("http://localhost/x"), context("legacy"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { available: false, reason: "no-bus" });

  response = await GET(new Request("http://localhost/x"), context("closing"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reason, "session-closed");
});

test("GET reports an unresponsive bridge as unavailable", async (t) => {
  const silent = { on: () => () => {}, emit: () => {} };
  installSessions(t, {
    "silent": createWrapper({ bus: silent }),
  });
  // Ping waits for the (shortened) timeout: patch it via the exported constant is not
  // possible from here, so assert the failure mode with the default 3s.
  const response = await GET(new Request("http://localhost/x"), context("silent"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.available, false);
  assert.equal(body.reason, "unresponsive");
});

test("GET reports a bridge that does not advertise status as incompatible", async (t) => {
  const bus = bridgeBus({ sessionId: "a", methods: ["ping"] });
  installSessions(t, { "a": createWrapper({ bus }) });

  const response = await GET(new Request("http://localhost/x"), context("a"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.available, false);
  assert.equal(body.reason, "incompatible");
  // Only the ping probe ran; no status request was made against a bridge that
  // does not advertise it.
  assert.deepEqual(bus.requests.map((request) => request.method), ["ping"]);
});

test("GET reports a failing status call as status-failed", async (t) => {
  const bus = bridgeBus({
    sessionId: "a",
    statusError: { code: "no_active_session", message: "No active session to inspect." },
  });
  installSessions(t, { "a": createWrapper({ bus }) });

  const response = await GET(new Request("http://localhost/x"), context("a"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.available, false);
  assert.equal(body.reason, "status-failed");
  assert.match(body.error, /no_active_session/);
});

test("POST inspect returns a bounded transcript and forwards only known params", async (t) => {
  const bus = bridgeBus({ sessionId: "session-a" });
  installSessions(t, { "session-a": createWrapper({ bus }) });

  const response = await POST(
    post({ action: "inspect", runId: "run-9", index: 1, lines: 30 }),
    context("session-a"),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.action, "inspect");
  assert.equal(body.view.runId, "run-9");
  assert.equal(body.view.lines, 30);
  assert.equal(body.view.index, 1);
  assert.match(body.view.text, /transcript tail of run-9/);

  const status = bus.requests.find((request) => request.method === "status");
  assert.deepEqual(status.params, { id: "run-9", view: "transcript", lines: 30, index: 1 });
});

test("POST stop, steer and interrupt reach only their own session's bus", async (t) => {
  const busA = bridgeBus({ sessionId: "a" });
  const busB = bridgeBus({ sessionId: "b" });
  installSessions(t, {
    "a": createWrapper({ bus: busA }),
    "b": createWrapper({ bus: busB }),
  });

  let response = await POST(post({ action: "stop", runId: "run-1" }), context("a"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.state, "stopping");

  response = await POST(post({ action: "steer", runId: "run-1", message: " focus " }), context("a"));
  assert.equal(response.status, 200);
  const steerRequest = busA.requests.find((request) => request.method === "steer");
  assert.equal(steerRequest.params.id, "run-1");
  assert.equal(steerRequest.params.message, "focus");
  // Steer targets run ids only — no display-offset child index is forwarded.
  assert.equal("index" in steerRequest.params, false);

  response = await POST(post({ action: "interrupt", runId: "run-1" }), context("b"));
  assert.equal(response.status, 200);
  // Session B's bus saw only its own ping + interrupt; session A's bus was untouched by B.
  assert.deepEqual(busB.requests.map((request) => request.method), ["ping", "interrupt"]);
  assert.deepEqual(
    busA.requests.map((request) => request.method),
    ["ping", "stop", "ping", "steer"],
  );
});

test("POST interrupt and a child-scoped stop forward only the package's own ids", async (t) => {
  const bus = bridgeBus({ sessionId: "a" });
  installSessions(t, { "a": createWrapper({ bus }) });

  let response = await POST(post({ action: "interrupt", runId: "run-1" }), context("a"));
  assert.equal(response.status, 200);
  assert.deepEqual(
    bus.requests.find((request) => request.method === "interrupt").params,
    { id: "run-1" },
  );

  response = await POST(
    post({ action: "stop", runId: "run-1", childId: "lane-key" }),
    context("a"),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    bus.requests.find((request) => request.method === "stop").params,
    { id: "run-1", childId: "lane-key" },
  );
});

test("a run id owned by another session is refused by the bridge and mapped to 404", async (t) => {
  const bus = bridgeBus({ sessionId: "a", foreignRunIds: new Set(["foreign-run"]) });
  installSessions(t, { "a": createWrapper({ bus }) });

  const response = await POST(post({ action: "stop", runId: "foreign-run" }), context("a"));
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.reason, "not_found");
  assert.match(body.error, /was not found in the active session/);
});

test("an action the bridge does not advertise is refused without reaching the package", async (t) => {
  // An older package that answers ping but does not advertise stop.
  const bus = bridgeBus({ sessionId: "a", capabilities: { status: true, steer: true, interrupt: true, stop: false } });
  installSessions(t, { "a": createWrapper({ bus }) });

  const response = await POST(post({ action: "stop", runId: "run-1" }), context("a"));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.reason, "capability-unavailable");
  // Only the ping probe reached the bridge; the stop itself was never forwarded.
  assert.deepEqual(bus.requests.map((request) => request.method), ["ping"]);
});

test("a wrapper that closes mid-call cancels its RPC and reports session-closed", async (t) => {
  // A bus that answers ping but never answers the action.
  const controller = new AbortController();
  const stalled = {
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
    emit(channel, data) {
      if (channel !== "subagents:rpc:v1:request") return;
      if (data.method === "ping") {
        queueMicrotask(() => {
          for (const handler of handlers.get(`subagents:rpc:v1:reply:${data.requestId}`) ?? []) {
            handler({
              version: 1,
              requestId: data.requestId,
              method: "ping",
              success: true,
              data: {
                version: 1,
                methods: ["ping", "status", "steer", "interrupt", "stop"],
                capabilities: { status: true, steer: true, interrupt: true, stop: true },
              },
            });
          }
        });
        return;
      }
      // The action stalls; the wrapper closes shortly after.
      setTimeout(() => controller.abort(new Error("AgentSessionWrapper destroyed")), 10);
    },
  };
  installSessions(t, { "a": createWrapper({ bus: stalled, closeController: controller }) });

  const response = await POST(post({ action: "stop", runId: "run-1" }), context("a"));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "session-closed");
});

test("POST rejects passthrough attempts and invalid parameters", async (t) => {
  const bus = bridgeBus({ sessionId: "a" });
  installSessions(t, { "a": createWrapper({ bus }) });

  const rejections = [
    [{ action: "stop", runId: "run-1", dir: "C:/other/session" }, /Unknown fields/],
    [{ action: "steer", runId: "run-1", message: "hi", method: "spawn" }, /Unknown fields/],
    [{ action: "steer", runId: "run-1", message: "hi", index: 0 }, /Unknown fields/],
    [{ action: "inspect", runId: "run-1", path: "C:/secrets" }, /Unknown fields/],
    [{ action: "resume", runId: "run-1" }, /action must be/],
    [{ action: "stop" }, /runId must be/],
    [{ action: "stop", runId: "has space" }, /runId must be/],
    [{ action: "stop", runId: `x`.repeat(257) }, /runId must be/],
    [{ action: "steer", runId: "run-1", message: "   " }, /message must be/],
    [{ action: "steer", runId: "run-1", message: "x".repeat(9_000) }, /message must be/],
    [{ action: "inspect", runId: "run-1", lines: 0 }, /lines must be/],
    [{ action: "inspect", runId: "run-1", lines: 501 }, /lines must be/],
    [{ action: "inspect", runId: "run-1", index: -1 }, /index must be/],
    [{ action: "steer", runId: "run-1", message: "x", mode: "plan" }, /mode must be/],
  ];
  for (const [body, pattern] of rejections) {
    const response = await POST(post(body), context("a"));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, pattern);
  }

  // A non-JSON body is refused too.
  const raw = await POST(
    new Request("http://localhost/x", { method: "POST", body: "not json" }),
    context("a"),
  );
  assert.equal(raw.status, 400);

  // Nothing but pings were sent while every request above was refused.
  assert.ok(bus.requests.every((request) => request.method === "ping"));
});

test("POST refuses chats, missing sessions and unavailable bridges", async (t) => {
  const silent = { on: () => () => {}, emit: () => {} };
  installSessions(t, {
    "chat": createWrapper({ chatWorkspace: true, bus: bridgeBus({ sessionId: "chat" }) }),
    "bare": createWrapper({ extensions: [] }),
    "silent": createWrapper({ bus: silent }),
  });

  let response = await POST(post({ action: "stop", runId: "run-1" }), context("nope"));
  assert.equal(response.status, 404);

  response = await POST(post({ action: "stop", runId: "run-1" }), context("chat"));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, "chat-workspace");

  response = await POST(post({ action: "stop", runId: "run-1" }), context("bare"));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).reason, "not-loaded");

  response = await POST(post({ action: "stop", runId: "run-1" }), context("silent"));
  assert.equal(response.status, 504);
  assert.equal((await response.json()).reason, "unresponsive");
});

test("a maliciously large RPC reply is bounded before it reaches the client", async (t) => {
  const huge = {
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
    emit(channel, data) {
      if (channel !== "subagents:rpc:v1:request") return;
      const request = data;
      const replyChannel = `subagents:rpc:v1:reply:${request.requestId}`;
      const bomb = request.method === "ping"
        ? { version: 1, requestId: request.requestId, success: true, data: { version: 1, methods: ["ping", "status", "steer", "interrupt", "stop"], capabilities: { status: true, steer: true, interrupt: true, stop: true } } }
        : {
            version: 1,
            requestId: request.requestId,
            success: true,
            data: {
              runId: "run-1",
              blob: "B".repeat(5_000_000),
              list: Array.from({ length: 10_000 }, (_, index) => ({ deep: { deep: { deep: { deep: { deep: { deep: { deep: index } } } } } } })),
            },
          };
      queueMicrotask(() => {
        for (const handler of handlers.get(replyChannel) ?? []) handler(bomb);
      });
    },
  };
  installSessions(t, { "a": createWrapper({ bus: huge }) });

  const response = await POST(post({ action: "stop", runId: "run-1" }), context("a"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(body.result.blob.length <= 240);
  assert.ok(body.result.list.length <= 32);
  const serialized = JSON.stringify(body);
  assert.ok(serialized.length < 100_000, `response ballooned to ${serialized.length}`);
});
