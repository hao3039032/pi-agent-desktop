import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { buildProjectionInto } from "./build-management-modules.mjs";
import management from "../../lib/pi-rpc/assets/pi-web-management.mjs";
import { mkdir } from "node:fs/promises";
import { createJiti } from "jiti";

test("session.search management bridge uses the shared search projection", async () => {
  const dir = await mkdtemp(resolve(".session-search-test-"));
  const previous = process.env.PI_WEB_MANAGED_MODULES;
  try {
    await buildProjectionInto(dir);
    process.env.PI_WEB_MANAGED_MODULES = dir;
    const file = join(dir, "session.jsonl");
    await writeFile(file, JSON.stringify({ type: "message", id: "entry", message: { role: "user", content: "Find This text" } }) + "\n");
    let handler;
    management({ registerCommand(name, command) { if (name === "pi-web:mgmt") handler = command.handler; } });
    const call = async (op, args) => {
      let message;
      const token = Buffer.from(JSON.stringify({ op, args })).toString("base64url");
      await handler(`req ${token}`, { ui: { notify(value) { message = value; } } });
      return JSON.parse(message.slice("PI_WEB_MGMT_V1 ".length));
    };
    const answer = await call("session.search", { query: "this", sessions: [{ id: "s", path: file, modified: "2026", transient: false }] });
    assert.equal(answer.ok, true);
    assert.equal(answer.result.results[0].entryId, "entry");
    assert.equal(answer.result.results[0].match, "This");
    assert.equal((await call("session.search", { query: "x", sessions: Array(502).fill({}) })).ok, false);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_MANAGED_MODULES;
    else process.env.PI_WEB_MANAGED_MODULES = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

const executable = process.env.PI_CLI_BIN;
test("session.search over a real isolated pi management child", { skip: !executable && "PI_CLI_BIN not set" }, async () => {
  const dir = await mkdtemp(resolve(".session-search-pi-"));
  let client;
  try {
    const managed = join(dir, "managed");
    const agent = join(dir, "agent");
    await mkdir(managed);
    await mkdir(agent);
    await buildProjectionInto(managed);
    const file = join(dir, "fixture.jsonl");
    await writeFile(file, JSON.stringify({ type: "message", id: "fixture-entry", message: { role: "assistant", content: "search Fixture text" } }) + "\n");
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const { PiRpcClient } = await jiti.import("../../lib/pi-rpc/client.ts");
    client = new PiRpcClient(executable, { cwd: dir, args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", resolve("lib/pi-rpc/assets/pi-web-management.mjs")], env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_WEB_MANAGED_MODULES: managed, PI_WEB_MGMT_NONCE: "test-nonce" }, onLog() {} });
    let envelope;
    client.onUi("notify", (record) => { if (record.message?.startsWith("PI_WEB_MGMT_V1 ")) envelope = JSON.parse(record.message.slice("PI_WEB_MGMT_V1 ".length)); });
    const token = Buffer.from(JSON.stringify({ op: "session.search", args: { query: "fixture", sessions: [{ id: "s", path: file, modified: "2026" }] }, nonce: "test-nonce" })).toString("base64url");
    const ack = await client.command("prompt", { message: `/pi-web:mgmt search-test ${token}` }, 30000);
    assert.equal(ack.disposition, "handled");
    const deadline = Date.now() + 5000;
    while (!envelope && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(envelope?.nonce, "test-nonce");
    assert.equal(envelope?.ok, true);
    assert.equal(envelope.result.results[0].entryId, "fixture-entry");
  } finally {
    if (client) await client.close(5000).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
