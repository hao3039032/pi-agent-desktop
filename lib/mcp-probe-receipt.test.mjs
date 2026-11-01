import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { startFakeOAuthServer } from "./__fixtures__/mcp-oauth-server.mjs";

const root = await mkdtemp(join(tmpdir(), "mcp-probe-receipt-"));
const agentDir = join(root, "agent");
await mkdir(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { managedMcpProbeTarget, probeMcpServer } = await jiti.import("./mcp-probe-service.server.ts");
const { McpProbeCredentialFence } = await jiti.import("./mcp-probe-receipt.ts");
const { guardMcpOAuthStateStore, mcpSignOutGuard } = await jiti.import("./mcp-sign-out.ts");
test.after(async () => { await rm(root, { recursive: true, force: true }); });
const request = (name) => ({ body: { scope: "global", name }, agentDir, allowedRoots: new Set() });
const writeConfig = (servers) => writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));

test("probe fence distinguishes blocked late calls, entered failures and unsupported async stores", async () => {
  const closed = new McpProbeCredentialFence();
  const store = guardMcpOAuthStateStore({ load: () => undefined, save: () => {} }, closed.guard(), (call) => closed.storeCall(call));
  assert.equal(store.load(), undefined);
  assert.deepEqual(closed.close(), { schema: 1, localWritesClosed: true, pastLocal: "settled", remoteToken: "none-observed" });
  assert.throws(() => store.save({ serverUrl: "https://example.invalid" }), /closed/);
  assert.equal(closed.close().pastLocal, "settled", "a pre-call denial is not an uncertain prior write");
  const failure = new McpProbeCredentialFence();
  const failedStore = guardMcpOAuthStateStore({ load: () => { throw new Error("disk"); }, save: () => {} }, failure.guard(), (call) => failure.storeCall(call));
  assert.throws(() => failedStore.load(), /disk/);
  assert.equal(failure.close().pastLocal, "unknown");
  const deferred = new McpProbeCredentialFence();
  const asyncStore = guardMcpOAuthStateStore({ load: async () => undefined, save: () => {} }, deferred.guard(), (call) => deferred.storeCall(call));
  await asyncStore.load();
  assert.deepEqual(deferred.close(), { schema: 1, localWritesClosed: false, pastLocal: "unknown", remoteToken: "none-observed" });
});

test("preflight rechecks mode and configuration; broad stdio and provider-auth never look read-only", async () => {
  const fake = await startFakeOAuthServer();
  try {
    await writeConfig({ fixture: { command: process.execPath, args: ["-e", ""] }, provider: { url: fake.url, auth: { provider: "fixture" } }, command: { url: fake.url, headers: { X: "!echo fixture" } } });
    const stdio = await managedMcpProbeTarget(request("fixture"));
    assert.equal(stdio.kind, "broad");
    assert.equal((await managedMcpProbeTarget(request("provider"))).kind, "broad");
    assert.equal((await managedMcpProbeTarget(request("command"))).kind, "broad");
    await writeConfig({ fixture: { url: fake.url } });
    await assert.rejects(probeMcpServer({ ...request("fixture"), probeAdmission: stdio }), (error) => error.reason === "invalid-request");
    const oauth = await managedMcpProbeTarget(request("fixture"));
    assert.equal(oauth.kind, "mcp-oauth");
    assert.equal(oauth.probeAdmissionSchema, 1);
    await writeConfig({ fixture: { url: fake.url, timeout: 12 } });
    await assert.rejects(probeMcpServer({ ...request("fixture"), probeAdmission: oauth }), (error) => error.reason === "invalid-request");
  } finally { await fake.close(); }
});

test("real isolated stdio probe remains broad even when it connects", async () => {
  await writeConfig({ fixture: { command: process.execPath, args: [resolve("lib/__fixtures__/mcp-env-server.mjs")] } });
  const admission = await managedMcpProbeTarget(request("fixture"));
  assert.equal(admission.kind, "broad");
  const answer = await probeMcpServer({ ...request("fixture"), probeAdmission: admission });
  assert.equal(answer.result.state, "connected");
  assert.equal(answer._probeReceipt.remoteToken, "unknown", "broad mode cannot prove the child has no other effects");
});

test("ordinary non-OAuth HTTP has a terminal credential receipt", async () => {
  const fake = await startFakeOAuthServer();
  try {
    await writeConfig({ fixture: { url: fake.url, headers: { Authorization: "Bearer fake" } } });
    const admission = await managedMcpProbeTarget(request("fixture"));
    assert.equal(admission.kind, "http-no-mcp-oauth");
    const answer = await probeMcpServer({ ...request("fixture"), probeAdmission: admission });
    assert.equal(answer.result.state, "failed");
    assert.deepEqual(answer._probeReceipt, { schema: 1, localWritesClosed: true, pastLocal: "settled", remoteToken: "none-observed" });
  } finally { await fake.close(); }
});

test("late OAuth refresh cannot write after probe receipt or revoke another guard", async () => {
  const fake = await startFakeOAuthServer();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const reached = new Promise((resolve) => { started = resolve; });
  try {
    await writeConfig({ fixture: { url: fake.url } });
    const admission = await managedMcpProbeTarget(request("fixture"));
    fake.issued.refresh.add("fixture-refresh");
    fake.hooks.beforeRefresh = async () => { started(); await gate; };
    const authPath = join(agentDir, "mcp-auth.json");
    const initial = { [admission.canonicalKey]: { serverUrl: fake.url, clientInformation: { client_id: "fixture-client", redirect_uris: ["http://127.0.0.1:1/callback"], token_endpoint_auth_method: "none" }, tokens: { access_token: "expired", refresh_token: "fixture-refresh", token_type: "Bearer" } } };
    await writeFile(authPath, JSON.stringify(initial));
    const unrelatedGuard = mcpSignOutGuard("fixture", fake.url);
    const controller = new AbortController();
    const task = probeMcpServer({ ...request("fixture"), probeAdmission: admission, signal: controller.signal });
    await reached;
    controller.abort();
    const answer = await task;
    assert.equal(answer.result.timedOut, true);
    assert.deepEqual(answer._probeReceipt, { schema: 1, localWritesClosed: true, pastLocal: "settled", remoteToken: "unknown" });
    const before = await readFile(authPath, "utf8");
    release();
    await delay(200);
    assert.equal(await readFile(authPath, "utf8"), before, "late refresh did not write");
    const after = await managedMcpProbeTarget(request("fixture"));
    assert.equal(after.generation, admission.generation, "probe closure does not revoke another flow");
    assert.doesNotThrow(unrelatedGuard, "the probe's private fence does not revoke the canonical guard");
    assert.deepEqual(fake.issued.grants, ["refresh_token"]);
  } finally { release(); await fake.close(); }
});
