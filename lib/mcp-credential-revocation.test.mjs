import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "mcp-revocation-"));
const agentDir = join(root, "agent");
await mkdir(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { mcpOAuthStoreKeys, mcpSignInKey, mcpSignOutCount, mcpSignOutGuard, revokeMcpCredentialWriters, guardedCredentialStore, guardMcpOAuthStateStore } = await jiti.import("./mcp-sign-out.ts");
const { loadPiSdkInternals } = await jiti.import("./pi-sdk-internals.ts");
const { trustProject } = await jiti.import("./project-trust.ts");
const { startManagedMcpSignIn, waitManagedMcpSignIn } = await jiti.import("./mcp-sign-in-service.server.ts");
const { managedMcpCredentialTarget, signOutMcpCooperative } = await jiti.import("./mcp-service.server.ts");
const { probeMcpServer } = await jiti.import("./mcp-probe-service.server.ts");
const { testMcpServer } = await jiti.import("./mcp-test.ts");
const { cancelMcpSignIn } = await jiti.import("./mcp-sign-in.ts");
test.after(async () => { await rm(root, { recursive: true, force: true }); });

test("canonical key revocation bars old guards, not other keys or the new generation", async () => {
  const url = "https://EXAMPLE.com:443/mcp?secret=fixture-secret";
  const alias = "https://example.com/mcp?secret=fixture-secret";
  const old = mcpSignOutGuard("same-name", url);
  const same = mcpSignOutGuard("same_name", alias);
  const other = mcpSignOutGuard("different", alias);
  const ack = revokeMcpCredentialWriters("same_name", alias);
  assert.equal(ack.canonicalKey, mcpSignInKey("same-name", url));
  assert.ok(Number.isSafeInteger(ack.generation));
  assert.throws(old, { name: "McpSignedOutError" });
  assert.throws(same, { name: "McpSignedOutError" });
  assert.doesNotThrow(other);
  assert.doesNotThrow(mcpSignOutGuard("same-name", url));
  assert.equal(revokeMcpCredentialWriters("same-name", url).generation, ack.generation + 1);
});

test("legacy identity is derived independently of delimiter-bearing names and remains shared without group revocation", () => {
  const url = "https://EXAMPLE.com:443/mcp?secret=legacy-fixture-secret";
  const first = mcpOAuthStoreKeys("first|suffix", url);
  const second = mcpOAuthStoreKeys("second", url);
  assert.equal(first.key, `mcp__first|suffix|${new URL(url).href}`);
  assert.equal(first.legacyKey, new URL(url).href);
  assert.equal(first.legacyKey, second.legacyKey);
  assert.notEqual(first.key, second.key);
  const admission = { schema: 1, canonicalKey: first.key, legacyKey: first.legacyKey, configKey: "fixture", generation: mcpSignOutCount(first.key) };
  const firstGuard = mcpSignOutGuard("first|suffix", url, "fixture", admission);
  const secondGuard = mcpSignOutGuard("second", url);
  const withoutLegacy = { ...admission };
  delete withoutLegacy.legacyKey;
  for (const invalid of [{ ...admission, legacyKey: "wrong" }, withoutLegacy]) {
    assert.throws(() => mcpSignOutGuard("first|suffix", url, "fixture", invalid), (error) => error.name === "McpCredentialAdmissionError" && !error.message.includes("legacy-fixture-secret"));
  }
  revokeMcpCredentialWriters("first|suffix", url);
  assert.throws(firstGuard, { name: "McpSignedOutError" });
  assert.doesNotThrow(secondGuard, "a shared legacy key does not revoke another canonical key");
});

test("admitted Test does not join a hot-reloaded flight without legacy-key validation", async () => {
  const sdk = await loadPiSdkInternals();
  const url = "https://legacy-flight.example/mcp";
  const name = "flight";
  const configKey = "fixture";
  const target = { scope: "global", name, sourcePath: "/fixture", configKey, cwd: root, config: { url } };
  const { key, legacyKey } = mcpOAuthStoreKeys(name, url);
  const generation = mcpSignOutCount(key);
  const admission = { schema: 1, canonicalKey: key, legacyKey, configKey, generation };
  const symbol = Symbol.for("pi-web:mcp-test-flights");
  const flights = globalThis[symbol] ??= new Map();
  const oldKey = [target.scope, target.sourcePath, name, configKey, target.cwd, generation, "admitted"].join("\0");
  let joinedOld = false;
  const old = Object.assign(Promise.resolve({ state: "connected" }), { join: () => { joinedOld = true; } });
  flights.set(oldKey, old);
  try {
    let connected = false;
    await testMcpServer(target, sdk, { credentialAdmission: admission, connect: async () => {
      connected = true;
      return { state: "failed", tools: [], toolCount: 0, durationMs: 0 };
    } });
    assert.equal(connected, true);
    assert.equal(joinedOld, false);
  } finally { flights.delete(oldKey); }
});

test("the structural public-store wrapper applies the same generation to load and save", () => {
  const url = "https://structural.example/mcp";
  const guard = mcpSignOutGuard("structural", url);
  let state = { serverUrl: url };
  const store = guardMcpOAuthStateStore({ load: () => state, save: (next) => { state = next; } }, guard);
  assert.equal(store.load(), state);
  revokeMcpCredentialWriters("structural", url);
  assert.throws(() => store.load(), { name: "McpSignedOutError" });
  assert.throws(() => store.save({ serverUrl: url }), { name: "McpSignedOutError" });
});

test("cancel while queued for refresh lock prevents later callback execution without a warning window", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let ran = false;
  const windows = [];
  const pending = [];
  class FixtureStore {
    forServer() {
      return { load: () => undefined, save: () => {}, withRefreshLock: async (fn) => { await gate; return fn(); } };
    }
  }
  const controller = new AbortController();
  const wrapped = guardedCredentialStore({ McpOAuthCredentialStore: FixtureStore }, () => {}, { signal: controller.signal, onRefresh: (active) => windows.push(active), onPending: (active) => pending.push(active) });
  const task = wrapped.forServer("queued", "https://queued.example/mcp").withRefreshLock(async () => { ran = true; });
  controller.abort();
  release();
  await assert.rejects(task, /cancelled/i);
  assert.equal(ran, false);
  assert.deepEqual(windows, []);
  assert.deepEqual(pending, [true, false]);
});

