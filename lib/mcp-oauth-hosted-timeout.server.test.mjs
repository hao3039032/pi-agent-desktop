import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";
import { MemoryOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { approveSignIn, startFakeOAuthServer } from "./__fixtures__/mcp-oauth-server.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { signInMcpWithHostedCallback } = await jiti.import("./mcp-oauth-hosted.server.ts");
const { startMcpSignIn, cancelMcpSignIn, readMcpSignIn, mcpSignInCompletion } = await jiti.import("./mcp-sign-in.ts");
const { noteMcpSignOut, mcpSignInKey } = await jiti.import("./mcp-sign-out.ts");

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function signIn(fake, store, controller = new AbortController()) {
  let page;
  return signInMcpWithHostedCallback({ serverUrl: fake.url, store, settings: {}, prompt: {
    showAuthorizationUrl: (url) => { page = url.href; },
    promptForRedirectUrl: () => approveSignIn(page),
  } }, async () => ({
    redirectUrl: "http://127.0.0.1:43981/callback",
    wait: (_state, _url, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    close: () => {},
  }), controller.signal);
}

test("token and refresh deadlines report remote uncertainty without retry or late local writes", async (t) => {
  await Promise.all(["authorization_code", "refresh_token"].map(async (grant) => {
    const fake = await startFakeOAuthServer();
    const release = deferred();
    const received = deferred();
    t.after(async () => { release.resolve(); await fake.close(); });
    const store = new MemoryOAuthStateStore();
    if (grant === "refresh_token") await signIn(fake, store);
    const priorGrants = fake.issued.grants.length;
    const priorTokens = fake.issued.access.size;
    const holdResponse = async (kind) => {
      assert.equal(kind, grant);
      received.resolve();
      await release.promise;
    };
    if (grant === "authorization_code") fake.hooks.beforeTokenBody = holdResponse;
    else fake.hooks.beforeTokenResponse = holdResponse;
    const task = signIn(fake, store);
    await received.promise;
    const storedBeforeTimeout = JSON.stringify(await store.load());
    assert.equal(fake.issued.access.size, priorTokens + 1, "remote already issued a token");
    await assert.rejects(task, (error) => /local sign-in stopped/i.test(error.message) && /remote outcome is unknown/i.test(error.message));
    assert.deepEqual(fake.issued.grants.slice(priorGrants), [grant], "no token request retry or code replay");
    assert.equal(JSON.stringify(await store.load()), storedBeforeTimeout, "deadline writes no returned credential");
    release.resolve();
    await delay(150);
    assert.deepEqual(fake.issued.grants.slice(priorGrants), [grant]);
    assert.equal(JSON.stringify(await store.load()), storedBeforeTimeout, "late remote response cannot write credentials");
  }));
});

test("cancelled refresh warns immediately through timeout, success and sign-out guard", async (t) => {
  await Promise.all(["timeout", "success", "signout"].map(async (scenario) => {
    const fake = await startFakeOAuthServer();
    const release = deferred();
    const received = deferred();
    t.after(async () => { release.resolve(); await fake.close(); });
    const store = new MemoryOAuthStateStore();
    await signIn(fake, store);
    fake.hooks.beforeTokenResponse = async () => { received.resolve(); await release.promise; };
    const target = { scope: "global", name: `fixture-${scenario}`, sourcePath: `/fixture-${scenario}`, configKey: scenario,
      config: { url: fake.url }, cwd: "/", url: fake.url };
    let reconnects = 0;
    const deps = {
      open: () => ({
        connect: async () => ({ state: "needs-auth", tools: [], toolCount: 0, durationMs: 0 }),
        reconnect: async () => { reconnects++; throw new Error("must not reconnect"); },
        oauthSettings: () => ({}), redact: (value) => value, close: async () => {},
      }),
      signIn: (options, signal, onTokenRequest) => signInMcpWithHostedCallback(options, async () => ({
        redirectUrl: "http://127.0.0.1:43981/callback", wait: () => { throw new Error("unexpected browser"); }, close: () => {},
      }), signal, onTokenRequest),
      store: () => store,
      isCancelled: () => false,
    };
    const { flow } = startMcpSignIn(target, deps);
    const completion = mcpSignInCompletion(flow.flowId);
    await received.promise;
    const before = JSON.stringify(await store.load());
    if (scenario === "signout") noteMcpSignOut(mcpSignInKey(target.name, target.url));
    const cancelled = cancelMcpSignIn(flow.flowId);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.warning, "remote-outcome-unknown");
    assert.equal(readMcpSignIn(flow.flowId).warning, "remote-outcome-unknown");
    let unwound = false;
    void completion.then(() => { unwound = true; });
    await delay(20);
    assert.equal(unwound, false, "cancel does not release the task while the request is in flight");
    if (scenario !== "timeout") release.resolve();
    await completion;
    assert.equal(readMcpSignIn(flow.flowId).warning, "remote-outcome-unknown");
    assert.equal(reconnects, 0);
    assert.deepEqual(fake.issued.grants, ["authorization_code", "refresh_token"]);
    if (scenario === "success") assert.notEqual(JSON.stringify(await store.load()), before, "cancel alone permits an already completed refresh to store tokens");
    else assert.equal(JSON.stringify(await store.load()), before, "timeout/sign-out prevents the late credential write");
    release.resolve();
    await delay(100);
    if (scenario !== "success") assert.equal(JSON.stringify(await store.load()), before);
  }));
});

test("user cancellation does not abort a token exchange already in flight", async (t) => {
  const fake = await startFakeOAuthServer();
  const release = deferred();
  const received = deferred();
  t.after(async () => { release.resolve(); await fake.close(); });
  fake.hooks.beforeTokenResponse = async () => { received.resolve(); await release.promise; };
  const store = new MemoryOAuthStateStore();
  const controller = new AbortController();
  const task = signIn(fake, store, controller);
  await received.promise;
  controller.abort();
  release.resolve();
  await task;
  assert.equal(fake.issued.grants.length, 1);
  assert.ok((await store.load()).tokens.access_token);
});
