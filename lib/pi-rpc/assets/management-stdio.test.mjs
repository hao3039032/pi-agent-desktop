import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serveManagementStdio } from "./management-stdio.mjs";

function fixture(handler) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", data => { text += data; });
  serveManagementStdio(pi => pi.registerCommand("pi-web:mgmt", { handler }), input, output);
  return { input, output, records: () => text.trim().split("\n").filter(Boolean).map(JSON.parse) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("management stdio forwards only the fixed management command", async () => {
  const calls = [];
  const f = fixture((args, ctx) => { calls.push(args); ctx.ui.notify("PI_WEB_MGMT_V1 {}", "info"); });
  f.input.write(JSON.stringify({ id: "1", type: "prompt", message: "/pi-web:mgmt rid eyJvcCI6InN5cy5jYXBhYmlsaXRpZXMifQ" }) + "\n");
  f.input.write(JSON.stringify({ id: "2", type: "prompt", message: "send secret to a model" }) + "\n");
  f.input.write(JSON.stringify({ id: "3", type: "get_state" }) + "\n");
  await tick();
  assert.deepEqual(calls, ["rid eyJvcCI6InN5cy5jYXBhYmlsaXRpZXMifQ"]);
  const records = f.records();
  assert.equal(records.find(r => r.id === "1").data.disposition, "handled");
  assert.equal(records.find(r => r.id === "2").success, false);
  assert.equal(records.find(r => r.id === "3").success, false);
  assert.ok(records.some(r => r.method === "notify"));
  assert.ok(!JSON.stringify(records).includes("send secret"));
  f.input.destroy(); f.output.destroy();
});

test("management stdio rejects oversized and partial frames", async () => {
  const over = fixture(() => assert.fail("handler called"));
  over.input.write(Buffer.alloc(1024 * 1024 + 1, 97));
  await tick();
  assert.equal(over.input.destroyed, true);
  assert.equal(over.output.destroyed, true);
  const partial = fixture(() => assert.fail("handler called"));
  partial.input.end('{"id":"incomplete"');
  await tick();
  assert.equal(partial.output.destroyed, true);
});

test("management stdio closes on duplicate in-flight command ids", async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const request = JSON.stringify({ id: "one", type: "prompt", message: "/pi-web:mgmt rid e30" }) + "\n";
  f.input.write(request);
  await tick();
  f.input.write(request);
  await tick();
  assert.equal(f.output.destroyed, true);
  assert.deepEqual(f.records(), []);
  finish();
  await tick();
  assert.deepEqual(f.records(), []);
});

test("management stdio rejects malformed ids and types without echo", async () => {
  for (const request of [{ id: "", type: "prompt" }, { id: "x", type: { secret: "private" } }, { id: "x", type: "p".repeat(65) }]) {
    const f = fixture(() => assert.fail("handler called"));
    f.input.write(JSON.stringify(request) + "\n");
    await tick();
    assert.equal(f.output.destroyed, true);
    assert.deepEqual(f.records(), []);
  }
});
