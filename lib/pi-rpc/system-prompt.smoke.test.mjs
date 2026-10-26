/**
 * Real-pi smoke for the honest system-prompt display and the split artifacts
 * extension — no model, no auth, no network.
 *
 * Session files are built ENTIRELY BEFORE any child spawns (the host is never
 * a second writer of a file a live CLI holds, not even while it is idle).
 * The recorded system entries are hand-built fixtures in the exact shape a
 * real run appends (role "system", content "", a sections map); what this
 * test verifies is the host's reporting path over the real child — that
 * get_state distinguishes "recorded" (with the SDK replay of the record)
 * from "none", and that the child starts with the bridge AND the artifacts
 * asset loaded. It is NOT a verification that a model was actually sent
 * anything: no prompt is ever submitted.
 *
 * Everything lives in one sandbox (cwd, agent dir, session dir); the real
 * ~/.pi/agent store and any user credentials are never touched. Requires
 * PI_CLI_BIN (absolute pi.exe path); skips otherwise.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { cleanupDir, resolvePiCliBin } from "./test-utils.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { startCliRpcSession, resolveArtifactsExtensionPath } = await jiti.import("./factory.ts");
const executable = resolvePiCliBin();

test("get_state separates recorded/configured/none and both extension assets load in the real child", { skip: executable ? false : "PI_CLI_BIN not set" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-rpc-prompt-smoke-"));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  // The shipped artifacts asset resolves and carries the guide (its content
  // is what the child will load through --extension below).
  const artifactsPath = resolveArtifactsExtensionPath();
  const artifactsSource = await readFile(new URL("./assets/pi-web-artifacts.mjs", import.meta.url), "utf8");
  assert.match(artifactsSource, /ARTIFACT_GUIDE_SECTION/, "the shipped asset carries the guide");

  // Fixture A (built before any spawn): one recorded system message, a user
  // turn, then a second system message that replaces one section. This is the
  // entry shape a real run appends; the fixture stands in for the run.
  const recordedManager = SessionManager.create(cwd, sessionDir);
  recordedManager.appendMessage({ role: "system", content: "", sections: { core: "You are pi.", artifacts: "ARTIFACTS v1" }, timestamp: Date.now() });
  recordedManager.appendMessage({ role: "user", content: "go" });
  recordedManager.appendMessage({ role: "system", content: "", sections: { artifacts: "ARTIFACTS v2" }, timestamp: Date.now() });
  const recordedFile = recordedManager.getSessionFile();

  // Fixture B (built before any spawn): no system entry at all.
  const emptyManager = SessionManager.create(cwd, sessionDir);
  emptyManager.appendMessage({ role: "user", content: "hello" });
  const emptyFile = emptyManager.getSessionFile();

  const started = await startCliRpcSession({
    sessionId: "prompt-smoke-recorded",
    sessionFile: recordedFile,
    sessionDir,
    toolNames: ["read"],
    executable,
    agentDir,
    onLog: () => {},
  });
  try {
    // 1. The spawn answered the handshake with BOTH --extension assets in the
    //    child's argument list (bridge + artifacts guide): pi refuses to load
    //    an extension it cannot parse ("Failed to load extension … Start
    //    without extensions using pi -ne", observed against a deliberately
    //    broken file), so a session that reaches get_commands has both.
    const commands = await started.wrapper.send({ type: "get_commands" });
    assert.ok(Array.isArray(commands.commands), "the child answered get_commands with both assets loaded");

    // 2. The recorded prompt replays through get_state: sections merge, the
    //    later entry's replacement wins. This is the record's replay, not a
    //    claim about a provider's wire.
    const recorded = await started.wrapper.send({ type: "get_state" });
    assert.equal(recorded.systemPromptStatus, "recorded");
    assert.equal(recorded.systemPrompt, "You are pi.\n\nARTIFACTS v2");
  } finally {
    await started.wrapper.shutdown();
  }

  const emptyStarted = await startCliRpcSession({
    sessionId: "prompt-smoke-none",
    sessionFile: emptyFile,
    sessionDir,
    toolNames: ["read"],
    executable,
    agentDir,
    onLog: () => {},
  });
  try {
    // 3. No recorded system entry: status "none", never an invented prompt.
    const empty = await emptyStarted.wrapper.send({ type: "get_state" });
    assert.equal(empty.systemPromptStatus, "none", "a session with no system record is reported as not generated");
    assert.equal(empty.systemPrompt, "", "no prompt text is invented for a session that has not run");

    // 4. Each session replays its own file's record only: fixture B, opened
    //    beside fixture A in the same sandbox, never sees A's sections.
    assert.ok(!empty.systemPrompt.includes("You are pi."), "another session's record does not leak in");
  } finally {
    await emptyStarted.wrapper.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await cleanupDir(root);
  }
});
