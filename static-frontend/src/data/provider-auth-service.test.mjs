/**
 * Tests for the provider-auth IPC service (the static build's alias target
 * for lib/provider-auth-service.ts): the ops it calls, the refusal-message
 * surfacing (the routes' 400/409 bodies), and the no-HTTP contract (a raw
 * fetch here would be a production blocker — the static app has no server
 * to answer it).
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

const { bindProviderAuthService } = await jiti.import("./provider-auth-service.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

function bound(handler) {
  const mock = new MockTransport();
  if (handler) for (const [op, impl] of Object.entries(handler)) mock.on(op, impl);
  const client = new IpcClient(mock);
  bindProviderAuthService(client);
  return mock;
}

test("the provider lists ask auth.providers and mirror the oauth field", async () => {
  const calls = [];
  bound({
    "auth.providers": (args) => {
      calls.push(args);
      return {
        providers: [{ id: "anthropic", name: "Anthropic (Claude Pro/Max)", usesCallbackServer: false, loggedIn: true }],
        oauthProviders: [{ id: "anthropic", name: "Anthropic (Claude Pro/Max)", usesCallbackServer: false, loggedIn: true }],
        apiKeyProviders: [{ id: "openai", displayName: "OpenAI", configured: true, modelCount: 4, supportsOAuth: true }],
      };
    },
  });
  const { fetchAuthProviders } = await jiti.import("./provider-auth-service.ts");
  const lists = await fetchAuthProviders();
  assert.deepEqual(calls, [undefined], "no args — the listing is unscoped");
  assert.equal(lists.oauthProviders.length, 1);
  assert.deepEqual(lists.providers, lists.oauthProviders, "providers mirrors oauthProviders");
  assert.equal(lists.apiKeyProviders[0].id, "openai");
});

test("a degenerate listing answer degrades to empty lists, not a crash", async () => {
  bound({ "auth.providers": () => ({}) });
  const { fetchAuthProviders } = await jiti.import("./provider-auth-service.ts");
  const lists = await fetchAuthProviders();
  assert.deepEqual(lists, { providers: [], oauthProviders: [], apiKeyProviders: [] });
});

test("the API-key store posts provider + key; the remove posts the provider", async () => {
  const calls = [];
  bound({
    "auth.apiKeyStore": (args) => {
      calls.push(["store", args]);
      return { success: true };
    },
    "auth.apiKeyDelete": (args) => {
      calls.push(["delete", args]);
      return { success: true };
    },
  });
  const { storeProviderApiKey, deleteProviderApiKey } = await jiti.import("./provider-auth-service.ts");
  await storeProviderApiKey("openai", "sk-ipc-test");
  await deleteProviderApiKey("openai");
  assert.deepEqual(calls, [
    ["store", { provider: "openai", apiKey: "sk-ipc-test" }],
    ["delete", { provider: "openai" }],
  ]);
});

test("a shaped refusal surfaces the route's message verbatim", async () => {
  const mock = new MockTransport();
  mock.fail("auth.apiKeyDelete", {
    code: "credential_type_mismatch",
    message: "anthropic is authenticated with OAuth, not an API key",
  });
  const client = new IpcClient(mock);
  bindProviderAuthService(client);
  const { deleteProviderApiKey } = await jiti.import("./provider-auth-service.ts");
  await assert.rejects(
    deleteProviderApiKey("anthropic"),
    (error) => error instanceof Error
      && error.message === "anthropic is authenticated with OAuth, not an API key",
    "the UI renders the message the route's 409 body carried — no status code interpretation"
  );
});

test("logout asks auth.logout with the provider", async () => {
  const calls = [];
  bound({ "auth.logout": (args) => { calls.push(args); return { ok: true }; } });
  const { logoutProvider } = await jiti.import("./provider-auth-service.ts");
  await logoutProvider("anthropic");
  assert.deepEqual(calls, [{ provider: "anthropic" }]);
});

test("the IPC implementation never issues a raw fetch (no server exists)", async () => {
  const source = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "provider-auth-service.ts"), "utf8");
  // Runtime call forms only: the header comments describe the routes this
  // module replaces, so they may name them.
  assert.equal(/\bfetch\s*\(/.test(source), false, "the IPC service must not fall back to HTTP");
  assert.equal(/EventSource/.test(source), false, "no SSE in the static data layer");
  assert.equal(source.includes("`/api"), false, "no templated /api URLs at runtime");
  assert.equal(source.includes('"/api'), false, "no literal /api URLs at runtime");
});
