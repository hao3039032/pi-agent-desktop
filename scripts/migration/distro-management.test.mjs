import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { buildProjectionInto } from "./build-management-modules.mjs";
import { resolvePiCliBin } from "../../lib/pi-rpc/test-utils.mjs";

const executable = resolvePiCliBin();
const { PiRpcClient } = await createJiti(import.meta.url, { interopDefault: true }).import("../../lib/pi-rpc/client.ts");

test("distro configuration stays redacted through the real management child", { skip: executable ? false : "PI_CLI_BIN not set" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "distro-management-"));
  let child;
  try {
    const agent = join(root, "agent"), managed = join(root, "managed");
    await mkdir(agent, { recursive: true });
    await buildProjectionInto(managed);
    await mkdir(join(managed, "node_modules"));
    await symlink(join(import.meta.dirname, "../../node_modules/jiti"), join(managed, "node_modules/jiti"), "junction");
    const nonce = "distro-fixture";
    const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, PI_WEB_MANAGED_MODULES: managed, PI_WEB_MGMT_NONCE: nonce };
    delete env.PI_PACKAGE_DIR; delete env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT; delete env.JITI_ALIAS;
    child = new PiRpcClient(executable, { cwd: root, args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", join(import.meta.dirname, "../../lib/pi-rpc/assets/pi-web-management.mjs")], env, onLog: () => {} });
    const envelopes = [];
    child.onUi("notify", record => { if (typeof record.message === "string" && record.message.startsWith("PI_WEB_MGMT_V1 ")) envelopes.push(JSON.parse(record.message.slice(15))); });
    let counter = 0;
    async function call(op, args = {}) {
      const requestId = `distro-${++counter}`;
      const token = Buffer.from(JSON.stringify({ op, args, nonce })).toString("base64url");
      const ack = await child.command("prompt", { message: `/pi-web:mgmt ${requestId} ${token}` }, 60_000);
      assert.equal(ack?.disposition, "handled");
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const i = envelopes.findIndex(envelope => envelope.rid === requestId);
        if (i !== -1) return envelopes.splice(i, 1)[0];
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error(`no response for ${op}`);
    }
    const resources = join(root, "fixture-resources");
    await mkdir(join(resources, "pi-seed"), { recursive: true });
    await writeFile(join(resources, "pi-seed", "manifest.json"), JSON.stringify({ distro: "fixture", revision: 1, seedVersion: "fixture-1", packages: [] }));
    const seeded = await call("distro.seed", { resourcesDir: resources });
    assert.equal(seeded.ok, true, JSON.stringify(seeded));
    const settingsPath = join(agent, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.ok(Array.isArray(settings.defaultTools));
    delete settings.defaultTools;
    await writeFile(settingsPath, JSON.stringify(settings));
    const repeated = await call("distro.seed", { resourcesDir: resources });
    assert.equal(repeated.ok, true, JSON.stringify(repeated));
    assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).defaultTools, undefined);
    const refusedSeed = await call("distro.seed", { resourcesDir: join(root, "missing") });
    assert.equal(refusedSeed.ok, false);
    const initial = await call("distro.status");
    assert.equal(initial.ok, true, JSON.stringify(initial));
    assert.equal(initial.result.hasApiKey, false);
    const saved = await call("distro.configure", { baseUrl: "http://127.0.0.1:12345", apiKey: "fixture-secret", useNpmMirror: false });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.result.hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(saved), /fixture-secret/);
    const reread = await call("distro.status");
    assert.equal(reread.result.baseUrl, "http://127.0.0.1:12345");
    assert.doesNotMatch(JSON.stringify(reread), /fixture-secret/);
    const models = JSON.parse(await readFile(join(agent, "models.json"), "utf8"));
    assert.equal(models.providers[saved.result.providerId].apiKey, "fixture-secret");
    const kept = await call("distro.configure", { baseUrl: "http://127.0.0.1:12346", apiKey: "", useNpmMirror: false });
    assert.equal(kept.ok, true, JSON.stringify(kept));
    assert.equal(kept.result.hasApiKey, true);
  } finally {
    if (child) await child.close(5_000);
    await rm(root, { recursive: true, force: true });
  }
});
