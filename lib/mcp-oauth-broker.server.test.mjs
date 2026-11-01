import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { McpOAuthBroker } = await jiti.import("./mcp-oauth-broker.server.ts");

test("task broker rejects cross-flow, stale and duplicate responses", async () => {
  const a = new McpOAuthBroker();
  const b = new McpOAuthBroker();
  const signal = new AbortController().signal;
  const args = { host: "127.0.0.1", redirectHost: "localhost", required: false, path: "/callback", extraPaths: [] };
  const pa = a.start(args, signal);
  const pb = b.start(args, signal);
  const ar = a.request;
  const br = b.request;
  assert.notEqual(ar.id, br.id);
  assert.equal(b.respond({ id: ar.id, kind: "bind", ok: true, redirectUrl: "http://localhost:1/callback" }), false);
  assert.equal(a.respond({ id: ar.id, kind: "bind", ok: true, redirectUrl: "http://localhost:1/callback" }), true);
  assert.equal(a.respond({ id: ar.id, kind: "bind", ok: true }), false);
  const callback = await pa;
  const response = callback.wait("state-a", new URL(callback.redirectUrl), signal);
  const wr = a.request;
  assert.equal(a.respond({ id: ar.id, kind: "bind", ok: true }), false);
  assert.equal(a.respond({ id: wr.id, kind: "wait", ok: true, code: "fake", iss: "https://issuer.example" }), true);
  assert.deepEqual(await response, { code: "fake", iss: "https://issuer.example" });
  callback.close();
  b.close();
  await assert.rejects(pb, /cancelled/);
});

test("aborted wait invalidates its request", async () => {
  const broker = new McpOAuthBroker();
  const controller = new AbortController();
  const pending = broker.start({ host: "127.0.0.1", redirectHost: "127.0.0.1", required: false, path: "/callback", extraPaths: [] }, controller.signal);
  const request = broker.request;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(broker.request, undefined);
  assert.equal(broker.respond({ id: request.id, kind: "bind", ok: true }), false);
});
