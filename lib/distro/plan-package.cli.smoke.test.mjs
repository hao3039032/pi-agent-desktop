/**
 * Real-pi-child smoke for the prompt-based /plan package — the CLI RPC
 * engine's own discovery, not the in-process SDK wrapper:
 *
 *   - the real seed (src-tauri/resources/pi-seed, produced by
 *     `npm run distro:seed`) is registered by the real seeder
 *     (lib/distro/seed.ts) into a throwaway agent dir;
 *   - a `pi --mode rpc` child started over that agent dir answers
 *     `get_commands` with the plan command as `source: "prompt"` from the
 *     bundled package (origin "package", baseDir inside the seed);
 *   - no model is configured or called: discovery and reporting only.
 *
 * The child is the repository's own pi CLI (the SDK shipped in node_modules,
 * driven through PiRpcClient's `spawnChild` seam with `process.execPath` —
 * the same real CLI on every platform; the `.bin` shims are not directly
 * spawnable on Windows). Everything lives in one sandbox: temp HOME /
 * USERPROFILE / PI_CODING_AGENT_DIR, so no user configuration or credentials
 * are read or written. Skips when the gitignored seed has not been built —
 * CI covers the same package contents through the fixture copy in
 * lib/distro/plan-package.test.mjs.
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

test("the real pi child reports the seeded plan template over RPC get_commands", { skip, timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "distro-plan-cli-"));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const sessionDir = join(root, "sessions");
  await Promise.all([cwd, agentDir, home, sessionDir].map((dir) => mkdir(dir, { recursive: true })));

  // The real seeding path over the real generated seed: the throwaway agent
  // dir's settings.json ends up pointing at the bundled package copy.
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = home;
  /** The real child, kept for the SIGKILL backstop below. */
  let child;
  let client;
  try {
    await seedAgentDir(resourcesDir, agentDir);
    const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
    const pkgDir = settings.packages.find((entry) => String(entry).includes(join("pi-seed", "npm", "node_modules", "@codella", "pi-prompt-plan")));
    assert.ok(pkgDir, `the seed registered the bundled prompt plan (${JSON.stringify(settings.packages)})`);
    await writeFile(join(agentDir, "auth.json"), "{}", "utf8");

    client = new PiRpcClient(repoCliJs, {
      cwd,
      // Prompt templates stay enabled — they are the thing under test. The
      // other ambient resources stay off so only the seeded package contributes.
      args: ["--no-extensions", "--no-skills", "--no-themes", "--no-context-files"],
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
      onLog: () => {},
      // Same real CLI on every platform: node runs the repo's own cli.js.
      spawnChild: (executable, args, options) => {
        child = spawn(process.execPath, [executable, ...args], options);
        return child;
      },
    });

    const result = await client.command("get_commands", {}, 15_000);
    const commands = Array.isArray(result?.commands) ? result.commands : [];
    const plan = commands.find((command) => command.name === "plan");
    assert.ok(plan, `get_commands must list plan (${commands.map((command) => command.name).join(", ")})`);
    assert.equal(plan.source, "prompt");
    assert.equal(plan.sourceInfo?.origin, "package");
    assert.equal(plan.sourceInfo?.baseDir, pkgDir, "attributed to the bundled seed copy");
  } finally {
    // Bounded teardown, in the bridge-smoke order: close() ends stdin, waits
    // for the exit and force-kills after its 5s grace; if anything still
    // lives (or close() itself could not run), SIGKILL the child we spawned
    // so a failing assertion can never leak a live pi against a deleted dir.
    // Start the hard deadline BEFORE awaiting close(): a child that ignores
    // close()'s SIGTERM must not prevent the SIGKILL backstop from running.
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
