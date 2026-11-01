import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { MemoryOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { approveSignIn, startFakeOAuthServer } from "./__fixtures__/mcp-oauth-server.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { signInMcpWithHostedCallback } = await jiti.import("./mcp-oauth-hosted.server.ts");

test("hosted OAuth engine registers, validates PKCE and exchanges the browser response", async (t) => {
  const fake = await startFakeOAuthServer();
  t.after(() => fake.close());
  const store = new MemoryOAuthStateStore();
  let page;
  let closed = false;
  const start = async () => ({
    redirectUrl: "http://127.0.0.1:43981/callback",
    wait: async (state, redirect, signal) => {
      while (!page) await new Promise((resolve) => setTimeout(resolve, 5));
      const response = new URL(await approveSignIn(page));
      assert.equal(response.searchParams.get("state"), state);
      assert.equal(response.origin + response.pathname, redirect.origin + redirect.pathname);
      assert.equal(signal.aborted, false);
      return { code: response.searchParams.get("code") };
    },
    close: () => { closed = true; },
  });
  await signInMcpWithHostedCallback({ serverUrl: fake.url, store, settings: {}, prompt: {
    showAuthorizationUrl: (url) => { page = url.href; },
    promptForRedirectUrl: (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
  } }, start, new AbortController().signal);
  assert.equal(closed, true);
  assert.deepEqual(fake.issued.grants, ["authorization_code"]);
  assert.equal((await store.load()).tokens.access_token.startsWith("access-"), true);
  assert.equal(fake.issued.clients.length, 1);
});

test("manual redirect wins and closes the hosted callback", async (t) => {
  const fake = await startFakeOAuthServer();
  t.after(() => fake.close());
  let page;
  let closed = false;
  const start = async () => ({ redirectUrl: "http://127.0.0.1:43982/callback", wait: (_state, _url, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })), close: () => { closed = true; } });
  await signInMcpWithHostedCallback({ serverUrl: fake.url, store: new MemoryOAuthStateStore(), settings: {}, prompt: {
    showAuthorizationUrl: (url) => { page = url.href; },
    promptForRedirectUrl: () => approveSignIn(page),
  } }, start, new AbortController().signal);
  assert.equal(closed, true);
  assert.deepEqual(fake.issued.grants, ["authorization_code"]);
});
