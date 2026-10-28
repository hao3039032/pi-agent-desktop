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
    console: { error() {} },
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
function composer() {
  const gate = deferred(), sent = [], drafts = new Map([['A','hello'], ['B','new unsent draft']]);
  const env = {
    value: 'hello', valueRef: ref('hello'), attachedImages: [], attachedImagesRef: ref(null), attachedFilesRef: ref([]),
    isStreaming: false, workspaceUnavailable: null, onAudioUnlock() {}, runBuiltinCommand: async () => false,
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
