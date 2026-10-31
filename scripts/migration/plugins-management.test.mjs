import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { resolvePiCliBin } from "../../lib/pi-rpc/test-utils.mjs";
import { buildProjectionInto } from "./build-management-modules.mjs";

const { PiRpcClient } = await createJiti(import.meta.url, { interopDefault: true }).import("../../lib/pi-rpc/client.ts");
const executable = resolvePiCliBin();

test("real management instance lists isolated local packages and refreshes", { skip: executable ? false : "PI_CLI_BIN not set" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugins-management-"));
  let client;
  try {
    const cwd = join(root, "project"), agentDir = join(root, "agent"), managed = join(root, "managed"), pkg = join(root, "fixture");
    await Promise.all([cwd, agentDir, pkg].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "plugin-fixture", version: "1.2.3", pi: { extensions: ["./index.js"] } }));
    await writeFile(join(pkg, "index.js"), "export default function () {}\n");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));
    await buildProjectionInto(managed);
    const nonce = "plugins-test-nonce";
    client = new PiRpcClient(executable, {
      cwd,
      args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", join(import.meta.dirname, "../../lib/pi-rpc/assets/pi-web-management.mjs")],
      env: { ...process.env, HOME: root, USERPROFILE: root, PI_AGENT_HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_WEB_MANAGED_MODULES: managed, PI_WEB_MGMT_NONCE: nonce },
      onLog: () => {},
    });
    const replies = [];
    client.onUi("notify", (record) => {
      if (typeof record.message === "string" && record.message.startsWith("PI_WEB_MGMT_V1 ")) replies.push(JSON.parse(record.message.slice(15)));
    });
    let index = 0;
    const call = async (op, args = { cwd }) => {
      const rid = `plugins-${++index}`;
      const token = Buffer.from(JSON.stringify({ op, args, nonce })).toString("base64url");
      const ack = await client.command("prompt", { message: `/pi-web:mgmt ${rid} ${token}` }, 60_000);
      assert.equal(ack.disposition, "handled");
      for (let i = 0; i < 600; i++) {
        const reply = replies.find((entry) => entry.rid === rid);
        if (reply) { assert.equal(reply.nonce, nonce); assert.equal(reply.ok, true, JSON.stringify(reply)); return reply.result; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("no plugins.list reply");
    };
    const first = await call("plugins.list");
    const check = await call("plugins.check");
    assert.equal(check.updates[0].state, "unsupported");
    assert.equal(first.packages[0].source, pkg);
    assert.equal(first.packages[0].packageName, "plugin-fixture");
    assert.equal(first.packages[0].disabled, false);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: pkg, extensions: [], skills: [], prompts: [], themes: [] }] }));
    const second = await call("plugins.list");
    assert.equal(second.packages[0].disabled, true);
  } finally {
    if (client) await client.close(5_000);
    await rm(root, { recursive: true, force: true });
  }
});