test("revoked SDK store cannot migrate legacy state or save after ACK", async () => {
  const sdk = await loadPiSdkInternals();
  assert.equal(sdk.ok, true, sdk.reason);
  const url = "https://legacy-guard.example/mcp";
  const path = join(agentDir, "mcp-auth.json");
  const legacy = { [url]: { serverUrl: url, tokens: { access_token: "legacy", token_type: "Bearer" } } };
  await writeFile(path, JSON.stringify(legacy));
  const guard = mcpSignOutGuard("old", url);
  const store = guardedCredentialStore(sdk, guard).forServer("old", url);
  revokeMcpCredentialWriters("old", url);
  assert.throws(() => store.load(), { name: "McpSignedOutError" });
  assert.throws(() => store.save({ serverUrl: url }), { name: "McpSignedOutError" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), legacy);
});

test("managed targets expose shared legacy identity without merging canonical revocation", async () => {
  const url = "http://127.0.0.1:9/mcp?token=shared-legacy-secret";
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { one: { url }, two: { url }, "invalid|name": { url } } }));
  const request = (name) => ({ body: { scope: "global", name }, agentDir, allowedRoots: new Set() });
  const first = await managedMcpCredentialTarget(request("one"));
  const second = await managedMcpCredentialTarget(request("two"));
  assert.equal(first.legacyKey, second.legacyKey);
  assert.notEqual(first.canonicalKey, second.canonicalKey);
  const secondGuard = mcpSignOutGuard("two", url, second.configKey, second);
  const ack = await signOutMcpCooperative({ ...request("one"), expectedCanonicalKey: first.canonicalKey, expectedConfigKey: first.configKey });
  assert.equal(ack.revocation.legacyKey, first.legacyKey);
  assert.doesNotThrow(secondGuard);
  assert.doesNotMatch(JSON.stringify(ack.result), /shared-legacy-secret/);
  await assert.rejects(managedMcpCredentialTarget(request("invalid|name")), (error) => error.reason === "server-invalid" && !error.message.includes("shared-legacy-secret"));
});

test("cooperative sign-out refuses changed identity or configuration without revocation or deletion", async () => {
  const url = "https://changed.example/mcp";
  const name = "changed";
  const configPath = join(agentDir, "mcp.json");
  const authPath = join(agentDir, "mcp-auth.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { [name]: { url } } }));
  const request = { body: { scope: "global", name }, agentDir, allowedRoots: new Set() };
  const target = await managedMcpCredentialTarget(request);
  const state = { [target.canonicalKey]: { serverUrl: url, tokens: { access_token: "fixture", token_type: "Bearer" } } };
  await writeFile(authPath, JSON.stringify(state));
  const oldGuard = mcpSignOutGuard(name, url);
  await assert.rejects(signOutMcpCooperative({ ...request, expectedCanonicalKey: "wrong", expectedConfigKey: target.configKey }), /target or configuration changed/);
  await writeFile(configPath, JSON.stringify({ mcpServers: { [name]: { url, timeout: 12 } } }));
  await assert.rejects(signOutMcpCooperative({ ...request, expectedCanonicalKey: target.canonicalKey, expectedConfigKey: target.configKey }), /target or configuration changed/);
  assert.doesNotThrow(oldGuard);
  assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), state);
});

