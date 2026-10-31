import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import management from "../../lib/pi-rpc/assets/pi-web-management.mjs";
import { buildProjectionInto } from "./build-management-modules.mjs";
import { createJiti } from "jiti";
import { resolvePiCliBin } from "../../lib/pi-rpc/test-utils.mjs";

test("scheduled preview uses shared cron validation and timezone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scheduled-preview-"));
  const oldDir = process.env.PI_WEB_MANAGED_MODULES;
  const oldNonce = process.env.PI_WEB_MGMT_NONCE;
  try {
    await buildProjectionInto(dir);
    process.env.PI_WEB_MANAGED_MODULES = dir;
    process.env.PI_WEB_MGMT_NONCE = "fixture";
    let handler;
    management({ registerCommand(_name, command) { handler = command.handler; } });
    async function call(args) {
      let answer;
      const token = Buffer.from(JSON.stringify({ op: "tasks.previewCron", args, nonce: "fixture" })).toString("base64url");
      await handler(`request ${token}`, { ui: { notify(message) { answer = JSON.parse(message.slice("PI_WEB_MGMT_V1 ".length)); } } });
      assert.equal(answer.ok, true, JSON.stringify(answer));
      return answer.result;
    }
    const good = await call({ expr: "0 9 * * *", timezone: "Asia/Shanghai" });
    assert.equal(good.valid, true);
    assert.equal(good.nextRuns.length, 5);
    assert.ok(good.nextRuns.every((date) => date.endsWith("T01:00:00.000Z")));
    const bad = await call({ expr: "* * * * *", timezone: "UTC" });
    assert.equal(bad.valid, false);
    assert.equal(bad.key, "scheduled.error.interval");
  } finally {
    if (oldDir === undefined) delete process.env.PI_WEB_MANAGED_MODULES; else process.env.PI_WEB_MANAGED_MODULES = oldDir;
    if (oldNonce === undefined) delete process.env.PI_WEB_MGMT_NONCE; else process.env.PI_WEB_MGMT_NONCE = oldNonce;
    await rm(dir, { recursive: true, force: true });
  }
});

const executable = resolvePiCliBin();
test("scheduled preview runs inside a real isolated pi management child", { skip: executable ? false : "PI_CLI_BIN unavailable" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "scheduled-preview-pi-"));
  let child;
  try {
    const agent = join(dir, "agent");
    const cwd = join(dir, "work");
    const managed = join(dir, "managed");
    await mkdir(agent); await mkdir(cwd); await buildProjectionInto(managed);
    const jiti = createJiti(import.meta.url);
    const { PiRpcClient } = await jiti.import("../../lib/pi-rpc/client.ts");
    child = new PiRpcClient(executable, {
      cwd,
      args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", new URL("../../lib/pi-rpc/assets/pi-web-management.mjs", import.meta.url).pathname],
      env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_WEB_MANAGED_MODULES: managed, PI_WEB_MGMT_NONCE: "fixture" },
      onLog: () => {},
    });
    let answer;
    child.onUi("notify", (record) => {
      if (typeof record.message === "string" && record.message.startsWith("PI_WEB_MGMT_V1 ")) answer = JSON.parse(record.message.slice(15));
    });
    const token = Buffer.from(JSON.stringify({ op: "tasks.previewCron", args: { expr: "0 9 * * *", timezone: "UTC" }, nonce: "fixture" })).toString("base64url");
    const ack = await child.command("prompt", { message: `/pi-web:mgmt preview ${token}` }, 60_000);
    assert.equal(ack.disposition, "handled");
    const deadline = Date.now() + 10_000;
    while (!answer && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(answer?.ok, true, JSON.stringify(answer));
    assert.equal(answer.result.valid, true);
    assert.equal(answer.result.nextRuns.length, 5);
  } finally {
    if (child) await child.close(5_000);
    await rm(dir, { recursive: true, force: true });
  }
});
