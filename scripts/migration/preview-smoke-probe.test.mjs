import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runPreviewProbe, ProbeExitUnconfirmedError } from "./preview-smoke-probe.mjs";

const accept = (message) => message.ok === true;
const run = (source, options = {}) => runPreviewProbe({ program: process.execPath, args: ["-e", source], input: {}, accept, cwd: process.cwd(), env: process.env, timeoutMs: 3000, exitTimeoutMs: 3000, ...options });

test("probe consumes stderr and waits for its responding child to exit", async () => {
  await run('process.stderr.write("diagnostic\\n"); console.log(JSON.stringify({ok:true})); setInterval(()=>{},1000)');
});

test("probe bounds cumulative complete stdout lines", async () => {
  await assert.rejects(run('for(let i=0;i<10000;i++) console.log("{}"); setInterval(()=>{},1000)', { outputLimit: 1024 }), /stdout exceeded 1024 bytes/);
});

test("probe drains and bounds stderr with diagnostic excerpt", async () => {
  await assert.rejects(run('process.stderr.write("diagnostic-marker " + "x".repeat(30000)); setInterval(()=>{},1000)', { outputLimit: 1024 }), /stderr exceeded 1024 bytes.*diagnostic-marker/s);
});

test("probe reports child exit and timeout instead of succeeding", async () => {
  await assert.rejects(run('process.stderr.write("failure-marker"); process.exit(7)'), /exited before reply.*failure-marker/s);
  await assert.rejects(run('setInterval(()=>{},1000)', { timeoutMs: 200 }), /response timeout/);
});

test("unconfirmed own-child exit fails and requires retaining temporary data", async () => {
  const child = new EventEmitter();
  child.pid = 123; child.exitCode = null; child.signalCode = null;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  let kills = 0;
  child.kill = () => { kills++; return true; };
  await assert.rejects(run("", { spawnChild: () => { queueMicrotask(() => child.stdout.write('{"ok":true}\n')); return child; }, exitTimeoutMs: 30 }), (error) => error instanceof ProbeExitUnconfirmedError && /temporary data retained/.test(error.message));
  assert.equal(kills, 1);
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
});
