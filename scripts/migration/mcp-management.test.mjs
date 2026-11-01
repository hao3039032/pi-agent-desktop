import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { buildProjectionInto } from "./build-management-modules.mjs";
import { resolvePiCliBin } from "../../lib/pi-rpc/test-utils.mjs";

const executable = resolvePiCliBin();
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { PiRpcClient } = await jiti.import("../../lib/pi-rpc/client.ts");

test("real management pi reads and edits MCP without starting configured servers", { skip: executable ? false : "PI_CLI_BIN not set" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-management-"));
  let client;
  try {
    const cwd = join(root, "project"), agentDir = join(root, "agent"), managed = join(root, "managed", "node_modules");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(managed, { recursive: true });
    await symlink(resolve("node_modules/@earendil-works"), join(managed, "@earendil-works"), "dir");
    await buildProjectionInto(managed);
    const marker = join(root, "started");
    await writeFile(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { project: { command: process.execPath, args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`] }, probe: { command: process.execPath, args: [resolve("lib/__fixtures__/mcp-env-server.mjs")] } } }));
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { oauth: { url: "http://127.0.0.1:9/mcp?token=fixture-secret" }, noauth: { url: "http://127.0.0.1:9/mcp?token=fixture-secret", headers: { Authorization: "Bearer fake" } } } }));
    const nonce = "fixture-nonce";
    const logs = [];
    client = new PiRpcClient(executable, { cwd, args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", resolve("lib/pi-rpc/assets/pi-web-management.mjs")], env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_WEB_MANAGED_MODULES: managed, PI_WEB_MGMT_NONCE: nonce }, onLog: (message) => logs.push(message) });
    const envelopes = [];
    const progress = [];
    client.onUi("notify", (record) => {
      if (record.message?.startsWith("PI_WEB_MGMT_V1 ")) envelopes.push(JSON.parse(record.message.slice(15)));
      if (record.message?.startsWith("PI_WEB_MGMT_PROGRESS_V1 ")) progress.push(record.message);
    });
    let n = 0;
    async function call(op, args) {
      const rid = `fixture-${++n}`;
      const token = Buffer.from(JSON.stringify({ op, args: { agentDir, allowedRoots: [cwd], ...args }, nonce })).toString("base64url");
      const ack = await client.command("prompt", { message: `/pi-web:mgmt ${rid} ${token}` }, 30000);
      assert.equal(ack.disposition, "handled");
      for (let i = 0; i < 300; i++) { const index = envelopes.findIndex((item) => item.rid === rid); if (index >= 0) { const [answer] = envelopes.splice(index, 1); assert.equal(answer.ok, true, JSON.stringify(answer)); return answer.result; } await new Promise((r) => setTimeout(r, 100)); }
      throw new Error(`timeout ${op}`);
    }
    const listing = await call("trust.projectListing", { cwd });
    assert.equal(listing.mcpServers[0].name, "project");
    const trusted = await call("trust.set", { cwd });
    assert.equal(trusted.trusted, true);
    const overview = await call("mcp.configGet", { cwd });
    assert.equal(overview.mcp.available, true, JSON.stringify(overview.mcp));
    assert.ok(overview.servers.some((server) => server.name === "project"));
    assert.doesNotMatch(JSON.stringify(overview), /fixture-secret/);
    const identity = await call("mcp.credentialTarget", { scope: "global", name: "oauth" });
    const revoked = await call("mcp.signOutCooperative", { scope: "global", name: "oauth", expectedCanonicalKey: identity.canonicalKey, expectedConfigKey: identity.configKey });
    assert.equal(identity.schema, 1);
    assert.equal(identity.admissionSchema, 1);
    assert.equal(identity.canonicalKey, "mcp__oauth|http://127.0.0.1:9/mcp?token=fixture-secret");
    assert.equal(identity.legacyKey, "http://127.0.0.1:9/mcp?token=fixture-secret");
    assert.equal(revoked.schema, 1);
    assert.equal(revoked.revocation.canonicalKey, identity.canonicalKey);
    assert.equal(revoked.revocation.legacyKey, identity.legacyKey);
    assert.equal(revoked.revocation.configKey, identity.configKey);
    assert.equal(revoked.revocation.generation, identity.generation + 1);
    assert.doesNotMatch(JSON.stringify(revoked.result), /fixture-secret/);
    const fresh = await call("mcp.credentialTarget", { scope: "global", name: "oauth" });
    const withoutLegacy = { ...fresh };
    delete withoutLegacy.legacyKey;
    for (const op of ["mcp.test", "mcp.signInStart"]) {
      for (const admission of [identity, withoutLegacy, { ...fresh, legacyKey: "wrong" }]) {
        const refused = await call(op, { scope: "global", name: "oauth", credentialAdmission: admission });
        assert.equal(refused.mcpRefusal.reason, "invalid-request");
        assert.doesNotMatch(JSON.stringify(refused), /fixture-secret/);
      }
    }
    assert.doesNotMatch(JSON.stringify(progress), /fixture-secret/);
    assert.doesNotMatch(JSON.stringify(logs), /fixture-secret/);
    const httpTarget = await call("mcp.probeTarget", { scope: "global", name: "noauth" });
    assert.equal(httpTarget.probeAdmissionSchema, 1);
    assert.equal(httpTarget.kind, "http-no-mcp-oauth");
    const httpProbe = await call("mcp.test", { scope: "global", name: "noauth", probeAdmission: httpTarget });
    assert.deepEqual(httpProbe._probeReceipt, { schema: 1, localWritesClosed: true, pastLocal: "settled", remoteToken: "none-observed" });
    assert.doesNotMatch(JSON.stringify(httpProbe), /fixture-secret/);
    const stdioTarget = await call("mcp.probeTarget", { cwd, scope: "project", name: "probe" });
    assert.equal(stdioTarget.kind, "broad");
    const stdioProbe = await call("mcp.test", { cwd, scope: "project", name: "probe", probeAdmission: stdioTarget });
    assert.equal(stdioProbe.result.state, "connected");
    assert.equal(stdioProbe._probeReceipt.remoteToken, "unknown");
    const added = await call("mcp.configAction", { cwd, action: "add", scope: "global", text: "node fixture.js", name: "fixture" });
    assert.equal(added.added.name, "fixture", JSON.stringify(added));
    const duplicate = await call("mcp.configAction", { cwd, action: "add", scope: "global", text: "node fixture.js", name: "fixture" });
    assert.equal(duplicate.mcpRefusal.reason, "name-taken");
    assert.equal(duplicate.mcpRefusal.details.name, "fixture");
    assert.ok(duplicate.mcpRefusal.details.suggestedName);
    const removed = await call("mcp.configAction", { cwd, action: "remove", scope: "global", name: "fixture" });
    const restored = await call("mcp.configAction", { cwd, action: "undo", token: removed.undo.token });
    assert.equal(restored.restored.name, "fixture");
    await assert.rejects(access(marker), { code: "ENOENT" });
    const probe = await call("mcp.test", { cwd, scope: "project", name: "probe" });
    assert.equal(probe.result.state, "connected", JSON.stringify(probe));
    assert.ok(probe.result.tools.some((tool) => tool.name === "env_has" && tool.readOnly));
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    if (client) await client.close(5000);
    await rm(root, { recursive: true, force: true });
  }
});
