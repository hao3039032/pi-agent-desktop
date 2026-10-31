import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const sourceText = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("useAgentSession.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
// The summary itself lives in the fork-owned hook; useAgentSession only consumes it.
const branchSummaryText = readFileSync(new URL("./useBranchSummary.ts", import.meta.url), "utf8");
const branchSummarySource = ts.createSourceFile("useBranchSummary.ts", branchSummaryText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function find(node, match) {
  if (match(node)) return node;
  return ts.forEachChild(node, (child) => find(child, match));
}

function compile(text) {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText.trim().replace(/;$/, "");
}

const helperNode = find(branchSummarySource, (n) => ts.isFunctionDeclaration(n) && n.name?.text === "branchSummaryHolds");
const leafChangeNode = find(source, (n) => ts.isVariableDeclaration(n) && n.name.getText(source) === "handleLeafChange");
assert.ok(helperNode, "branchSummaryHolds not found");
assert.ok(leafChangeNode, "handleLeafChange not found");

const helperJs = compile(helperNode.getText(branchSummarySource).replace(/^export /, ""));
const branchSummaryHolds = new Script(`${helperJs}; branchSummaryHolds`).runInNewContext({});

function leafChangeHarness({ pendingSummarySessionId, currentSessionId, commandResult }) {
  const calls = { activeLeaf: [], summarize: [], loadContext: [], commands: [], loads: [], notices: [] };
  const context = {
    branchSummaryHolds,
    bashRunningRef: { current: false },
    agentRunningRef: { current: false },
    isCompacting: false,
    branchSummarySessionIdRef: { current: pendingSummarySessionId },
    sessionIdRef: { current: currentSessionId },
    sessionGenerationRef: { current: 1 },
    branchNavigationRef: { current: null },
    sessionReadIdRef: { current: 0 },
    summarizeAndNavigate: async (leafId) => { calls.summarize.push(leafId); },
    setActiveLeafId: (leafId) => { calls.activeLeaf.push(leafId); },
    invalidateSessionData: () => {},
    loadContext: async (sid, leafId) => { calls.loadContext.push([sid, leafId]); return false; },
    sendAgentCommand: async (sid, command) => { calls.commands.push([sid, command]); if (commandResult instanceof Error) throw commandResult; return commandResult ?? { cancelled: false }; },
    loadSession: async (sid) => { calls.loads.push(sid); },
    addNotice: (notice) => { calls.notices.push(notice); },
    t: (key) => key,
  };
  const handlerJs = compile(leafChangeNode.initializer.arguments[0].getText(source));
  const handleLeafChange = new Script(`(${handlerJs})`).runInNewContext(context);
  return { handleLeafChange, calls };
}

test("a branch summary holds only the session it is summarizing", () => {
  assert.equal(branchSummaryHolds(null, null), false);
  assert.equal(branchSummaryHolds(null, "a"), false);
  assert.equal(branchSummaryHolds("a", "a"), true);
  assert.equal(branchSummaryHolds("a", "b"), false);
  assert.equal(branchSummaryHolds("a", null), false);
});

test("a summary still running for the previous session does not lock branch switches in the next", async () => {
  const { handleLeafChange, calls } = leafChangeHarness({ pendingSummarySessionId: "a", currentSessionId: "b" });
  await handleLeafChange("leaf-1");
  assert.deepEqual(calls.activeLeaf, []);
  assert.equal(calls.commands.length, 1);
  assert.equal(calls.commands[0][0], "b");
  assert.equal(calls.commands[0][1].targetId, "leaf-1");
  assert.deepEqual(calls.loads, ["b"]);
});

test("a cancelled or uncertain navigation never optimistically switches the view", async () => {
  const cancelled = leafChangeHarness({ currentSessionId: "a", commandResult: { cancelled: true } });
  await cancelled.handleLeafChange("leaf-1");
  assert.deepEqual(cancelled.calls.activeLeaf, []);
  assert.deepEqual(cancelled.calls.loads, []);
  const failed = leafChangeHarness({ currentSessionId: "a", commandResult: new Error("outcome unknown") });
  await failed.handleLeafChange("leaf-1");
  assert.deepEqual(failed.calls.activeLeaf, []);
  assert.deepEqual(failed.calls.loads, ["a"]);
  assert.equal(failed.calls.notices.length, 1);
  assert.equal(failed.calls.commands.length, 1, "unknown outcomes are not retried");
});

test("a summary running for the current session still locks its branch switches", async () => {
  const { handleLeafChange, calls } = leafChangeHarness({ pendingSummarySessionId: "a", currentSessionId: "a" });
  await handleLeafChange("leaf-1");
  await handleLeafChange("leaf-2", { summarize: true });
  assert.deepEqual(calls.activeLeaf, []);
  assert.deepEqual(calls.summarize, []);
});

test("send, branch switch and the lock banner all scope the summary to the current session", () => {
  const sendSource = sourceText.slice(
    sourceText.indexOf("  const handleSend = useCallback"),
    sourceText.indexOf("  const executeBash = useCallback"),
  );
  assert.match(sendSource, /if \(agentRunningRef\.current \|\| bashRunningRef\.current \|\| branchSummaryHolds\(branchSummarySessionIdRef\.current, sessionIdRef\.current\)\) \{/);
  assert.match(branchSummaryText, /const branchSummaryPending = branchSummaryHolds\(branchSummarySessionId, sessionId\);/);
  assert.match(sourceText, /useBranchSummary\(\{\s*sessionId: session\?\.id \?\? null,/);
  // No run/busy guard may test the bare ref: it still holds the previous session's id after a switch.
  // (summarizeAndNavigate's own `!sid || branchSummarySessionIdRef.current` keeps summaries single-flight.)
  for (const text of [sourceText, branchSummaryText]) {
    assert.doesNotMatch(text, /(?:Ref\.current|isCompacting) \|\| branchSummarySessionIdRef\.current\)/);
  }
});
