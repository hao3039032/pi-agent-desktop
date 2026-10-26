/**
 * Unit tests for the artifacts guide extension asset
 * (lib/pi-rpc/assets/pi-web-artifacts.mjs) — plain JS, no pi binary: the
 * switch runs against a scripted `pi` object the way the child's extension
 * runtime would drive it.
 *
 * The guide moved out of the bridge (the bridge is protocol and security
 * bridging only), so these tests pin the full behavior that must survive the
 * move: per-run switching, default-on, the off switch, the agentDir rule, and
 * the bridge/artifacts split (the bridge alone injects nothing; both loaded
 * together set the section exactly once).
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const artifactsModule = await jiti.import("./assets/pi-web-artifacts.mjs");
const artifacts = artifactsModule.default ?? artifactsModule;
const bridgeModule = await jiti.import("./assets/pi-web-bridge.mjs");
const bridge = bridgeModule.default ?? bridgeModule;

/** A minimal `pi` object; the artifacts guide only registers before_agent_start. */
function makePi() {
  const handlers = new Map();
  return {
    handlers,
    on: (event, handler) => handlers.set(`on:${event}`, handler),
    registerCommand: (name, definition) => handlers.set(name, definition),
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => {},
    appendEntry: () => {},
  };
}

function callBeforeAgentStart(pi) {
  const event = { systemPromptOptions: { sections: {} } };
  const handler = pi.handlers.get("on:before_agent_start");
  if (!handler) throw new Error("before_agent_start is not registered");
  const result = handler(event, { sessionManager: { getEntries: () => [] } });
  return { event, result };
}

/** Sandboxes PI_CODING_AGENT_DIR for one test body and gives its path back. */
function withSandboxAgentDir(run) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const sandbox = mkdtempSync(join(tmpdir(), "pi-web-artifacts-agentdir-"));
  process.env.PI_CODING_AGENT_DIR = sandbox;
  try {
    return run(sandbox);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function writeSettings(agentDir, value) {
  mkdirSync(join(agentDir, "pi-web"), { recursive: true });
  writeFileSync(join(agentDir, "pi-web", "settings.json"), JSON.stringify(value));
}

test("default on: the section is added on every run while no settings file exists", () => {
  withSandboxAgentDir(() => {
    const pi = makePi();
    artifacts(pi);

    const first = callBeforeAgentStart(pi);
    assert.match(String(first.event.systemPromptOptions.sections.artifacts ?? ""), /:::artifact/);
    assert.equal(first.result, undefined);

    // The next run reads the file again: still on, and set (not appended).
    const second = callBeforeAgentStart(pi);
    assert.ok(second.event.systemPromptOptions.sections.artifacts === first.event.systemPromptOptions.sections.artifacts);
  });
});

test("the switch is read per run: turning it off removes the section from the next run only", () => {
  withSandboxAgentDir((agentDir) => {
    const pi = makePi();
    artifacts(pi);

    const on = callBeforeAgentStart(pi);
    assert.ok("artifacts" in on.event.systemPromptOptions.sections);

    writeSettings(agentDir, { artifactsPrompt: false });
    const off = callBeforeAgentStart(pi);
    assert.equal("artifacts" in off.event.systemPromptOptions.sections, false, "the section is removed when the switch is off");

    // An existing section from an earlier run is deleted, not just skipped.
    const stale = { systemPromptOptions: { sections: { artifacts: "old guide" } } };
    pi.handlers.get("on:before_agent_start")(stale, { sessionManager: { getEntries: () => [] } });
    assert.equal("artifacts" in stale.systemPromptOptions.sections, false);

    // Turning it back on applies on the very next run.
    writeSettings(agentDir, { artifactsPrompt: true });
    const back = callBeforeAgentStart(pi);
    assert.match(String(back.event.systemPromptOptions.sections.artifacts ?? ""), /:::artifact/);
  });
});

test("an unreadable or malformed settings file keeps the guide on", () => {
  withSandboxAgentDir((agentDir) => {
    writeSettings(agentDir, {});
    mkdirSync(join(agentDir, "pi-web"), { recursive: true });
    writeFileSync(join(agentDir, "pi-web", "settings.json"), "not json");
    const pi = makePi();
    artifacts(pi);
    const run = callBeforeAgentStart(pi);
    assert.match(String(run.event.systemPromptOptions.sections.artifacts ?? ""), /:::artifact/);
  });
});

test("the agentDir rule: PI_CODING_AGENT_DIR wins, otherwise ~/.pi/agent", () => {
  // The env override is what the factory passes for a sandboxed agent dir;
  // without it the guide reads the real user home, so only assert that a
  // settings file under the env dir is honoured (never the reverse).
  withSandboxAgentDir((agentDir) => {
    writeSettings(agentDir, { artifactsPrompt: false });
    const pi = makePi();
    artifacts(pi);
    assert.equal("artifacts" in callBeforeAgentStart(pi).event.systemPromptOptions.sections, false);
  });
});

test("the bridge alone no longer injects the artifacts section", () => {
  withSandboxAgentDir(() => {
    const pi = makePi();
    bridge(pi);
    assert.equal(pi.handlers.has("on:before_agent_start"), false, "the bridge registers no before_agent_start handler");
  });
});

test("bridge and artifacts loaded together set the section exactly once", () => {
  withSandboxAgentDir(() => {
    const pi = makePi();
    bridge(pi);
    artifacts(pi);
    // The bridge registers commands, not prompt handlers: after both load
    // there is exactly one before_agent_start listener and it is the guide.
    assert.equal(pi.handlers.has("on:before_agent_start"), true);
    const run = callBeforeAgentStart(pi);
    const sections = Object.keys(run.event.systemPromptOptions.sections);
    assert.deepEqual(sections.filter((name) => name === "artifacts"), ["artifacts"]);
    assert.match(String(run.event.systemPromptOptions.sections.artifacts), /:::artifact/);
  });
});

test("the factory loads the artifacts asset for every session kind, beside the bridge", async () => {
  // The factory's spawn args are what makes the split real: every child that
  // loads the bridge must load the artifacts guide too (normal, chat-only
  // pin, chat workspace), or the artifacts switch silently loses a session
  // kind — the scope reduction the move must not introduce.
  const { readFile } = await import("node:fs/promises");
  const factory = await readFile(new URL("./factory.ts", import.meta.url), "utf8");
  assert.match(factory, /resolveArtifactsExtensionPath\(\)/);
  assert.match(factory, /"--extension", resolveBridgeExtensionPath\(\)/);
  // Both pushes sit on the unconditional path (outside the chatWorkspace and
  // chatOnlyExactPrompt branches), one right after the other.
  const unconditional = factory.indexOf('args.push("--extension", resolveBridgeExtensionPath());');
  const artifactsPush = factory.indexOf('args.push("--extension", resolveArtifactsExtensionPath());');
  assert.ok(unconditional >= 0, "the bridge extension is pushed unconditionally");
  assert.ok(artifactsPush > unconditional, "the artifacts asset is pushed right after the bridge");
});
