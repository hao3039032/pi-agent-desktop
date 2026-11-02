import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const root = resolve(import.meta.dirname, "../../..");
const entry = join(import.meta.dirname, "management-sdk-entry.mjs");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "management-sdk-"));
  const projection = join(dir, "projection");
  const agent = join(dir, "agent");
  mkdirSync(agent);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" };
  delete env.PI_PACKAGE_DIR; delete env.JITI_ALIAS; delete env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  execFileSync(process.execPath, [join(root, "scripts/migration/build-management-modules.mjs"), "--sdk-runtime", "--out", projection], { env, stdio: "pipe" });
  return { dir, projection, agent, env: { ...env, PI_WEB_MANAGED_MODULES: projection, PI_WEB_MANAGEMENT_SDK_ROOT: realpathSync(join(root, "node_modules")), PI_WEB_MANAGEMENT_CLI_VERSION: "1.4.0", PI_WEB_MGMT_NONCE: "test-nonce" } };
}
function call(child, rid, op, args = {}, nonce = "test-nonce") {
  const token = Buffer.from(JSON.stringify({ nonce, op, args })).toString("base64url");
  child.stdin.write(JSON.stringify({ id: `command-${rid}`, type: "prompt", message: `/pi-web:mgmt ${rid} ${token}` }) + "\n");
}
function collect(child) {
  const records = [];
  let buffer = "";
  child.stdout.on("data", data => { buffer += data; let n; while ((n = buffer.indexOf("\n")) >= 0) { records.push(JSON.parse(buffer.slice(0, n))); buffer = buffer.slice(n + 1); } });
  const reply = async rid => {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const message = records.find(record => record.message?.startsWith("PI_WEB_MGMT_V1 ") && JSON.parse(record.message.slice(15)).rid === rid)?.message;
      if (message) return JSON.parse(message.slice(15));
      if (child.exitCode !== null) throw new Error(`management exited ${child.exitCode}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("management response timeout");
  };
  reply.records = () => records;
  return reply;
}

test("management SDK entry serves offline capabilities and models config", async () => {
  const f = fixture();
  const child = spawn(process.execPath, [entry], { env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  const reply = collect(child);
  try {
    call(child, "cap", "sys.capabilities");
    const cap = await reply("cap");
    assert.equal(cap.ok, true); assert.equal(cap.result.version, 1);
    call(child, "badnonce", "sys.capabilities", {}, "wrong-nonce");
    call(child, "unknown", "not-an-operation-secret");
    const unknown = await reply("unknown");
    assert.equal(unknown.ok, false); assert.equal(unknown.code, "unknown_op");
    assert.ok(!JSON.stringify(unknown).includes("not-an-operation-secret"));
    assert.ok(!reply.records().some(record => record.message?.includes('"rid":"badnonce"')));
    call(child, "models", "modelsConfig.get");
    const models = await reply("models");
    assert.equal(models.ok, true, JSON.stringify(models));
  } finally { child.kill(); await once(child, "exit").catch(() => {}); rmSync(f.dir, { recursive: true, force: true }); }
});

test("management SDK entry preserves safe credential type refusals", async () => {
  const f = fixture();
  writeFileSync(join(f.agent, "auth.json"), JSON.stringify({
    anthropic: { type: "oauth", access: "fake-secret-access", refresh: "fake-secret-refresh", expires: 4102444800000 },
    openai: { type: "api_key", key: "fake-secret-key" },
  }));
  const child = spawn(process.execPath, [entry], { env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  const reply = collect(child);
  try {
    call(child, "providers", "auth.providers");
    assert.equal((await reply("providers")).ok, true);
    call(child, "delete", "auth.apiKeyDelete", { provider: "anthropic" });
    const deleted = await reply("delete");
    assert.equal(deleted.code, "credential_type_mismatch");
    assert.equal(deleted.error, "Provider is authenticated with OAuth, not an API key");
    call(child, "logout", "auth.logout", { provider: "openai" });
    const logout = await reply("logout");
    assert.equal(logout.code, "credential_type_mismatch");
    assert.equal(logout.error, "Provider is authenticated with an API key, not OAuth");
    assert.doesNotMatch(JSON.stringify([deleted, logout]), /secret-/);
  } finally { child.kill(); await once(child, "exit").catch(() => {}); rmSync(f.dir, { recursive: true, force: true }); }
});

test("management SDK entry runs fake MCP config and test", async () => {
  const f = fixture();
  writeFileSync(join(f.agent, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [join(root, "lib/__fixtures__/mcp-env-server.mjs")] } } }));
  const child = spawn(process.execPath, [entry], { env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  const reply = collect(child);
  try {
    call(child, "config", "mcp.configGet", { agentDir: f.agent, allowedRoots: [] });
    const config = await reply("config");
    assert.equal(config.ok, true, JSON.stringify(config));
    assert.equal(config.result.mcp?.available, true, JSON.stringify(config));
    call(child, "probe", "mcp.test", { agentDir: f.agent, allowedRoots: [], scope: "global", name: "fixture" });
    const probe = await reply("probe");
    assert.equal(probe.ok, true, JSON.stringify(probe));
    assert.equal(probe.result.result?.state, "connected", JSON.stringify(probe));
  } finally { child.kill(); await once(child, "exit").catch(() => {}); rmSync(f.dir, { recursive: true, force: true }); }
});

test("management SDK entry rejects wrong version and escaped root", async () => {
  const f = fixture();
  try {
    const escapedRoot = join(f.dir, "escape", "node_modules");
    mkdirSync(join(escapedRoot, "@earendil-works"), { recursive: true });
    symlinkSync(join(f.env.PI_WEB_MANAGEMENT_SDK_ROOT, "@earendil-works/pi-coding-agent"), join(escapedRoot, "@earendil-works/pi-coding-agent"), "dir");
    const wrongVersionRoot = join(f.dir, "wrong-version", "node_modules");
    const fakeSdk = join(wrongVersionRoot, "@earendil-works/pi-coding-agent");
    mkdirSync(fakeSdk, { recursive: true });
    writeFileSync(join(fakeSdk, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.0.0" }));
    const wrongDependencyRoot = join(f.dir, "wrong-dependency", "node_modules");
    const sdkDir = join(wrongDependencyRoot, "@earendil-works/pi-coding-agent");
    const mcpDir = join(wrongDependencyRoot, "@earendil-works/pi-mcp");
    mkdirSync(sdkDir, { recursive: true }); mkdirSync(mcpDir, { recursive: true });
    writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.4.0", dependencies: { "@earendil-works/pi-mcp": "1.4.0" } }));
    writeFileSync(join(mcpDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-mcp", version: "1.3.0" }));
    for (const overrides of [{ PI_WEB_MANAGEMENT_CLI_VERSION: "9.0.0" }, { PI_WEB_MANAGEMENT_SDK_ROOT: escapedRoot }, { PI_WEB_MANAGEMENT_SDK_ROOT: wrongVersionRoot }, { PI_WEB_MANAGEMENT_SDK_ROOT: wrongDependencyRoot }]) {
      const child = spawn(process.execPath, [entry], { env: { ...f.env, ...overrides }, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end();
      const [code] = await once(child, "exit");
      assert.notEqual(code, 0);
    }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
