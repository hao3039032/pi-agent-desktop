import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';

const hook = ts.createSourceFile('hook.ts', readFileSync(new URL('./useAgentSession.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const input = ts.createSourceFile('input.tsx', readFileSync(new URL('../components/ChatInput.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(source, name, env) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(found, name);
  return new Script(ts.transpileModule(`(${found.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText).runInNewContext(env);
}
const ref = current => ({ current });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness() {
  const sent = [], restored = [], notices = [];
  const env = {
    console: { error() {} }, promptPreparingRef: ref(null), setPromptPreparing() {}, pendingPromptSubmissionRef: ref(null),
    AbortSignal, DOMException, PROMPT_ADMISSION_TIMEOUT_MS: 130_000, t: key => key, stopRequestRef: ref(null),
    setStopPending() {}, setForceStopTarget() {}, settleUiStage() { env.agentRunningRef.current = false; },
    waitForPromptSettlement() {},
    sessionHookMountedRef: ref(true), sessionGenerationRef: ref(1), submissionGeneration: 1, sessionIdRef: ref('A'),
    agentRunningRef: ref(false), bashRunningRef: ref(false), branchSummarySessionIdRef: ref(null), branchSummaryHolds: () => false,
    composerDraftKey: 'A', editEntryId: null, chatWorkspace: false,
    isNew: false, session: { id: 'A' }, newSessionCwd: null, newSessionModel: null,
    promptRunIdRef: ref(0), rpcPromptPendingRef: ref(false), optimisticUserMessageKeyRef: ref(null), pendingScrollToUserRef: ref(false),
    cancelEventStreamGrace() {}, setMessages() {}, userMessageKey: () => 'key', setAgentRunning() {}, setAgentPhase() {}, dispatch() {}, setPromptAnchorActive() {},
    restoreSubmission: (...args) => restored.push(args), addNotice: n => notices.push(n),
    ensureEventsConnected: async () => {}, sendAgentCommand: async (sid, body) => { sent.push({ sid, body }); },
    isPromptRejectedError: e => e.code === 'prompt_rejected', reconcileAgentState() {}, closeEvents() {},
  };
  env.isCurrentSubmission = callback(hook, 'isCurrentSubmission', env);
  env.abortSessionRuntime = callback(hook, 'abortSessionRuntime', env);
  return { env, sent, restored, notices };
}
function switchTo(env, sid) { env.sessionGenerationRef.current++; env.sessionIdRef.current = sid; }

test('normal submission is single-shot and has no steering behavior', async () => {
  const h = harness(); await callback(hook, 'handleSend', h.env)('normal');
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].sid, 'A');
  assert.equal(h.sent[0].body.streamingBehavior, undefined);
});
for (const action of ['handleSend', 'sendStreamingPrompt', 'handleFollowUp']) {
  for (const returnToA of [false, true]) {
    test(`${action}: retained callback cannot cross ${returnToA ? 'A-B-A' : 'A-B'}`, async () => {
      const h = harness(), run = callback(hook, action, h.env);
      switchTo(h.env, 'B'); if (returnToA) switchTo(h.env, 'A');
      await run('old', 'steer');
      assert.equal(h.sent.length, 0); assert.equal(h.restored[0][2], 'A');
    });
  }
}
test('SSE readiness resolving after a switch cannot dispatch the old prompt', async () => {
  const h = harness(), ready = deferred(); h.env.ensureEventsConnected = () => ready.promise;
  const pending = callback(hook, 'handleSend', h.env)('old');
  switchTo(h.env, 'B'); ready.resolve(); await pending;
  assert.equal(h.sent.length, 0); assert.equal(h.restored[0][2], 'A');
});
for (const action of ['handleSend', 'sendStreamingPrompt']) {
  for (const rejected of [true, false]) {
    test(`${action}: switched response ${rejected ? 'restores explicit rejection' : 'does not duplicate an ambiguous failure'}`, async () => {
      const h = harness(), reply = deferred(); h.env.sendAgentCommand = () => reply.promise;
      const pending = callback(hook, action, h.env)('recover', action === 'sendStreamingPrompt' ? 'steer' : undefined); await tick();
      switchTo(h.env, 'B');
      reply.reject(Object.assign(new Error('failure'), rejected ? { code: 'prompt_rejected', accepted: false } : {})); await pending;
      assert.equal(h.restored.length, rejected ? 1 : 0); assert.equal(h.notices.length, 0);
      if (rejected) assert.equal(h.restored[0][2], 'A');
    });
  }
}
for (const stage of ['SSE', 'creation', 'model']) {
  test(`Stop before ${stage} completes restores once and prevents the late prompt`, async () => {
    const h = harness(), ready = deferred(); let closes = 0;
    h.env.closeEvents = () => { closes++; };
    if (stage === 'SSE') h.env.ensureEventsConnected = () => ready.promise;
    if (stage === 'creation') Object.assign(h.env, {
      isNew: true, newSessionCwd: '/sandbox', sessionIdRef: ref(null), ensuringNewSessionRef: ref(null),
      ensureNewSession: () => ready.promise,
    });
    if (stage === 'model') Object.assign(h.env, {
      isNew: true, newSessionCwd: '/sandbox', newSessionModel: { provider:'test', modelId:'test' }, setPendingModel() {},
      sendAgentCommand: async (sid,body) => { h.sent.push({sid,body}); if (body.type === 'set_model') await ready.promise; },
    });
    const send = callback(hook, 'handleSend', h.env);
    const pending = send('cancel me'); await tick();
    await callback(hook, 'handleAbort', h.env)();
    assert.equal(h.env.promptPreparingRef.current, null);
    assert.equal(h.env.agentRunningRef.current, false);
    assert.equal(h.restored.length, 1); assert.equal(h.restored[0][0], 'cancel me');
    ready.resolve('new-A'); await pending;
    assert.equal(h.sent.filter(c => c.body.type === 'prompt' || c.body.type === 'abort').length, 0);
    assert.equal(h.restored.length, 1); assert.equal(closes, 0, 'warm connection is not closed');
  });
}
test('a cancelled first send cannot clear or dispatch a second send sharing readiness', async () => {
  const h = harness(), ready = deferred(); h.env.ensureEventsConnected = () => ready.promise;
  const send = callback(hook, 'handleSend', h.env);
  const first = send('first'); await callback(hook, 'handleAbort', h.env)();
  const second = send('second'); const secondRunId = h.env.promptPreparingRef.current;
  assert.notEqual(secondRunId, null);
  ready.resolve(); await Promise.all([first, second]);
  assert.deepEqual(h.sent.map(c => c.body.message), ['second']);
  assert.equal(h.restored.length, 1);
});
test('Stop after dispatch goes to the server and does not restore an uncertain message', async () => {
  const h = harness(), reply = deferred();
  h.env.sendAgentCommand = async (sid,body) => { h.sent.push({sid,body}); if (body.type === 'prompt') return reply.promise; };
  const pending = callback(hook, 'handleSend', h.env)('submitted'); await tick();
  await callback(hook, 'handleAbort', h.env)();
  assert.deepEqual(h.sent.map(c => c.body.type), ['prompt','abort']); assert.equal(h.restored.length, 0);
  reply.resolve(); await pending;
});
for (const newSession of [false, true]) {
  test(`admission deadline releases preparation without resending/restoring (${newSession ? 'new' : 'existing'})`, async () => {
    const h = harness(), deadline = new AbortController(); let timeoutMs, settlements = 0;
    h.env.AbortSignal = { timeout(ms) { timeoutMs = ms; return deadline.signal; } };
    h.env.waitForPromptSettlement = () => { settlements++; };
    h.env.sendAgentCommand = (sid,body,options) => {
      h.sent.push({sid,body});
      return new Promise((resolve,reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true}));
    };
    if (newSession) Object.assign(h.env, { isNew:true, newSessionCwd:'/sandbox', promoteNewSession() {} });
    const pending = callback(hook,'handleSend',h.env)('only once'); await tick();
    h.env.sdkAgentActiveRef = ref(true); // server may already be streaming while HTTP is lost
    deadline.abort(new DOMException('deadline', 'TimeoutError')); await pending;
    assert.equal(timeoutMs,130_000); assert.equal(h.env.promptPreparingRef.current,null);
    assert.equal(h.sent.length,1); assert.equal(h.restored.length,0); assert.equal(settlements,1);
    assert.equal(h.notices[0].message,'chat.promptAdmissionTimeout');
  });
}
for (const newSession of [false, true]) {
  for (const hasReason of [false, true]) {
    for (const aborted of [false, true]) {
      test(`legacy WebView admission: ${newSession ? 'new' : 'existing'}, ${aborted ? 'expired' : 'success'}, ${hasReason ? 'reason' : 'no reason'}`, async () => {
        const h = harness(), deadline = new AbortController(); let promotions = 0, settlements = 0;
        const reason = new DOMException('deadline', 'TimeoutError');
        const signal = deadline.signal;
        Object.defineProperty(signal, 'throwIfAborted', { value: undefined });
        if (!hasReason) Object.defineProperty(signal, 'reason', { value: undefined });
        h.env.AbortSignal = { timeout: ms => { assert.equal(ms, 130_000); return signal; } };
        h.env.waitForPromptSettlement = () => { settlements++; };
        h.env.sendAgentCommand = async (sid,body,options) => {
          h.sent.push({sid,body});
          assert.equal(options.signal, signal);
          // Simulate expiry while reading a successfully delivered response;
          // the post-await check must reject it even if fetch resolved normally.
          if (aborted) deadline.abort(reason);
        };
        if (newSession) Object.assign(h.env, {
          isNew: true, newSessionCwd: '/sandbox', promoteNewSession() { promotions++; },
        });
        await callback(hook, 'handleSend', h.env)('only once');
        assert.equal(h.sent.length, 1);
        assert.equal(h.restored.length, 0);
        assert.equal(h.env.promptPreparingRef.current, null);
        assert.equal(promotions, newSession && !aborted ? 1 : 0);
        assert.equal(settlements, aborted ? 1 : 0);
        assert.equal(h.notices.length, aborted ? 1 : 0);
        if (aborted) assert.equal(h.notices[0].message, 'chat.promptAdmissionTimeout');
      });
    }
  }
}
// Unlike the legacy instance-method cases above, this models an engine with
// no static timeout API at all. Drive the actual fallback timer deterministically.
for (const newSession of [false, true]) {
  for (const outcome of ['success', 'rejected', 'timeout', 'expired-response', 'switched-timeout']) {
    test(`missing AbortSignal.timeout fallback: ${newSession ? 'new' : 'existing'} ${outcome}`, async () => {
      const h = harness(), reply = deferred(), timers = new Map();
      let timerCallback, timeoutMs, signal, promotions = 0, settlements = 0, cleared = 0;
      Object.assign(h.env, {
        AbortSignal: {},
        AbortController: class extends AbortController {
          constructor() {
            super();
            Object.defineProperty(this.signal, 'throwIfAborted', { value: undefined });
            Object.defineProperty(this.signal, 'reason', { value: undefined });
          }
        },
        setTimeout(fn, ms) { timerCallback = fn; timeoutMs = ms; timers.set(1, fn); return 1; },
        clearTimeout(id) { assert.equal(id, 1); timers.delete(id); cleared++; },
        waitForPromptSettlement() { settlements++; },
        sendAgentCommand(sid, body, options) {
          h.sent.push({ sid, body }); signal = options.signal;
          if (outcome !== 'expired-response') {
            signal.addEventListener('abort', () => reply.reject(new DOMException('aborted', 'AbortError')), { once: true });
          }
          return reply.promise;
        },
      });
      if (newSession) Object.assign(h.env, { isNew: true, newSessionCwd: '/sandbox', promoteNewSession() { promotions++; } });
      const pending = callback(hook, 'handleSend', h.env)('only once'); await tick();
      assert.equal(h.sent.length, 1, 'missing static API must not reject before dispatch');
      assert.equal(timeoutMs, 130_000); assert.equal(timers.size, 1);
      assert.equal(signal.aborted, false);
      assert.equal(signal.throwIfAborted, undefined);
      if (outcome === 'success') reply.resolve();
      else if (outcome === 'rejected') reply.reject(Object.assign(new Error('explicit rejection'), { code: 'prompt_rejected', accepted: false }));
      else {
        if (outcome === 'switched-timeout') {
          switchTo(h.env, 'B');
          h.env.promptPreparingRef.current = 99;
        }
        timerCallback();
        assert.equal(signal.aborted, true);
        if (outcome === 'expired-response') reply.resolve();
      }
      await pending;
      assert.equal(timers.size, 0); assert.equal(cleared, 1, 'all completion paths dispose their timer');
      assert.equal(h.sent.length, 1, 'never resend');
      assert.equal(h.restored.length, outcome === 'rejected' ? 1 : 0);
      assert.equal(promotions, newSession && outcome === 'success' ? 1 : 0);
      assert.equal(settlements, ['timeout', 'expired-response'].includes(outcome) ? 1 : 0);
      assert.equal(h.env.promptPreparingRef.current, outcome === 'switched-timeout' ? 99 : null);
      if (['timeout', 'expired-response'].includes(outcome)) assert.equal(h.notices[0].message, 'chat.promptAdmissionTimeout');
      if (['success', 'switched-timeout'].includes(outcome)) assert.equal(h.notices.length, 0);
    });
  }
}

test('an old admission deadline cannot clear another prompt preparation', async () => {
  const h = harness(), deadline = new AbortController();
  h.env.AbortSignal = { timeout: () => deadline.signal };
  h.env.sendAgentCommand = (sid,body,options) => new Promise((resolve,reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true}));
  const pending = callback(hook,'handleSend',h.env)('old'); await tick();
  h.env.promptRunIdRef.current++; h.env.promptPreparingRef.current = h.env.promptRunIdRef.current;
  deadline.abort(new DOMException('deadline','TimeoutError')); await pending;
  assert.equal(h.env.promptPreparingRef.current,h.env.promptRunIdRef.current); assert.equal(h.notices.length,0); assert.equal(h.restored.length,0);
});

function composer() {
  const gate = deferred(), sent = [], drafts = new Map([['A','hello'], ['B','new unsent draft']]);
  const env = {
    value: 'hello', valueRef: ref('hello'), attachedImages: [], attachedImagesRef: ref(null), attachedFilesRef: ref([]),
    isStreaming: false, promptPreparing: false, workspaceUnavailable: null, onAudioUnlock() {}, runBuiltinCommand: async () => false,
    resolveSessionReferences: () => gate.promise, sessionMentionTargetsRef: ref(new Map()), composeMessageWithAttachedFiles: t => t,
    onSend: (...args) => sent.push(args), onSteer: (...args) => sent.push(args), onFollowUp: (...args) => sent.push(args), onBuiltinCommand: undefined,
    composerMountedRef: ref(true), composerScopeRef: ref({ key:'A', generation:0 }), composerGeneration: 0,
    draftKey: 'A', draftKeyRef: ref('A'), textareaRef: ref(null), setValue() {}, setAtQuery() {}, setHashQuery() {}, setHistoryMenuOpen() {}, clearImages() {}, clearAttachedFiles() {},
    clearDraft: key => drafts.delete(key),
  };
  env.attachedImagesRef.current = env.attachedImages;
  env.isCurrentComposer = callback(input, 'isCurrentComposer', env);
  env.clearInput = callback(input, 'clearInput', env);
  return { env, gate, sent, drafts };
}
for (const action of ['handleSend', 'sendQueued']) {
  for (const change of ['switch', 'A-B-A', 'unmount', 'edit']) {
    test(`composer ${action}: ${change} during reference resolution preserves drafts`, async () => {
      const h = composer(); const pending = callback(input, action, h.env)('steer'); await tick();
      if (change === 'unmount') h.env.composerMountedRef.current = false;
      else if (change === 'edit') h.env.valueRef.current = 'new edit';
      else {
        h.env.composerScopeRef.current = {key: change === 'switch' ? 'B' : 'A', generation: change === 'switch' ? 1 : 2};
        h.env.draftKeyRef.current = h.env.composerScopeRef.current.key;
      }
      h.gate.resolve('resolved'); await pending; await tick();
      assert.equal(h.sent.length, 0); assert.equal(h.drafts.get('B'), 'new unsent draft'); assert.equal(h.drafts.get('A'), 'hello');
    });
  }
}
test('composer clears before synchronous rejection recovery, exactly once', async () => {
  const h = composer(); h.env.onSend = () => h.drafts.set('A', 'restored');
  const pending = callback(input, 'handleSend', h.env)(); await tick(); h.gate.resolve('resolved'); await pending;
  assert.equal(h.drafts.get('A'), 'restored');
});
test('draft promotion does not invalidate a pending composer send', async () => {
  const h = composer(); const pending = callback(input, 'handleSend', h.env)(); await tick();
  h.env.composerScopeRef.current.key = 'real-A'; h.env.draftKeyRef.current = 'real-A';
  h.gate.resolve('resolved'); await pending; assert.equal(h.sent.length, 1);
});

test('new prompt stops after a delayed model change when its composer is left', async () => {
  const h = harness(), model = deferred(); let connected = 0;
  Object.assign(h.env, {
    isNew: true, newSessionCwd: '/sandbox', newSessionModel: {provider:'test',modelId:'test'},
    setPendingModel() {}, ensureEventsConnected: async () => { connected++; },
    sendAgentCommand: async (sid,body) => { h.sent.push({sid,body}); if(body.type === 'set_model') await model.promise; },
  });
  const pending = callback(hook,'handleSend',h.env)('new'); await tick();
  switchTo(h.env,'B'); model.resolve(); await pending;
  assert.equal(connected,0); assert.equal(h.sent.length,1); assert.equal(h.sent[0].body.type,'set_model');
});
test('leaving during shell readiness cannot run the command or clear B busy state', async () => {
  const h = harness(), ready = deferred();
  Object.assign(h.env,{ setPendingBash() {}, setBashRunning() {}, ensureEventsConnected: () => ready.promise });
  const pending = callback(hook,'executeBash',h.env)('echo test',false);
  switchTo(h.env,'B'); h.env.bashRunningRef.current = true;
  ready.resolve(); await pending;
  assert.equal(h.sent.length,0); assert.equal(h.env.bashRunningRef.current,true);
});
for (const mode of ['steer','followup']) {
  test(`normal ${mode} preserves images and sends once`, async () => {
    const h = composer(); const image = {data:'aGVsbG8=',mimeType:'image/png'};
    h.env.attachedImages = [image]; h.env.attachedImagesRef.current = h.env.attachedImages;
    await callback(input,'sendQueued',h.env)(mode); h.gate.resolve('resolved'); await tick();
    assert.equal(h.sent.length,1); assert.equal(h.sent[0][1][0],image);
  });
}

test('new runtime response cannot overwrite a switched session or clear a newer creation flight', async () => {
  const h = harness(), response = deferred();
  Object.assign(h.env, {
    isNew: true, newSessionCwd: '/sandbox', ensuringNewSessionRef: ref(null), sessionIdRef: ref(null),
    newSessionModelOverrideRef: ref(null), thinkingLevelOverrideRef: ref(null), sessionToolsPinnedRef: ref(false),
    toolPreset: 'configured', getToolNamesForPreset: () => undefined, fetch: () => response.promise,
  });
  const pending = callback(hook, 'ensureNewSession', h.env)();
  switchTo(h.env, 'B'); const newer = Promise.resolve('B'); h.env.ensuringNewSessionRef.current = newer;
  response.resolve({ ok:true, json:async () => ({sessionId:'late-A'}) });
  assert.equal(await pending, null); assert.equal(h.env.sessionIdRef.current, 'B');
  assert.equal(h.env.ensuringNewSessionRef.current, newer);
});
