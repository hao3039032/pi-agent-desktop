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

  mock.emit({
    subscriptionId: "sub-1",
    epoch: 1,
    seq: 1,
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
    seq: 2,
    kind: "event",
    payload: { type: "success" },
  });

  assert.equal(events.length, 2);
  assert.equal(events[1].type, "success");

  dispose();
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
