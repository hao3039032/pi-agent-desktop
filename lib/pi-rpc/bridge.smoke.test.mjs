/**
 * Real-pi smoke for the bridge extension's tool operations — no model, no
 * auth, no network:
 *
 *   - the bridge command is attributed to the SHIPPED asset (source path, not
 *     just the name) by the child's own get_commands;
 *   - tools.list carries a fixture extension's real tool metadata;
 *   - tools.apply really activates the requested set and the CHILD appends the
 *     pi-web:tool-selection pin into its own entry chain (the host is not a
 *     second writer while the child lives);
 *   - the machine-token command never reaches the agent: no run starts and no
 *     message entry is written.
 *
 * Everything lives in one sandbox (cwd, agent dir, session dir); the real
 * ~/.pi/agent store and any user credentials are never touched. Requires
 * PI_CLI_BIN (absolute pi.exe path); skips otherwise.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { cleanupDir, resolvePiCliBin } from "./test-utils.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { PiRpcClient } = await jiti.import("./client.ts");
const { CliAgentSessionCore, ensureSessionFile, initialCoreState } = await jiti.import("./core.ts");
const { resolveBridgeExtensionPath } = await jiti.import("./factory.ts");

const executable = resolvePiCliBin();

/** A fixture extension: one registerable tool with metadata worth asserting. */
const FIXTURE_TOOL = "fixture_probe";
const FIXTURE_EXTENSION = `
export default function fixtureExtension(pi) {
  // Public protocol fixture only: not the installed pi-subagents package,
  // and never creates or controls a real child run.
  pi.events.on("subagents:rpc:v1:request", (request) => {
    const reply = {
      version: 1, requestId: request.requestId, method: request.method,
      success: true,
      data: request.method === "ping"
        ? { version: 1, methods: ["ping", "status", "steer", "interrupt", "stop"], capabilities: { status: true } }
        : { text: "fixture fleet response", fixtureMethod: request.method, fixtureParams: request.params ?? {} },
    };
    pi.events.emit("subagents:rpc:v1:reply:" + request.requestId, reply);
  });
  pi.registerTool({
    name: "${FIXTURE_TOOL}",
    label: "Fixture probe",
    description: "A fixture tool the bridge smoke test lists",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
}
`;

/** The session file's entries, as the child wrote them. */
async function readEntries(sessionFile) {
  const text = await readFile(sessionFile, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("bridge tool operations over the real pi child", { skip: executable ? false : "PI_CLI_BIN not set" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rpc-bridge-smoke-"));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const fixturePath = join(root, "fixture-extension.mjs");
  await writeFile(fixturePath, FIXTURE_EXTENSION, "utf8");

  const manager = SessionManager.create(cwd, sessionDir);
  const sessionFile = ensureSessionFile(manager);
  const bridgeExtensionPath = resolveBridgeExtensionPath();
  const bridgeNonce = randomUUID();

  const client = new PiRpcClient(executable, {
    cwd,
    // -ne/-ns/-np keep discovered resources out; the two explicit -e paths are
    // the only extensions, so the listing cannot be polluted by the host's own
    // ~/.pi configuration. The agent dir is sandboxed: no user auth is read.
    args: [
      "--session", sessionFile,
      "--session-dir", sessionDir,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--extension", fixturePath,
      "--extension", bridgeExtensionPath,
    ],
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_WEB_BRIDGE_NONCE: bridgeNonce,
    },
    onLog: () => {},
  });
  const events = [];
  client.onEvent((record) => events.push(record));
  const core = new CliAgentSessionCore({
    client,
    initialState: initialCoreState({ sessionId: "bridge-smoke" }),
    sessionFile,
    cwd,
    knownToolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    bridgeExtensionPath,
    bridgeNonce,
    sessionDir,
    agentDir,
    onLog: () => {},
  });

  try {
    await core.refreshState();
    await core.refreshCommands();

    // 1. The source contract: the command is the shipped asset's, by path.
    assert.equal(core.hasBridgeCommand("pi-web:navigate"), true);
    assert.equal(core.hasBridgeCommand("pi-web:bridge"), true);

    // 2. The real tool list, fixture metadata included.
    await core.refreshTools();
    assert.equal(core.supportsLiveToolSwitch(), true);
    const listed = core.getAllTools();
    const fixture = listed.find((tool) => tool.name === FIXTURE_TOOL);
    assert.ok(fixture, `the fixture tool is listed (${listed.map((tool) => tool.name).join(", ")})`);
    assert.equal(fixture.description, "A fixture tool the bridge smoke test lists");
    assert.deepEqual(fixture.parameters, { type: "object", properties: {}, additionalProperties: false });
    assert.ok(listed.some((tool) => tool.name === "read"), "the built-in tools are listed too");

    // 3. Two applies: the child writes each pin into its own chain.
    await core.applyToolSelection(["read", FIXTURE_TOOL], ["read"]);
    assert.deepEqual(core.getActiveToolNames().sort(), [FIXTURE_TOOL, "read"].sort());
    const afterFirst = (await readEntries(sessionFile)).filter((entry) => entry.customType === "pi-web:tool-selection");
    assert.equal(afterFirst.length, 1, "one pin entry");
    assert.deepEqual(afterFirst[0].data, { version: 1, tools: ["read"] });

    await core.applyToolSelection(["read", "grep"], ["read", "grep"]);
    assert.deepEqual(core.getActiveToolNames().sort(), ["grep", "read"].sort());
    const pins = (await readEntries(sessionFile)).filter((entry) => entry.customType === "pi-web:tool-selection");
    assert.equal(pins.length, 2, "the second pin is a new entry");
    assert.deepEqual(pins[1].data, { version: 1, tools: ["read", "grep"] });
    // The child appended it into its own tree: the second pin hangs off the
    // first, so the host was never a second writer of this file.
    assert.ok(pins[1].id, "the child assigned the entry id");
    assert.equal(pins[1].parentId, pins[0].id, "the pin's parent is the child's previous leaf");

    // 4. Exercise the restricted fleet hop over actual child stdio and its
    // own pi.events bus. The fixture is deliberately NOT attributed to the
    // pi-subagents package; a matching protocol answer is still reachable.
    const { createBridgeSubagentTransport } = await jiti.import("../pi-subagents-rpc.ts");
    const fleet = createBridgeSubagentTransport(core.requestSubagentsRpc.bind(core));
    const ping = await fleet.call("ping");
    assert.equal(ping.data.version, 1);
    assert.ok(ping.data.methods.includes("status"));
    const status = await fleet.call("status", { id: "fixture-run", view: "transcript", lines: 12 });
    assert.equal(status.data.text, "fixture fleet response");
    assert.deepEqual(status.data.fixtureParams, { id: "fixture-run", view: "transcript", lines: 12 });
    await assert.rejects(core.requestSubagentsRpc("spawn", {}), /unknown|unsupported|not allowed/i);
    await assert.rejects(core.requestSubagentsRpc("status", { dir: cwd }), /does not accept|invalid/i);

    // 5. Neither tool nor fleet bridge commands start a run or add messages.
    const entries = await readEntries(sessionFile);
    assert.deepEqual(
      entries.filter((entry) => entry.type === "message"),
      [],
      "no user or assistant message was recorded",
    );
    assert.equal(events.some((event) => event.type === "agent_start"), false, "no agent run started");
  } finally {
    core.dispose();
    await client.close().catch(() => null);
    await cleanupDir(root);
  }
});
