/**
 * A "handled" prompt (an extension command) starts no run, so its prompt_done
 * settles the turn — but the command may inject an agent run of its own that
 * starts AFTER that acknowledgement. The hook must then work normally: pick up
 * the delayed agent_start, keep the stream, and complete at agent_settled.
 *
 * These assertions pin the guards that make that work rather than any new
 * behaviour: `prompt_done` never settles a stage an injected run already owns,
 * `agent_start` cancels the event-stream grace, and `agent_settled` performs
 * the single completion (onAgentEnd) once. No timers are guessed at — the
 * events are driven in the order the server streams them.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile(
  "useAgentSession.ts",
  readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
);

function findHandler(node, name) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
    return node.initializer.arguments[0];
  }
  return ts.forEachChild(node, (child) => findHandler(child, name));
}

const handleAgentEvent = new Script(ts.transpileModule(
  findHandler(source, "handleAgentEvent").getText(source),
  { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
).outputText);

/** Drive handleAgentEvent over recorded refs and stage transitions. */
function harness({ sdkAgentActive = false, promptPending = true } = {}) {
  const calls = { settledStages: 0, agentEnd: 0, streamClosed: 0, graceCancelled: 0, loads: [] };
  const stage = { running: false };
  const refs = {
    sessionIdRef: { current: "s1" },
    sdkAgentActiveRef: { current: sdkAgentActive },
    agentRunningRef: { current: stage.running },
    rpcPromptPendingRef: { current: promptPending },
    promptPreparingRef: { current: null },
    promptRunIdRef: { current: 1 },
    optimisticUserMessageKeyRef: { current: null },
    sessionGenerationRef: { current: 0 },
  };
  const handler = handleAgentEvent.runInNewContext({
    ...refs,
    dispatch() {},
    cancelEventStreamGrace() { calls.graceCancelled += 1; },
    setForceStopTarget() {},
    setAgentRunning(value) { stage.running = value; },
    setPromptPreparing() {},
    setAgentPhase() {},
    setRetryInfo() {},
    setIsCompacting() {},
    setQueuedMessages() {},
    setContextUsage() {}, setSystemPrompt() {}, setExtensionStatuses() {}, setExtensionWidgets() {},
    setLiveModel() {}, setLiveThinkingLevel() {},
    setSummarizationRetry() {}, setPendingBash() {}, setExtensionDialog() {}, setActiveToolResults() {},
    syncLiveModel() {},
    settleUiStage() {
      calls.settledStages += 1;
      const wasRunning = stage.running;
      stage.running = false;
      return wasRunning;
    },
    notifyPromptStage() { return false; },
    scheduleEventStreamClose() { calls.streamClosed += 1; },
    loadSession(sid) { calls.loads.push(sid); },
    onAgentEnd() { calls.agentEnd += 1; },
    addNotice() {},
    scrollToBottom() {},
    handleExtensionUiRequest() {},
    handleForkAgentEvent() {},
    normalizeQueuedMessages: (value) => value,
    readCompactResult: (result, reason) => ({ reason, result }),
    asConcreteThinkingLevel: (value) => value,
    PENDING_BASH_OUTPUT_CAP: 100,
    // agent_end refreshes the state once; the answer is irrelevant here.
    fetch: () => Promise.resolve({ json: async () => ({ state: {} }) }),
    Date, console, window: undefined, document: undefined,
  });
  return { handler, refs, stage, calls };
}

test("handled prompt: the delayed injected run is picked up and completes at agent_settled", () => {
  const { handler, refs, stage, calls } = harness();

  // 1. The extension command's acknowledgement: nothing is running, so the
  //    turn settles and the stream close is only scheduled (grace, not yet up).
  handler({ type: "prompt_done" });
  assert.equal(refs.rpcPromptPendingRef.current, false, "the prompt is no longer pending");
  assert.equal(calls.settledStages, 1, "a handled prompt with no run settles at once");
  assert.equal(calls.streamClosed, 1, "the stream closes on a grace timer, not immediately");
  assert.equal(refs.sdkAgentActiveRef.current, false);

  // 2. The command's injected run starts later: the hook must go running and
  //    cancel the pending close, or the run streams into a dead connection.
  handler({ type: "agent_start" });
  assert.equal(refs.sdkAgentActiveRef.current, true, "the run is tracked as active");
  assert.equal(stage.running, true, "the UI is running");
  assert.equal(calls.graceCancelled, 1, "the scheduled stream close is cancelled");

  // 3. The run ends: exactly one completion, and the stage settles.
  handler({ type: "agent_end" });
  handler({ type: "agent_settled" });
  assert.equal(refs.sdkAgentActiveRef.current, false);
  assert.equal(stage.running, false);
  assert.equal(calls.settledStages, 2, "the real run settled its own stage");
  assert.equal(calls.agentEnd, 1, "one completion notification for the injected run");
  assert.equal(calls.streamClosed, 2);
});

test("handled prompt: a run that started before prompt_done keeps its stage", () => {
  const { handler, refs, stage, calls } = harness({ sdkAgentActive: false });
  // The extension started its run before the command's acknowledgement.
  handler({ type: "agent_start" });
  assert.equal(stage.running, true);
  // prompt_done must not settle (nor close) that live stage.
  handler({ type: "prompt_done" });
  assert.equal(refs.rpcPromptPendingRef.current, false);
  assert.equal(calls.settledStages, 0, "a started run keeps the stage prompt_done would have settled");
  assert.equal(calls.streamClosed, 0, "and keeps the stream");
  assert.equal(refs.sdkAgentActiveRef.current, true);

  handler({ type: "agent_settled" });
  assert.equal(refs.sdkAgentActiveRef.current, false);
  assert.equal(calls.settledStages, 1, "the run's own settle is the single transition");
  assert.equal(calls.agentEnd, 1);
  assert.equal(stage.running, false);
});
