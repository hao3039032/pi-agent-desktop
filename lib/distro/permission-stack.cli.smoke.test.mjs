/**
 * Real-pi-child smoke for the seeded permission stack — the CLI RPC engine's
 * own extension loading, not the in-process SDK wrapper:
 *
 *   - the real seed (src-tauri/resources/pi-seed, produced by
 *     `npm run distro:seed`) is registered by the real seeder
 *     (lib/distro/seed.ts) into a throwaway agent dir, so the first-start
 *     order under test is the real one: `agentFiles` seed the new permission
 *     config, then release migration 0.8.704 sees it and leaves it alone;
 *   - a `pi --mode rpc` child started over that agent dir loads every bundled
 *     extension: `get_commands` answers with `/yolo` from the bundled
 *     pi-permission-yolo-toggle (origin "package", baseDir inside the seed)
 *     beside the permission system's and the reviewer's own commands;
 *   - the child's diagnostics carry no failed extension load and no warning
 *     about the retired `yoloMode` key or an unresolvable chain link;
 *   - no model is configured or called: loading and reporting only.
 *
 * The child is the repository's own pi CLI (the SDK shipped in node_modules,
 * driven through PiRpcClient's `spawnChild` seam with `process.execPath`).
 * Everything lives in one sandbox: temp HOME / USERPROFILE /
 * PI_CODING_AGENT_DIR, so no user configuration or credentials are read or
 * written. Skips when the gitignored seed has not been built.
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { cleanupDir } from "../pi-rpc/test-utils.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, "..", "..");
const resourcesDir = join(rootDir, "src-tauri", "resources");
const seedManifest = join(resourcesDir, "pi-seed", "manifest.json");
/** Always exercise this checkout's JS CLI; PI_CLI_BIN may be a native binary
 * or shell wrapper and must not be passed to Node as JavaScript. */
const repoCliJs = join(rootDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { seedAgentDir } = await jiti.import("./seed.ts");
const { PiRpcClient } = await jiti.import("../pi-rpc/client.ts");

const skip = !existsSync(seedManifest)
  ? "src-tauri/resources/pi-seed not built (run npm run distro:seed)"
  : existsSync(repoCliJs) ? false : "no pi CLI available";

test("the real pi child loads the seeded permission stack with the yolo-session link and no retired-key warning", { skip, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "distro-permission-cli-"));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  await Promise.all([cwd, agentDir, home].map((dir) => mkdir(dir, { recursive: true })));

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = home;
  /** The real child, kept for the SIGKILL backstop below. */
  let child;
  let client;
  const logs = [];
  try {
    await seedAgentDir(resourcesDir, agentDir);
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    const toggleDir = settings.packages.find((entry) => String(entry).includes(join("pi-seed", "git", "github.com", "hao3039032", "pi-permission-yolo-toggle")));
    assert.ok(toggleDir, `the seed registered the bundled yolo toggle (${JSON.stringify(settings.packages)})`);
    const permissionDir = settings.packages.find((entry) => String(entry).includes(join("pi-seed", "npm", "node_modules", "@gotgenes", "pi-permission-system")));
    assert.ok(permissionDir, `the seed registered the bundled permission system (${JSON.stringify(settings.packages)})`);
    assert.ok(existsSync(join(permissionDir, "package.json")), "the registered permission system is the bundled copy");
    const permission = JSON.parse(await readFile(join(agentDir, "extensions", "pi-permission-system", "config.json"), "utf8"));
    assert.deepEqual(permission.authorizerChain, ["yolo-session", "pi-auto-review"]);
    assert.equal("yoloMode" in permission, false);
    // First start: the seeded config is already the new one, so the 0.8.704
    // migration writes no toggle file and the extension's own default (on) applies.
    assert.equal(existsSync(join(agentDir, "extensions", "pi-permission-yolo-toggle", "config.json")), false);
    await writeFile(join(agentDir, "auth.json"), "{}", "utf8");

    client = new PiRpcClient(repoCliJs, {
      cwd,
      // Extensions are the thing under test; the other ambient resources stay
      // off so only the seeded packages contribute.
      args: ["--no-skills", "--no-themes", "--no-context-files"],
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        HOME: home,
        USERPROFILE: home,
        // The host's SDK-repointing variables must not reach the child.
        PI_PACKAGE_DIR: "",
        PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: "",
        JITI_ALIAS: "",
      },
      onLog: (line) => logs.push(line),
      // Same real CLI on every platform: node runs the repo's own cli.js.
      spawnChild: (executable, args, options) => {
        child = spawn(process.execPath, [executable, ...args], options);
        return child;
      },
    });

    const result = await client.command("get_commands", {}, 30_000);
    const commands = Array.isArray(result?.commands) ? result.commands : [];
    const names = commands.map((command) => command.name);
    const yolo = commands.find((command) => command.name === "yolo");
    assert.ok(yolo, `get_commands must list yolo (${names.join(", ")})`);
    assert.equal(yolo.source, "extension");
    assert.equal(yolo.sourceInfo?.origin, "package");
    assert.equal(yolo.sourceInfo?.baseDir, toggleDir, "attributed to the bundled seed copy");
    assert.ok(names.includes("permission-system"), `the permission system's own command must be there (${names.join(", ")})`);
    assert.ok(names.includes("auto-review-approve"), `the reviewer's command must be there (${names.join(", ")})`);

    const diagnostics = logs.join("\n");
    assert.doesNotMatch(diagnostics, /Failed to load extension/i, diagnostics);
    assert.doesNotMatch(diagnostics, /yoloMode/i, `the retired key must not be warned about:\n${diagnostics}`);
    assert.doesNotMatch(diagnostics, /yolo-session/i, `the chain link must resolve without a skip warning:\n${diagnostics}`);
  } finally {
    // Bounded teardown, in the bridge-smoke order: close() ends stdin, waits
    // for the exit and force-kills after its 5s grace; if anything still
    // lives (or close() itself could not run), SIGKILL the child we spawned
    // so a failing assertion can never leak a live pi against a deleted dir.
    const killDeadline = setTimeout(() => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }, 6_000);
    try {
      if (client) await client.close().catch(() => null);
    } finally {
      clearTimeout(killDeadline);
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await cleanupDir(root);
  }
});