test("host admission rejects configuration changes and revocation before guard capture for sign-in and Test", async () => {
  const url = "http://127.0.0.1:9/mcp?token=admission-secret";
  const name = "admitted";
  const configPath = join(agentDir, "mcp.json");
  await writeFile(configPath, JSON.stringify({ mcpServers: { [name]: { url } } }));
  const request = { body: { scope: "global", name }, agentDir, allowedRoots: new Set() };
  const admission = await managedMcpCredentialTarget(request);
  assert.equal(admission.admissionSchema, 1);
  assert.equal(admission.legacyKey, mcpOAuthStoreKeys(name, url).legacyKey);
  const withoutLegacy = { ...admission };
  delete withoutLegacy.legacyKey;
  for (const invalid of [{ ...admission, legacyKey: "wrong" }, withoutLegacy]) {
    for (const start of [startManagedMcpSignIn, probeMcpServer]) {
      await assert.rejects(start({ ...request, credentialAdmission: invalid }), (error) => error.reason === "invalid-request" && !error.message.includes("admission-secret"));
    }
  }
  const validTest = await probeMcpServer({ ...request, credentialAdmission: admission });
  assert.equal(validTest.name, name);
  assert.doesNotMatch(JSON.stringify(validTest), /admission-secret/);
  await writeFile(configPath, JSON.stringify({ mcpServers: { [name]: { url, timeout: 12 } } }));
  for (const start of [startManagedMcpSignIn, probeMcpServer]) {
    await assert.rejects(start({ ...request, credentialAdmission: admission }), (error) => error.reason === "invalid-request" && !error.message.includes("admission-secret"));
  }
  await writeFile(configPath, JSON.stringify({ mcpServers: { [name]: { url } } }));
  const preflight = await managedMcpCredentialTarget(request);
  await signOutMcpCooperative({ ...request, expectedCanonicalKey: preflight.canonicalKey, expectedConfigKey: preflight.configKey });
  for (const start of [startManagedMcpSignIn, probeMcpServer]) {
    await assert.rejects(start({ ...request, credentialAdmission: preflight }), (error) => error.reason === "invalid-request" && !error.message.includes("admission-secret"));
  }
  const legacy = await startManagedMcpSignIn(request);
  assert.equal(typeof legacy.flowId, "string", "the Next-compatible no-admission path remains usable");
  cancelMcpSignIn(legacy.flowId);
  await waitManagedMcpSignIn(legacy.flowId);
});

test("private target and revocation use SDK canonical key without disclosing secrets in public start", async () => {
  const url = "http://127.0.0.1:9/mcp?token=fixture-secret";
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url } } }));
  const project = join(root, "project");
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url } } }));
  trustProject(project, agentDir);
  const request = { body: { scope: "global", name: "fixture" }, agentDir, allowedRoots: new Set() };
  const projectRequest = { body: { scope: "project", name: "fixture", cwd: project }, agentDir, allowedRoots: new Set([project]) };
  const target = await managedMcpCredentialTarget(request);
  const projectTarget = await managedMcpCredentialTarget(projectRequest);
  assert.equal(projectTarget.canonicalKey, target.canonicalKey, "global/project use the same SDK key");
  assert.equal(projectTarget.configKey, target.configKey);
  const projectFlow = await startManagedMcpSignIn({ ...projectRequest, credentialAdmission: target });
  assert.doesNotMatch(JSON.stringify(projectFlow), /fixture-secret/);
  cancelMcpSignIn(projectFlow.flowId);
  await waitManagedMcpSignIn(projectFlow.flowId);
  const captured = mcpSignOutGuard("fixture", url, target.configKey, target);
  assert.equal(target.schema, 1);
  assert.equal(target.canonicalKey, mcpSignInKey("fixture", url));
  const ack = await signOutMcpCooperative({ ...projectRequest, expectedCanonicalKey: projectTarget.canonicalKey, expectedConfigKey: projectTarget.configKey });
  assert.equal(ack.schema, 1);
  assert.equal(ack.revocation.canonicalKey, target.canonicalKey);
  assert.equal(ack.revocation.legacyKey, target.legacyKey);
  assert.equal(ack.revocation.configKey, projectTarget.configKey);
  assert.equal(ack.revocation.generation, target.generation + 1);
  assert.throws(captured, { name: "McpSignedOutError" }, "an established admitted guard is revoked");
  assert.equal(ack.result.signedOut.name, "fixture");
  const start = await startManagedMcpSignIn(request);
  assert.doesNotMatch(JSON.stringify(start), /fixture-secret/);
  await waitManagedMcpSignIn(start.flowId);
});
