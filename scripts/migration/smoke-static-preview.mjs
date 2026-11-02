#!/usr/bin/env node
// Offline smoke of the staged CLI and independent management SDK. The cwd and
// HOME are outside the checkout; both executables come from the resource root.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { verifyBundle } from "./static-bundle-manifest.mjs";
import { ProbeExitUnconfirmedError, runPreviewProbe } from "./preview-smoke-probe.mjs";

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

const probe = (program, args, input, accept, extraEnv = {}) => runPreviewProbe({ program, args, input, accept, cwd: temp, env: { ...env, ...extraEnv } });
let retainTemp = false;
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
} catch (error) {
  retainTemp = error instanceof ProbeExitUnconfirmedError;
  if (retainTemp) console.error(`Probe exit unconfirmed; retained temporary directory: ${temp}`);
  throw error;
} finally { if (!retainTemp) rmSync(temp, { recursive: true, force: true }); }
