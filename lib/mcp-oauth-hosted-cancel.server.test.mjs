import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { MemoryOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
import { startFakeOAuthServer } from "./__fixtures__/mcp-oauth-server.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { signInMcpWithHostedCallback } = await jiti.import("./mcp-oauth-hosted.server.ts");

test("cancellation closes hosted listener and performs no token exchange", async (t) => {
  const fake = await startFakeOAuthServer();
  t.after(() => fake.close());
  const controller = new AbortController();
  let closed = false;
  const wait = (signal) => new Promise((_, reject) => {
    if (signal.aborted) reject(new Error("cancelled"));
    else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  });
  const task = signInMcpWithHostedCallback({ serverUrl: fake.url, store: new MemoryOAuthStateStore(), settings: {}, prompt: {
    showAuthorizationUrl: () => controller.abort(),
    promptForRedirectUrl: wait,
  } }, async () => ({ redirectUrl: "http://127.0.0.1:43983/callback", wait: (_state, _url, signal) => wait(signal), close: () => { closed = true; } }), controller.signal);
  await assert.rejects(task);
  assert.equal(closed, true);
  assert.deepEqual(fake.issued.grants, []);
});
