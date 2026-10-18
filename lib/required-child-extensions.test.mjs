import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { registerSecurityChildExtensions, unregisterSecurityChildExtensions } =
  await createJiti(import.meta.url).import("./required-child-extensions.ts");

const LOG_KEY = Symbol.for("pi-web.test.required-child-extensions.log");

/**
 * A stand-in pi-subagents package: its `registerRequiredChildExtensions`
 * records calls on globalThis and, like the real one, refuses a second
 * registration for a session that was not disposed.
 */
function makeFakePiSubagents(agentDir, { delayMs = 0 } = {}) {
  const dir = path.join(agentDir, "npm", "node_modules", "pi-subagents");
  mkdirSync(path.join(dir, "src", "api"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pi-subagents", type: "module" }));
  writeFileSync(path.join(dir, "src", "api", "required-child-extensions.js"), `
const key = Symbol.for("pi-web.test.required-child-extensions.log");
const log = (globalThis[key] ??= { live: new Map(), calls: [] });
${delayMs ? `await new Promise((resolve) => setTimeout(resolve, ${delayMs}));` : ""}
export function registerRequiredChildExtensions({ sessionId, extensions }) {
  if (log.live.has(sessionId)) throw new Error("already registered: " + sessionId);
  log.live.set(sessionId, extensions);
  log.calls.push(["register", sessionId, extensions.map(({ id }) => id)]);
  return { dispose() { log.live.delete(sessionId); log.calls.push(["dispose", sessionId]); } };
}
`);
  return dir;
}

function makeSecurityPackage(agentDir, name) {
  const dir = path.join(agentDir, "npm", "node_modules", ...name.split("/"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, pi: { extensions: ["./src/index.ts"] } }));
  writeFileSync(path.join(dir, "src", "index.ts"), "export default () => {};\n");
}

function makeAgentDir({ packages, delayMs } = {}) {
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-web-required-"));
  makeSecurityPackage(agentDir, "@gotgenes/pi-permission-system");
  makeSecurityPackage(agentDir, "@erichll/pi-auto-review");
  makeFakePiSubagents(agentDir, { delayMs });
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: packages ?? [
      "npm:pi-subagents",
      "npm:@gotgenes/pi-permission-system",
      "npm:@erichll/pi-auto-review",
    ],
  }));
  return agentDir;
}

function fakeLog() {
  return (globalThis[LOG_KEY] ??= { live: new Map(), calls: [] });
}

test("registers the gate and reviewer for a session's pi-subagents children, then disposes them", async () => {
  const agentDir = makeAgentDir();
  const sessionId = `s-${process.hrtime.bigint()}`;
  try {
    await registerSecurityChildExtensions(sessionId, agentDir);
    assert.deepEqual(
      fakeLog().calls.filter(([, id]) => id === sessionId),
      [["register", sessionId, ["gotgenes-pi-permission-system", "erichll-pi-auto-review"]]],
    );

    // A second register for the same id (a replaced wrapper) disposes first
    // instead of tripping the package's one-registration-per-session rule.
    await registerSecurityChildExtensions(sessionId, agentDir);
    assert.equal(fakeLog().live.has(sessionId), true);

    unregisterSecurityChildExtensions(sessionId);
    assert.equal(fakeLog().live.has(sessionId), false);
    unregisterSecurityChildExtensions(sessionId); // idempotent
  } finally {
    unregisterSecurityChildExtensions(sessionId);
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a session destroyed while the module import is pending registers nothing", async () => {
  const agentDir = makeAgentDir({ delayMs: 50 });
  const sessionId = `s-${process.hrtime.bigint()}`;
  try {
    const pending = registerSecurityChildExtensions(sessionId, agentDir);
    unregisterSecurityChildExtensions(sessionId);
    await pending;
    assert.equal(fakeLog().live.has(sessionId), false);
  } finally {
    unregisterSecurityChildExtensions(sessionId);
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("nothing is registered without pi-subagents or without the gate", async () => {
  for (const packages of [
    ["npm:@gotgenes/pi-permission-system", "npm:@erichll/pi-auto-review"],
    ["npm:pi-subagents", "npm:@erichll/pi-auto-review"],
  ]) {
    const agentDir = makeAgentDir({ packages });
    const sessionId = `s-${process.hrtime.bigint()}`;
    try {
      await registerSecurityChildExtensions(sessionId, agentDir);
      assert.equal(fakeLog().live.has(sessionId), false, JSON.stringify(packages));
    } finally {
      unregisterSecurityChildExtensions(sessionId);
      rmSync(agentDir, { recursive: true, force: true });
    }
  }
});
