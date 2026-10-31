import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { IpcClient, MockTransport } from "../ipc/client.ts";
import { bindTerminalClient, checkTerminal, closeTerminal, createTerminal, createTerminalWriter, getTerminalSettings, setTerminalSettings, subscribeTerminal } from "./terminal-client.ts";

test("terminal IPC service orders input and resize, acknowledges output after rendering, and reconnects at cursor", async () => {
  const calls = [];
  const transport = new MockTransport();
  for (const op of ["terminal.create", "terminal.read", "terminal.close", "terminal.write", "terminal.resize", "terminal.ack", "terminal.settingsGet", "terminal.settingsSet", "terminal.subscribeOutput"]) {
    transport.on(op, args => { calls.push({ op, args }); return op.startsWith("terminal.settings") ? { shell: args?.shell ?? "auto", options: [] } : {}; });
  }
  bindTerminalClient(new IpcClient(transport));
  await createTerminal("id", "/project", 80, 24);
  await checkTerminal("id");
  const writer = createTerminalWriter("id", assert.fail);
  writer.write("中文🚀");
  writer.resize(100, 30);
  writer.write("next\n");
  await setImmediate();
  assert.deepEqual(calls.filter(call => ["terminal.write", "terminal.resize"].includes(call.op)).map(call => call.op), ["terminal.write", "terminal.resize", "terminal.write"]);
  assert.equal(Buffer.from(calls.find(call => call.op === "terminal.write").args.input, "base64").toString(), "中文🚀");
  let rendered;
  let opened = 0;
  const events = [];
  const disconnect = subscribeTerminal("id", 12, { onOpen: () => opened++, onEvent: (event, done) => { events.push(event); rendered = done; }, onError: assert.fail });
  transport.emit({ subscriptionId: "sub-1", epoch: 1, seq: 1, kind: "snapshot", payload: { kind: "reset", cursor: 16, output: "new" } });
  assert.equal(opened, 1);
  assert.deepEqual(events[0], { type: "output", data: "new", offset: 16, reset: true });
  assert.equal(calls.filter(call => call.op === "terminal.ack").length, 0);
  rendered();
  await setImmediate();
  assert.deepEqual(calls.find(call => call.op === "terminal.ack").args, { subscriptionId: "sub-1", seq: 1 });
  disconnect();
  const disconnectAgain = subscribeTerminal("id", 16, { onOpen() {}, onEvent() {}, onError: assert.fail });
  disconnectAgain();
  assert.equal((await getTerminalSettings()).shell, "auto");
  assert.equal((await setTerminalSettings("fixture-shell")).shell, "fixture-shell");
  await writer.stop();
  await closeTerminal("id");
  assert.equal(calls.at(-1).op, "terminal.close");
});

test("terminal input failure stops the writer without replay", async () => {
  let count = 0;
  const transport = new MockTransport().on("terminal.write", () => { count++; throw new Error("delivery unknown"); });
  bindTerminalClient(new IpcClient(transport));
  const errors = [];
  const writer = createTerminalWriter("id", error => errors.push(error.message));
  writer.write("one");
  writer.resize(120, 30);
  writer.write("two");
  await setImmediate();
  assert.equal(count, 1);
  assert.equal(errors.length, 1);
  await writer.stop();
});
