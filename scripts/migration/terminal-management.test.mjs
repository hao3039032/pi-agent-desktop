import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { buildProjectionInto } from "./build-management-modules.mjs";
import { resolvePiCliBin } from "../../lib/pi-rpc/test-utils.mjs";

const executable = resolvePiCliBin();
const { PiRpcClient } = await createJiti(import.meta.url, { interopDefault: true }).import("../../lib/pi-rpc/client.ts");

test("terminal settings persist through the real management child and retain unrelated settings", { skip: executable ? false : "PI_CLI_BIN not set" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "terminal-management-"));
  let child;
  try {
    const agent = join(root, "agent");
    const managed = join(root, "managed");
    await mkdir(join(agent, "pi-web"), { recursive: true });
    await writeFile(join(agent, "pi-web", "settings.json"), JSON.stringify({ unrelated: "preserve" }));
    await buildProjectionInto(managed);
    const nonce = "terminal-fixture";
    const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, PI_WEB_MANAGED_MODULES: managed, PI_WEB_MGMT_NONCE: nonce };
    delete env.PI_PACKAGE_DIR;
    delete env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
    delete env.JITI_ALIAS;
    child = new PiRpcClient(executable, {
      cwd: root,
      args: ["--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", join(import.meta.dirname, "../../lib/pi-rpc/assets/pi-web-management.mjs")],
      env, onLog: () => {},
    });
    const envelopes = [];
    child.onUi("notify", record => {
      if (typeof record.message === "string" && record.message.startsWith("PI_WEB_MGMT_V1 ")) envelopes.push(JSON.parse(record.message.slice(15)));
    });
    let counter = 0;
    async function call(op, args = {}) {
      const requestId = `terminal-${++counter}`;
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
    const initial = await call("terminal.settingsGet");
    assert.equal(initial.ok, true, JSON.stringify(initial));
    assert.equal(initial.result.shell, "auto");
    assert.ok(initial.result.options.length > 0);
    const shell = initial.result.options[0].value;
    const saved = await call("terminal.settingsSet", { shell });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(saved.result.shell, shell);
    const reread = await call("terminal.settingsGet");
    assert.equal(reread.result.shell, shell);
    const resolution = await call("terminal.resolveShell");
    assert.equal(resolution.result.path, shell);
    assert.ok(Array.isArray(resolution.result.args));
    const disk = JSON.parse(await readFile(join(agent, "pi-web", "settings.json"), "utf8"));
    assert.equal(disk.unrelated, "preserve");
    assert.equal(disk.terminalShell, shell);
    const refused = await call("terminal.settingsSet", { shell: "/invalid-fixture-shell" });
    assert.equal(refused.ok, false);
    assert.equal(JSON.parse(await readFile(join(agent, "pi-web", "settings.json"), "utf8")).terminalShell, shell);
  } finally {
    if (child) await child.close(5_000);
    await rm(root, { recursive: true, force: true });
  }
});
