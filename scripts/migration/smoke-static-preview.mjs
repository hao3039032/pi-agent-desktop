#!/usr/bin/env node
// Offline smoke of the staged CLI and independent management SDK. The cwd and
// HOME are outside the checkout; both executables come from the resource root.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifyBundle } from "./static-bundle-manifest.mjs";

if (process.argv.length !== 3) throw new Error("usage: node scripts/migration/smoke-static-preview.mjs <resource-dir>");
const root = resolve(process.argv[2]);
// Node would otherwise search ancestor node_modules and turn a partial
// resource tree inside a checkout into a false standalone success.
for (let dir = dirname(root); ; dir = dirname(dir)) {
  if (existsSync(join(dir, "node_modules"))) throw new Error(`ambient node_modules above resource root: ${dir}`);
  if (dirname(dir) === dir) break;
}
const manifest = JSON.parse(readFileSync(join(root, "bundle-manifest.json"), "utf8"));
verifyBundle(root, manifest, { requireManagementSdk: true });
const runtime = manifest.managementRuntime;
const temp = mkdtempSync(join(tmpdir(), "pi-preview-smoke-"));
const agent = join(temp, "agent");
mkdirSync(agent);
const env = { ...process.env, HOME: temp, USERPROFILE: temp, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" };
for (const key of ["PI_PACKAGE_DIR", "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT", "JITI_ALIAS", "NODE_OPTIONS", "NODE_PATH"]) delete env[key];

async function probe(program, args, input, accept, extraEnv = {}) {
  const child = spawn(program, args, { cwd: temp, env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  try {
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("offline smoke timed out")), 30000);
      const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolvePromise(); };
      child.on("error", finish);
      child.on("exit", (code) => finish(new Error(`offline smoke child exited before reply: ${code}`)));
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > 1024 * 1024) return finish(new Error("offline smoke output limit"));
        let end;
        while ((end = stdout.indexOf("\n")) >= 0) {
          const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
          try { if (accept(JSON.parse(line))) return finish(); } catch (error) { return finish(error); }
        }
      });
      child.stdin.on("error", finish);
      child.stdin.write(`${JSON.stringify(input)}\n`);
    });
  } finally {
    child.kill();
    await new Promise((done) => { if (child.exitCode !== null || child.signalCode !== null) return done(); child.once("exit", done); setTimeout(done, 5000).unref(); });
  }
}
try {
  await probe(join(root, runtime.cli), ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"], { id: "preview-state", type: "get_state" }, (message) => message.type === "response" && message.id === "preview-state" && message.success === true);
  const nonce = "preview-offline-smoke";
  const token = Buffer.from(JSON.stringify({ nonce, op: "sys.capabilities", args: {} })).toString("base64url");
  await probe(join(root, runtime.node), [join(root, runtime.entry)], { id: "preview-command", type: "prompt", message: `/pi-web:mgmt preview-capabilities ${token}` }, (message) => {
    if (!message.message?.startsWith("PI_WEB_MGMT_V1 ")) return false;
    const result = JSON.parse(message.message.slice("PI_WEB_MGMT_V1 ".length));
    return result.rid === "preview-capabilities" && result.ok === true && result.result?.version === 1;
  }, { PI_WEB_MANAGED_MODULES: join(root, runtime.projectionRoot), PI_WEB_MANAGEMENT_SDK_ROOT: join(root, runtime.dependencyRoot), PI_WEB_MANAGEMENT_CLI_VERSION: runtime.piVersion, PI_WEB_MGMT_NONCE: nonce });
  console.log("Offline staged pi RPC and independent management SDK capabilities passed; not an installed/native acceptance.");
} finally { rmSync(temp, { recursive: true, force: true }); }
