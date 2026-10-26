#!/usr/bin/env node
/**
 * Verifies the *packaged* server that `npm run desktop:prepare` stages, using
 * the Node runtime bundled with it.
 *
 * Since the CLI-engine migration every session runs on a bundled `pi --mode
 * rpc` child, and Code mode's QuickJS sandbox ships inside that pi
 * distribution — its completeness is gated by `pi-distribution.json`
 * (`complete: true` under PI_DESKTOP_REQUIRE_PI=1, verified per file by
 * scripts/verify-packaged-frontend.mjs). Nothing in this server process
 * executes the sandbox any more, so this script gates what the staged server
 * itself must still do:
 *
 *  - start under the bundled Node and answer /api/home;
 *  - create a session end to end — spawn the bundled pi child, load the
 *    bridge extension and reach session start. The child's stderr is relayed
 *    into the server log, so the module-resolution scan below covers both
 *    processes: a "Cannot find module" anywhere fails the build;
 *  - import pi-ai's Amazon Bedrock implementation from the staged tree with
 *    the bundled Node. pi-ai reaches it through a variable specifier, so the
 *    file tracer drops `@aws-sdk/client-bedrock-runtime` and a packaged
 *    amazon-bedrock session would die with ERR_MODULE_NOT_FOUND at the first
 *    stream (see stageResolvedClosure in prepare-desktop.mjs).
 *
 * Not covered: jiti (nothing in the staged server loads user extensions any
 * more; the pi child loads its own) and the pi distribution's own internals
 * (the manifest check owns those).
 *
 *   npm run desktop:prepare && node scripts/verify-packaged-server.mjs
 *
 * Runs against a throwaway HOME / PI_CODING_AGENT_DIR, never the user's data.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const resourcesDir = join(rootDir, "src-tauri", "resources");
const serverDir = join(resourcesDir, "server");

const NODE_CANDIDATES = [
  join(resourcesDir, "Pi Agent Server.app", "Contents", "MacOS", "node"),
  join(resourcesDir, "node", "node"),
  join(resourcesDir, "node", "node.exe"),
];

const STARTUP_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

function fail(message) {
  console.error(`verify-packaged-server: ${message}`);
  process.exitCode = 1;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the server exited early (code ${child.exitCode})`);
    try {
      const response = await fetch(`${baseUrl}/api/home`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the server did not answer within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

const BEDROCK_ENTRY = join(
  serverDir,
  "node_modules",
  "@earendil-works",
  "pi-ai",
  "dist",
  "api",
  "bedrock-converse-stream.js",
);

/** Imports the staged Bedrock implementation with the bundled Node; resolves to an error message or null. */
function importStagedBedrock(nodePath) {
  return new Promise((resolve) => {
    const script = `import(${JSON.stringify(pathToFileURL(BEDROCK_ENTRY).href)}).then(() => process.exit(0), (error) => { console.error(error?.code ? error.code + ": " + error.message : String(error)); process.exit(1); });`;
    const probe = spawn(nodePath, ["--input-type=module", "-e", script], { cwd: serverDir, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    probe.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    probe.once("error", (error) => resolve(error.message));
    probe.once("exit", (code) => resolve(code === 0 ? null : stderr.trim().split("\n")[0] || `exit code ${code}`));
  });
}

async function main() {
  const nodePath = NODE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!nodePath || !existsSync(join(serverDir, "server.js"))) {
    fail("no packaged server found; run `npm run desktop:prepare` first.");
    return;
  }

  // The child extension assets are resolved at runtime from the server cwd,
  // so the file tracer cannot be trusted with them; prepare-desktop stages
  // them explicitly. Both are load-bearing for every session start: the
  // bridge owns navigate/reload (a missing one fails the factory's post-spawn
  // check), the artifacts guide owns the prompt section behind Settings ›
  // General › Chat, and resolveAssetPath throws at session start when either
  // is absent.
  for (const asset of ["pi-web-bridge.mjs", "pi-web-artifacts.mjs", "pi-web-chat.mjs"]) {
    const staged = join(serverDir, "lib", "pi-rpc", "assets", asset);
    if (!existsSync(staged)) {
      fail(`the staged server is missing the child extension asset ${asset} (${staged}); prepare-desktop must stage lib/pi-rpc/assets.`);
      return;
    }
  }
  console.log("assets: the staged child extension assets (bridge, artifacts guide, chat policy) are present.");

  const bedrockError = await importStagedBedrock(nodePath);
  if (bedrockError) {
    fail(`the staged Amazon Bedrock implementation cannot be imported: ${bedrockError}`);
    return;
  }
  console.log("bedrock: the staged Amazon Bedrock implementation imports.");

  const scratch = await mkdtemp(join(tmpdir(), "pi-packaged-server-"));
  const agentDir = join(scratch, "agent");
  const workDir = join(scratch, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(workDir, { recursive: true });

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logChunks = [];
  const child = spawn(nodePath, [join(serverDir, "server.js")], {
    cwd: serverDir,
    env: {
      ...process.env,
      HOME: scratch,
      USERPROFILE: scratch,
      PI_CODING_AGENT_DIR: agentDir,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      PI_WEB_PARENT_PID: String(process.pid),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => logChunks.push(chunk.toString()));
  }
  const logTail = () => logChunks.join("").split("\n").slice(-25).join("\n");

  try {
    console.log(`runtime: ${nodePath}`);
    await waitForServer(baseUrl, child);

    const created = await fetch(`${baseUrl}/api/agent/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: workDir, type: "ensure_session" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!created.ok) {
      fail(`creating a session failed (HTTP ${created.status}): ${await created.text()}`);
      return;
    }

    const overview = await fetch(`${baseUrl}/api/mcp`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!overview.ok) {
      fail(`GET /api/mcp failed (HTTP ${overview.status}): ${await overview.text()}`);
      return;
    }

    const resolutionErrors = [...new Set(logChunks.join("").match(/(?:Cannot find module|ERR_MODULE_NOT_FOUND)[^\n]*/g) ?? [])];
    if (resolutionErrors.length === 0) {
      console.log("OK: the packaged server created a session over the bundled pi child; no module resolution errors in the log.");
    } else {
      fail(`the server log reports missing modules:\n  ${resolutionErrors.join("\n  ")}`);
      console.error(`--- server log (tail) ---\n${logTail()}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    console.error(`--- server log (tail) ---\n${logTail()}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
      setTimeout(resolve, 3_000).unref();
    });
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
