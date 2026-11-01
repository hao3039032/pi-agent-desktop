#!/usr/bin/env node
// Linux-only isolation probe: the bundle is mounted at /bundle, with no
// checkout or home visible. This is not native WebView/package acceptance.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

if (process.argv[2] !== "--inside") {
  if (process.platform !== "linux" || process.argv.length !== 3) throw new Error("usage on Linux: node scripts/migration/verify-static-runtime.mjs <resource-dir> (requires bwrap)");
  const bundle = resolve(process.argv[2]);
  const { verifyBundle } = await import("./static-bundle-manifest.mjs");
  verifyBundle(bundle, JSON.parse(readFileSync(join(bundle, "bundle-manifest.json"), "utf8")));
  const scratch = mkdtempSync(join(tmpdir(), "pi-static-runtime-"));
  try {
    mkdirSync(join(scratch, "agent"));
    const args = ["--die-with-parent", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--ro-bind", bundle, "/bundle", "--bind", scratch, "/work", "--ro-bind", fileURLToPath(import.meta.url), "/probe.mjs", "--chdir", "/work", "--clearenv", "--setenv", "HOME", "/work", "--setenv", "USERPROFILE", "/work", "--setenv", "PI_CODING_AGENT_DIR", "/work/agent", "--setenv", "PI_WEB_MANAGED_MODULES", "/bundle/managed", "--setenv", "PI_WEB_MGMT_NONCE", "static-runtime-probe", "--setenv", "PATH", "/bundle/node", "/bundle/node/node", "/probe.mjs", "--inside"];
    const result = spawnSync("bwrap", args, { stdio: "inherit", timeout: 60000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`isolated runtime probe failed: ${result.signal ?? result.status}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
} else {
  const child = spawn("/bundle/pi/pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", "/bundle/server/lib/pi-rpc/assets/pi-web-management.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
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
    console.log("Isolated bundled pi: management extension, cron and projection RPC passed; no checkout mounted.");
  } finally {
    child.stdin.end();
    await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
