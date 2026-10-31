import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
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
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ skills: [{ id: "fixture/repo", source: "fixture/repo", name: "demo", installs: 1200 }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const cwd = join(root, "project"), agentDir = join(root, "agent"), managed = join(root, "managed");
    const dir = join(agentDir, "skills", "fixture");
    await mkdir(cwd, { recursive: true });
    await mkdir(dir, { recursive: true });
    const skill = join(dir, "SKILL.md");
    await writeFile(skill, "---\nname: fixture\ndescription: isolated fixture\n---\nbody\n");
    const externalDir = join(root, "external");
    await mkdir(externalDir);
    const external = join(externalDir, "extra.md");
    await writeFile(external, "---\nname: extra\ndescription: external fixture\n---\nbody\n");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ skills: [external] }));
    await buildProjectionInto(managed);
    const nonce = "skills-test-nonce";
    client = new PiRpcClient(executable, {
      cwd,
      args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", join(import.meta.dirname, "../../lib/pi-rpc/assets/pi-web-management.mjs")],
      env: { ...process.env, HOME: root, USERPROFILE: root, PI_AGENT_HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_WEB_MANAGED_MODULES: managed, PI_WEB_MGMT_NONCE: nonce, SKILLS_API_URL: `http://127.0.0.1:${server.address().port}` },
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
    const search = await call("skills.search", { query: "demo" });
    assert.equal(search.ok, true, JSON.stringify(search));
    assert.equal(search.result.results[0].package, "fixture/repo@demo");
    assert.equal(search.result.results[0].installs, "1.2K installs");
    const first = await call("skills.list", { cwd });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(first.result.skills.some((entry) => entry.filePath === skill));
    assert.ok(first.result.skills.some((entry) => entry.filePath === external));
    const toggle = await call("skills.setDisabled", { cwd, filePaths: [skill, join(root, "other.md"), external], disableModelInvocation: true });
    assert.equal(toggle.ok, true, JSON.stringify(toggle));
    assert.equal(toggle.result[0].error, undefined);
    assert.match(toggle.result[1].error, /not visible/);
    assert.match(toggle.result[2].error, /Access denied/);
    assert.doesNotMatch(await readFile(external, "utf8"), /disable-model-invocation/);
    assert.match(await readFile(skill, "utf8"), /disable-model-invocation: true/);
    const second = await call("skills.list", { cwd });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.result.skills.find((entry) => entry.filePath === skill).disableModelInvocation, true);
  } finally {
    if (client) await client.close(5_000);
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
