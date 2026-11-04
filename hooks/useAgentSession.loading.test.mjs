import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { readSessionResponse } from '../lib/session-load.ts';

// Run the actual hook callback, including its guards/timer/single-flight policy.
const source = readFileSync(new URL('./useAgentSession.ts', import.meta.url), 'utf8');
const callback = source.slice(source.indexOf('  const loadSession = useCallback'), source.indexOf('  const loadContext = useCallback'));
const deferred = () => Promise.withResolvers();
function harness({ cached = false } = {}) {
  const state = { loading: !cached, data: cached ? { sessionId: 'A' } : null, messages: cached ? ['history'] : [], error: null, phase: 'ready', stale: cached };
  const requests = [], timers = new Map(); let timerId = 0;
  const ref = (current) => ({ current });
  const env = {
    AbortController, URLSearchParams, Map, console,
    useCallback: fn => fn,
    loadFlightsRef: ref(new Map()), sessionReadAbortRef: ref(null), sessionLoadIdRef: ref(0),
    sessionGenerationRef: ref(0), sessionIdRef: ref('A'), sessionHookMountedRef: ref(true), promptRunIdRef: ref(0),
    dataRef: ref(state.data), messagesRef: ref(state.messages), entryIdsRef: ref([]),
    modelSwitchPendingRef: ref(false), sessionToolsPinnedRef: ref(false),
    chatWorkspace: false, CONFIGURED_TOOL_PRESET: 'configured',
    SESSION_READ_TIMEOUT_MS: 65000, SESSION_READ_SLOW_MS: 8000, readSessionResponse,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    fetchWithRetry(url, options) { const d = deferred(); requests.push({ ...d, url, options }); return d.promise; },
    setLoading(value) { state.loading = value; }, setError(value) { state.error = value; },
    setSessionLoadPhase(value) { state.phase = typeof value === 'function' ? value(state.phase) : value; },
    setSessionViewStale(value) { state.stale = value; },
    setData(value) { state.data = value; env.dataRef.current = value; },
    setMessages(value) { state.messages = value; env.messagesRef.current = value; },
    getSessionViewSnapshot: () => null, deleteSessionViewSnapshot() {}, setSessionViewSnapshot() {},
    setActiveLeafId() {}, setEntryIds() {}, setHistoryCursor() {}, setHasEarlierMessages() {},
    setCurrentModelOverride() {}, setCurrentThinkingOverride() {}, setToolPresetState() {},
    syncLiveModel() {}, seedStreamingSnapshot() {},
  };
  const context = vm.createContext(env);
  vm.runInContext(stripTypeScriptTypes(`${callback}\nglobalThis.load = loadSession;`), context);
  const success = (index = requests.length - 1) => requests[index].resolve({ res: { ok: true, status: 200 }, payload: {
    sessionId: env.sessionIdRef.current, context: { messages: ['fresh'], entryIds: ['e1'], hasMore: false, thinkingLevel: 'off' }, leafId: 'e1',
  } });
  return { state, requests, timers, env, load: context.load, success };
}

test('cold open progresses to slow/retrying then friendly failure; manual retry clears failure immediately', async () => {
  const h = harness();
  const load = h.load('A', true);
  assert.equal(h.state.phase, 'opening');
  for (const fn of h.timers.values()) fn();
  assert.equal(h.state.phase, 'slow');
  h.requests[0].options.onRetry();
  assert.equal(h.state.phase, 'retrying');
  h.requests[0].reject(new Error('Request timed out after 65000ms'));
  assert.equal(await load, 'error');
  assert.equal(h.state.phase, 'failed');
  assert.equal(h.state.loading, false);
  assert.equal(h.timers.size, 0);
  const retry = h.load('A', true);
  assert.equal(h.state.error, null);
  assert.equal(h.state.phase, 'opening');
  assert.equal(h.state.loading, true);
  h.success(); await retry;
  assert.equal(h.state.phase, 'ready');
  assert.equal(h.state.loading, false);
  assert.equal(h.state.stale, false);
});

test('cached content survives a failed background refresh and remains visible during retry', async () => {
  const h = harness({ cached: true });
  const original = h.state.data, messages = h.state.messages;
  const load = h.load('A');
  h.requests[0].reject(new Error('offline'));
  await load;
  assert.equal(h.state.data, original);
  assert.equal(h.state.messages, messages);
  assert.equal(h.state.loading, false);
  assert.equal(h.state.stale, true);
  const retry = h.load('A', true);
  assert.equal(h.state.loading, false);
  assert.equal(h.state.messages, messages);
  h.success(); await retry;
  assert.deepEqual(h.state.messages, ['fresh']);
  assert.equal(h.state.stale, false);
});

test('opening forced read and a concurrent background refresh share a single request', async () => {
  const h = harness();
  const a = h.load('A', true, false, { force: true });
  const b = h.load('A');
  assert.equal(h.requests.length, 1);
  h.success(); await Promise.all([a, b]);
  assert.equal(h.env.loadFlightsRef.current.size, 0);
});

test('new forced load cancels old read and stale success cannot overwrite it', async () => {
  const h = harness();
  const old = h.load('A', true);
  const fresh = h.load('A', true, false, { force: true });
  assert.equal(h.requests[0].options.init.signal.aborted, true);
  h.success(1); await fresh;
  h.requests[0].reject(new Error('old timeout')); await old;
  assert.equal(h.state.error, null);
  assert.equal(h.state.phase, 'ready');
});

test('A → B → A and unmount ignore old timers, failures and retries', async () => {
  for (const unmounted of [false, true]) {
    const h = harness();
    const load = h.load('A', true);
    if (unmounted) h.env.sessionHookMountedRef.current = false;
    else h.env.sessionGenerationRef.current += 2;
    assert.equal(h.requests[0].options.shouldRetry(), false);
    for (const fn of h.timers.values()) fn();
    h.requests[0].options.onRetry();
    h.requests[0].reject(new Error('late timeout'));
    await load;
    assert.equal(h.state.error, null);
    assert.equal(h.state.phase, 'opening');
    assert.equal(h.timers.size, 0);
  }
});

test('a new prompt keeps its optimistic messages instead of applying an older history read', async () => {
  const h = harness();
  const load = h.load('A', true);
  h.env.promptRunIdRef.current++;
  h.state.messages = ['optimistic'];
  h.success(); await load;
  assert.deepEqual(h.state.messages, ['optimistic']);
});
