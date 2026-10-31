import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { resolvePiCliBin } from "../../lib/pi-rpc/test-utils.mjs";
import { buildProjectionInto } from "./build-management-modules.mjs";

const { PiRpcClient } = await createJiti(import.meta.url, { interopDefault: true }).import("../../lib/pi-rpc/client.ts");
const executable = resolvePiCliBin();

test("real pi and npx install and update a skill through an isolated registry fixture", { skip: executable ? false : "PI_CLI_BIN not set", timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-npx-"));
  let client, server;
  try {
    const agent = join(root, "agent"), project = join(root, "project"), source = join(root, "fixture"), managed = join(root, "managed"), pkg = join(root, "package");
    await Promise.all([agent, project, source, pkg].map((p) => mkdir(p, { recursive: true })));
    await writeFile(join(source, "SKILL.md"), "---\nname: fixture\ndescription: isolated skill\n---\nbody\n");
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "skills", version: "1.0.0", bin: { skills: "cli.cjs" } }));
    await writeFile(join(pkg, "cli.cjs"), `#!/usr/bin/env node\nconst fs=require('fs'), path=require('path');\nconst args=process.argv.slice(2); if(args[0]!=='add') process.exit(2);\nconst target=path.join(process.env.PI_CODING_AGENT_DIR,'skills','fixture'); fs.mkdirSync(target,{recursive:true}); if(args[2]==='--skill'){if(args[1]!=='owner/repo/skills/fixture'||args[3]!=='fixture'||args[4]!=='-y'||args[5]!=='--agent'||args[6]!=='pi'||args[7]!=='-g') process.exit(3); fs.appendFileSync(path.join(target,'SKILL.md'),'updated\\n');} else {if(args[2]!=='-y'||args[3]!=='--agent'||args[4]!=='pi') process.exit(2); fs.copyFileSync(path.join(args[1],'SKILL.md'),path.join(target,'SKILL.md'));} console.log('Installation complete');\n`);
    const archive = join(root, "skills.tgz");
    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    const tarball = await readFile(archive);
    server = createServer((req, res) => {
      if (req.url === "/skills") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ name: "skills", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { name: "skills", version: "1.0.0", bin: { skills: "cli.cjs" }, dist: { tarball: `http://127.0.0.1:${server.address().port}/skills.tgz` } } } }));
      } else if (req.url === "/skills.tgz") res.end(tarball);
      else { res.statusCode = 404; res.end(); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await buildProjectionInto(managed);
    const nonce = "fixture-nonce";
    client = new PiRpcClient(executable, {
      cwd: project,
      args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", join(import.meta.dirname, "../../lib/pi-rpc/assets/pi-web-management.mjs")],
      env: { ...process.env, HOME: root, USERPROFILE: root, PI_AGENT_HOME: root, PI_CODING_AGENT_DIR: agent, PI_WEB_MANAGED_MODULES: managed, PI_WEB_MGMT_NONCE: nonce, PI_WEB_EXCLUSIVE_MUTATION: "1", npm_config_registry: `http://127.0.0.1:${server.address().port}/`, npm_config_cache: join(root, "npm-cache"), npm_config_yes: "true" }, onLog: () => {},
    });
    const replies = [], progress = [];
    client.onUi("notify", (record) => {
      if (typeof record.message !== "string") return;
      if (record.message.startsWith("PI_WEB_MGMT_V1 ")) replies.push(JSON.parse(record.message.slice(15)));
      if (record.message.startsWith("PI_WEB_MGMT_PROGRESS_V1 ")) progress.push(JSON.parse(record.message.slice(24)));
    });
    const token = Buffer.from(JSON.stringify({ op: "skills.install", args: { cwd: project, package: source, scope: "global" }, nonce })).toString("base64url");
    const ack = await client.command("prompt", { message: `/pi-web:mgmt fixture ${token}` }, 30_000);
    assert.equal(ack.disposition, "handled");
    for (let i = 0; i < 1200 && replies.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(replies[0]?.ok, true, JSON.stringify(replies));
    assert.ok(progress.some((entry) => entry.progress?.phase === "running"));
    assert.match(await readFile(join(agent, "skills/fixture/SKILL.md"), "utf8"), /isolated skill/);
    await mkdir(join(root, ".agents"), { recursive: true });
    await writeFile(join(root, ".agents/.skill-lock.json"), JSON.stringify({ skills: { fixture: { source: "owner/repo", sourceType: "github", skillPath: "skills/fixture/SKILL.md", skillFolderHash: "abc" } } }));
    const updateToken = Buffer.from(JSON.stringify({ op: "skills.update", args: { cwd: project, package: "owner/repo@fixture", scope: "global" }, nonce })).toString("base64url");
    const updateAck = await client.command("prompt", { message: `/pi-web:mgmt update ${updateToken}` }, 30_000);
    assert.equal(updateAck.disposition, "handled");
    for (let i = 0; i < 1200 && !replies.some((entry) => entry.rid === "update"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(replies.find((entry) => entry.rid === "update")?.ok, true, JSON.stringify(replies));
    assert.match(await readFile(join(agent, "skills/fixture/SKILL.md"), "utf8"), /updated/);
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(join(project, ".pi/settings.json"), "{}");
    const denyToken = Buffer.from(JSON.stringify({ op: "skills.install", args: { cwd: project, package: source, scope: "project" }, nonce })).toString("base64url");
    await client.command("prompt", { message: `/pi-web:mgmt deny ${denyToken}` }, 30_000);
    for (let i = 0; i < 600 && !replies.some((entry) => entry.rid === "deny"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(replies.find((entry) => entry.rid === "deny")?.ok, false, JSON.stringify(replies));
    await assert.rejects(readFile(join(project, ".pi/skills/fixture/SKILL.md")));
  } finally {
    if (client) await client.close(5_000);
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
