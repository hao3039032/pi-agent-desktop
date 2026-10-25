import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
const source = ts.createSourceFile('hook.tsx', readFileSync(new URL('./useAgentSession.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function compile(name) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  return new Script(ts.transpileModule(find(source).getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);
}
const abortScript = compile('handleAbort');
const eventScript = compile('handleAgentEvent');
class AgentCommandError extends Error { constructor(message) { super(message); this.instanceId = 'instance-1'; } }
function harness() {
  const state = { pending: false, notices: [], forced: null, sends: 0, settled: 0, reconciles: 0 };
  const globals = {
    sessionIdRef: { current: 's1' }, sessionGenerationRef: { current: 1 }, stopRequestRef: { current: null }, bashRunningRef: { current: false },
    sdkAgentActiveRef: { current: true }, rpcPromptPendingRef: { current: true }, optimisticUserMessageKeyRef: { current: 'message' },
    setStopPending(v) { state.pending = v; }, setForceStopTarget(v) { state.forced = v; },
    setBashRunning() {}, setPendingBash() {}, setIsCompacting() {}, setSummarizationRetry() {},
    settleUiStage() { state.settled++; }, loadSession() {}, closeEvents() { state.closed = true; },
    setContextUsage(v) { state.usage = v; },
    addNotice(v) { state.notices.push(v); }, t: (key, args) => key + JSON.stringify(args ?? {}),
    reconcileAgentState() { state.reconciles++; },
    AbortSignal, AgentCommandError,
    sendAgentCommand() { state.sends++; return new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; }); },
  };
  return { state, globals, abort: abortScript.runInNewContext(globals), event: eventScript.runInNewContext(globals) };
}
test('Stop is visibly pending, deduplicated, and failure offers an instance-bound confirmation', async () => {
  const h = harness();
  const pending = h.abort();
  assert.equal(h.state.pending, true);
  await h.abort();
  assert.equal(h.state.sends, 1);
  h.state.reject(new AgentCommandError('timeout'));
  await pending;
  assert.equal(h.state.pending, false);
  assert.match(h.state.notices[0].message, /stopFailed.*timeout/);
  assert.equal(h.state.forced.instanceId, 'instance-1');
});
test('late Stop failure after switching away and back cannot touch current UI', async () => {
  const h = harness();
  const pending = h.abort();
  h.globals.sessionGenerationRef.current += 2;
  h.state.reject(new AgentCommandError('timeout'));
  await pending;
  assert.equal(h.state.notices.length, 0);
  assert.equal(h.state.forced, null);
});
test('a CLI exit clears the active run and pending Stop, without a success notification', async () => {
  const h = harness();
  const pending = h.abort();
  h.event({ type: 'session_process_exit', code: 3 });
  assert.equal(h.globals.sdkAgentActiveRef.current, false);
  assert.equal(h.globals.rpcPromptPendingRef.current, false);
  assert.equal(h.state.pending, false);
  assert.equal(h.state.settled, 1);
  assert.match(h.state.notices[0].message, /processExited.*3/);
  h.state.reject(new AgentCommandError('closed'));
  await pending;
  assert.equal(h.state.notices.length, 1);
  assert.equal(h.state.forced, null);
});
test('context usage refresh clears stale percentage and accepts CLI unknown values', () => {
  const h = harness();
  const unknown = { tokens: null, percent: null, contextWindow: 200000 };
  h.event({ type: 'context_usage', contextUsage: unknown });
  assert.equal(h.state.usage, unknown);
  h.event({ type: 'context_usage', contextUsage: null });
  assert.equal(h.state.usage, null);
});
