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
const { mcpSignInKey, mcpSignOutGuard, revokeMcpCredentialWriters, guardedCredentialStore } = await jiti.import("./mcp-sign-out.ts");
const { loadPiSdkInternals } = await jiti.import("./pi-sdk-internals.ts");
const { trustProject } = await jiti.import("./project-trust.ts");
const { startManagedMcpSignIn, waitManagedMcpSignIn } = await jiti.import("./mcp-sign-in-service.server.ts");
const { managedMcpCredentialTarget, signOutMcpCooperative } = await jiti.import("./mcp-service.server.ts");
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

test("private target and revocation use SDK canonical key without disclosing secrets in public start", async () => {
  const url = "http://127.0.0.1:9/mcp?token=fixture-secret";
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url } } }));
  const project = join(root, "project");
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: "http://127.0.0.1:09/mcp?token=fixture-secret" } } }));
  trustProject(project, agentDir);
  const request = { body: { scope: "global", name: "fixture" }, agentDir, allowedRoots: new Set() };
  const projectRequest = { body: { scope: "project", name: "fixture", cwd: project }, agentDir, allowedRoots: new Set([project]) };
  const target = await managedMcpCredentialTarget(request);
  const projectTarget = await managedMcpCredentialTarget(projectRequest);
  assert.equal(projectTarget.canonicalKey, target.canonicalKey, "global/project and URL aliases use the same SDK key");
  assert.equal(target.schema, 1);
  assert.equal(target.canonicalKey, mcpSignInKey("fixture", url));
  const ack = await signOutMcpCooperative({ ...projectRequest, expectedCanonicalKey: projectTarget.canonicalKey, expectedConfigKey: projectTarget.configKey });
  assert.equal(ack.schema, 1);
  assert.equal(ack.revocation.canonicalKey, target.canonicalKey);
  assert.equal(ack.revocation.configKey, projectTarget.configKey);
  assert.equal(ack.revocation.generation, target.generation + 1);
  assert.equal(ack.result.signedOut.name, "fixture");
  const start = await startManagedMcpSignIn(request);
  assert.doesNotMatch(JSON.stringify(start), /fixture-secret/);
  await waitManagedMcpSignIn(start.flowId);
});
