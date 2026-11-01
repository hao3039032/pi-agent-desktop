import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

const binary = process.env.STATIC_UI_HARNESS_BIN;
test("isolated static host drains IPC and reports tracked shutdown coverage", { skip: binary ? false : "STATIC_UI_HARNESS_BIN not set", timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "static-host-lifecycle-"));
  const agent = join(root, "agent");
  await mkdir(agent);
  const token = "isolated-static-host-test-token-1234567890";
  const env = { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agent, STATIC_UI_HARNESS_TOKEN: token };
  for (const key of Object.keys(env)) if ((key.startsWith("PI_") && key !== "PI_CODING_AGENT_DIR") || key === "JITI_ALIAS") delete env[key];
  const child = spawn(resolve(binary), ["--static-dir", resolve("desktop/frontend-static"), "--isolated-lifecycle-agent-dir", agent], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
  try {
    const lines = createInterface({ input: child.stdout });
    const ready = await Promise.race([
      new Promise((resolveReady, reject) => { lines.once("line", (line) => { try { resolveReady(JSON.parse(line)); } catch (error) { reject(error); } }); child.once("error", reject); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`harness startup timeout: ${stderr}`)), 10000).unref()),
    ]);
    assert.equal(ready.harness, "ready");
    const base = `http://127.0.0.1:${ready.port}`;
    const headers = { "x-harness-token": token, "content-type": "application/json" };
    const invoke = await fetch(`${base}/__harness__/invoke`, { method: "POST", headers, body: JSON.stringify({ cmd: "pi_ipc", args: { request: { v: 1, id: "fixture", op: "desktop.identity" } } }) });
    assert.equal((await invoke.json()).ok, true);
    const shutdown = await fetch(`${base}/__harness__/shutdown`, { method: "POST", headers });
    assert.equal(shutdown.status, 200);
    const report = await shutdown.json();
    assert.equal(report.ok, true);
    assert.equal(report.scheduler.stopped, true);
    assert.deepEqual(report.scheduler.activeUnknown, []);
    assert.equal(report.schedulerMayRepeatSessionDiagnostics, true);
    assert.deepEqual(report.sessionUnknown, []);
    assert.deepEqual(report.managementUnknown, []);
    assert.deepEqual(report.writerUnknown, []);
    assert.deepEqual(report.writerCompleted, []);
    assert.ok(report.uncovered.includes("unregistered writers"));
    assert.ok(report.uncovered.includes("cross-restart writer durability"));
    assert.ok(report.uncovered.includes("scheduler prompt correlation and lease recovery"));
    assert.ok(report.uncovered.includes("detached descendants"));
    assert.equal(await exited, 0, stderr);
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
