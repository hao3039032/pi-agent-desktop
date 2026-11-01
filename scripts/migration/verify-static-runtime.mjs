#!/usr/bin/env node
// Linux-only isolation probe: the bundle is mounted at /bundle, with no
// checkout or home visible. This is not native WebView/package acceptance.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

if (process.argv[2] !== "--inside") {
  if (process.platform !== "linux" || ![3, 4].includes(process.argv.length) || (process.argv[3] && process.argv[3] !== "--oauth-only")) throw new Error("usage on Linux: node scripts/migration/verify-static-runtime.mjs <resource-dir> [--oauth-only] (requires bwrap)");
  const bundle = resolve(process.argv[2]);
  const { verifyBundle } = await import("./static-bundle-manifest.mjs");
  verifyBundle(bundle, JSON.parse(readFileSync(join(bundle, "bundle-manifest.json"), "utf8")));
  const scratch = mkdtempSync(join(tmpdir(), "pi-static-runtime-"));
  try {
    mkdirSync(join(scratch, "agent"));
    const fixture = resolve(import.meta.dirname, "../../lib/__fixtures__/mcp-env-server.mjs");
    const oauthFixture = resolve(import.meta.dirname, "../../lib/__fixtures__/mcp-oauth-server.mjs");
    const args = ["--ro-bind", fixture, "/mcp-fixture.mjs", "--ro-bind", oauthFixture, "/oauth-fixture.mjs", "--die-with-parent", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--ro-bind", bundle, "/bundle", "--bind", scratch, "/work", "--ro-bind", fileURLToPath(import.meta.url), "/probe.mjs", "--chdir", "/work", "--clearenv", "--setenv", "HOME", "/work", "--setenv", "USERPROFILE", "/work", "--setenv", "PI_CODING_AGENT_DIR", "/work/agent", "--setenv", "PI_WEB_MANAGED_MODULES", "/bundle/managed", "--setenv", "PI_WEB_MGMT_NONCE", "static-runtime-probe", "--setenv", "PATH", "/bundle/node", "/bundle/node/node", "/probe.mjs", "--inside", ...(process.argv[3] === "--oauth-only" ? ["--oauth-only"] : [])];
    const result = spawnSync("bwrap", args, { stdio: "inherit", timeout: 60000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`isolated runtime probe failed: ${result.signal ?? result.status}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
} else {
  writeFileSync("/work/agent/mcp.json", JSON.stringify({ mcpServers: { fixture: { command: "/bundle/node/node", args: ["/mcp-fixture.mjs"] } } }));
  writeFileSync("/work/session.jsonl", [
    JSON.stringify({ type: "session", version: 3, id: "fixture-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work" }),
    JSON.stringify({ type: "message", id: "a1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "isolated fixture", timestamp: 1767225601000 } }),
  ].join("\n") + "\n");
  const { startFakeOAuthServer } = await import("/oauth-fixture.mjs");
  const oauthServer = await startFakeOAuthServer();
  writeFileSync("/work/oauth-probe.mjs", `
    import { SessionManager } from "@earendil-works/pi-coding-agent";
    import { McpOAuthProvider, MemoryOAuthStateStore } from "/bundle/managed/node_modules/@earendil-works/pi-mcp/dist/oauth/index.js";
    export default function(pi) { pi.registerCommand("oauth-probe", { handler: async (url, ctx) => {
      try {
        const p = await import("/bundle/managed/pi-web-session-projection.mjs");
        if (p.projectionSessionManager !== SessionManager || p.projectionMcpOAuthProvider !== McpOAuthProvider || p.projectionMemoryOAuthStateStore !== MemoryOAuthStateStore) throw Error("OAuth SDK identity mismatch");
        const store = new MemoryOAuthStateStore(); let page;
        const prompt = { showAuthorizationUrl: (u) => { page = u.href; }, promptForRedirectUrl: (signal) => new Promise((r) => signal.addEventListener("abort", () => r(undefined), { once: true })) };
        const factory = async () => ({ redirectUrl: "http://127.0.0.1:43981/callback", wait: async (state, redirect) => {
          const response = await fetch(page, { redirect: "manual" }); const target = new URL(response.headers.get("location"));
          if (target.searchParams.get("state") !== state || target.origin + target.pathname !== redirect.origin + redirect.pathname) throw Error("callback mismatch");
          return { code: target.searchParams.get("code") };
        }, close: () => {} });
        for (let i = 0; i < 2; i++) await p.signInMcpWithHostedCallback({ serverUrl: url, store, settings: {}, prompt }, factory, new AbortController().signal);
        if (!(await store.load()).tokens.access_token.startsWith("access-")) throw Error("missing token");
        ctx.ui.notify("OAUTH_PROBE_OK", "info");
      } catch (e) { ctx.ui.notify("OAUTH_PROBE_ERROR " + String(e), "error"); }
    }}); }
  `);
  const child = spawn("/bundle/pi/pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", "/bundle/server/lib/pi-rpc/assets/pi-web-management.mjs", "--extension", "/work/oauth-probe.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-16000); });
  const events = [];
  createInterface({ input: child.stdout }).on("line", (line) => { try { events.push(JSON.parse(line)); } catch { events.push({ invalid: line }); } });
  const deadline = Date.now() + 45000;
  async function wait(predicate) {
    while (Date.now() < deadline) {
      const index = events.findIndex(predicate);
      if (index >= 0) return events.splice(index, 1)[0];
      if (child.exitCode !== null) throw new Error(`pi exited ${child.exitCode}: ${stderr}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for pi: ${stderr}\n${JSON.stringify(events).slice(-16000)}`);
  }
  function send(value) { child.stdin.write(`${JSON.stringify(value)}\n`); }
  try {
    send({ id: "commands", type: "get_commands" });
    const commands = await wait((e) => e.id === "commands" && e.type === "response");
    assert.equal(commands.success, true);
    assert.ok(commands.data.commands.some((c) => c.name === "pi-web:mgmt"));
    let nextId = 0;
    async function call(op, args) {
      const rid = `probe-${++nextId}`;
      const token = Buffer.from(JSON.stringify({ op, args, nonce: "static-runtime-probe" })).toString("base64url");
      send({ id: rid, type: "prompt", message: `/pi-web:mgmt ${rid} ${token}` });
      const frame = await wait((e) => e.type === "extension_ui_request" && typeof e.message === "string" && e.message.startsWith("PI_WEB_MGMT_V1 ") && JSON.parse(e.message.slice(15)).rid === rid);
      return JSON.parse(frame.message.slice(15));
    }
    const capabilities = await call("sys.capabilities", {});
    assert.equal(capabilities.ok, true, JSON.stringify(capabilities));
    const cron = await call("cron.preview", { expr: "17 5 * * *", timezone: "UTC", count: 1 });
    assert.equal(cron.ok, true, JSON.stringify(cron));
    assert.match(cron.result.runs[0], /T05:17:00\.000Z$/);
    const search = await call("session.search", { query: "fixture", sessions: [] });
    assert.equal(search.ok, true, JSON.stringify(search));
    const header = await call("session.readHeader", { file: "/work/session.jsonl" });
    assert.equal(header.ok, true, JSON.stringify(header));
    assert.equal(header.result.header.id, "fixture-session");
    const context = await call("session.readContext", { file: "/work/session.jsonl" });
    assert.equal(context.ok, true, JSON.stringify(context));
    assert.match(JSON.stringify(context.result.context), /isolated fixture/);
    const docx = await call("docx.extractText", { data: readFileSync("/bundle/managed/node_modules/mammoth/test/test-data/single-paragraph.docx").toString("base64") });
    assert.equal(docx.ok, true, JSON.stringify(docx));
    assert.ok(docx.result.text.length > 0);
    send({ id: "oauth", type: "prompt", message: `/oauth-probe ${oauthServer.url}` });
    const oauth = await wait((e) => e.type === "extension_ui_request" && typeof e.message === "string" && e.message.startsWith("OAUTH_PROBE_"));
    assert.equal(oauth.message, "OAUTH_PROBE_OK", oauth.message);
    assert.deepEqual(oauthServer.issued.grants, ["authorization_code", "refresh_token"]);
    console.log("Isolated bundle: session projection, DOCX, public OAuth fake authorization + refresh and OAuth constructor identity passed. Rust callback not exercised.");
    if (process.argv[3] !== "--oauth-only") {
      const mcp = await call("mcp.test", { cwd: "/work", agentDir: "/work/agent", allowedRoots: ["/work"], scope: "global", name: "fixture" });
      assert.equal(mcp.ok, true, JSON.stringify(mcp));
      assert.equal(mcp.result?.result?.state, "connected", JSON.stringify(mcp));
      assert.ok(mcp.result.result.tools.some((tool) => tool.name === "env_has" && tool.readOnly));
      console.log("Isolated bundle: fake MCP Test connected and listed read-only tools.");
    }
  } finally {
    await oauthServer.close();
    child.stdin.end();
    await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
