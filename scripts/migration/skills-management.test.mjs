import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { resolvePiCliBin } from "../../lib/pi-rpc/test-utils.mjs";
import { buildProjectionInto } from "./build-management-modules.mjs";

const { PiRpcClient } = await createJiti(import.meta.url, { interopDefault: true }).import("../../lib/pi-rpc/client.ts");
const executable = resolvePiCliBin();

test("real management instance lists, toggles, and reloads isolated skills", { skip: executable ? false : "PI_CLI_BIN not set" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-management-"));
  let client;
  try {
    const cwd = join(root, "project"), agentDir = join(root, "agent"), managed = join(root, "managed");
    const dir = join(agentDir, "skills", "fixture");
    await mkdir(cwd, { recursive: true });
    await mkdir(dir, { recursive: true });
    const skill = join(dir, "SKILL.md");
    await writeFile(skill, "---\nname: fixture\ndescription: isolated fixture\n---\nbody\n");
    await buildProjectionInto(managed);
    const nonce = "skills-test-nonce";
    client = new PiRpcClient(executable, {
      cwd,
      args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", join(import.meta.dirname, "../../lib/pi-rpc/assets/pi-web-management.mjs")],
      env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, PI_WEB_MANAGED_MODULES: managed, PI_WEB_MGMT_NONCE: nonce },
      onLog: () => {},
    });
    const replies = [];
    client.onUi("notify", (record) => {
      if (typeof record.message === "string" && record.message.startsWith("PI_WEB_MGMT_V1 ")) replies.push(JSON.parse(record.message.slice(15)));
    });
    let index = 0;
    const call = async (op, args) => {
      const rid = `skills-${++index}`;
      const token = Buffer.from(JSON.stringify({ op, args, nonce })).toString("base64url");
      const ack = await client.command("prompt", { message: `/pi-web:mgmt ${rid} ${token}` }, 60_000);
      assert.equal(ack.disposition, "handled");
      for (let i = 0; i < 600; i++) {
        const reply = replies.find((entry) => entry.rid === rid);
        if (reply) { assert.equal(reply.nonce, nonce); return reply; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`no reply for ${op}`);
    };
    const first = await call("skills.list", { cwd });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.result.skills.some((entry) => entry.filePath === skill));
    const toggle = await call("skills.setDisabled", { cwd, filePaths: [skill, join(root, "other.md")], disableModelInvocation: true });
    assert.equal(toggle.ok, true, JSON.stringify(toggle));
    assert.equal(toggle.result[0].error, undefined);
    assert.match(toggle.result[1].error, /not visible/);
    assert.match(await readFile(skill, "utf8"), /disable-model-invocation: true/);
    const second = await call("skills.list", { cwd });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.result.skills.find((entry) => entry.filePath === skill).disableModelInvocation, true);
  } finally {
    if (client) await client.close(5_000);
    await rm(root, { recursive: true, force: true });
  }
});
