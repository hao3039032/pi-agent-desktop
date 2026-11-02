import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createJiti } from 'jiti';
import ts from 'typescript';

const jiti = createJiti(import.meta.url, { interopDefault: true });
const ipc = await jiti.import('../static-frontend/src/ipc/client.ts');
const staticAgent = await jiti.import('../static-frontend/src/data/agent-client.ts');
const staticView = await jiti.import('../static-frontend/src/data/session-view-service.ts');
const nextAgent = await jiti.import('../lib/agent-client.ts');
const nextView = await jiti.import('../lib/session-view-service.ts');
const source = readFileSync(new URL('./useSessionAutomation.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

// Execute the actual hook with a minimal render/effect harness; transport modules are real.
function harness(agent, view) {
  const slots = []; let cursor = 0, cleanup;
  const react = {
    useCallback: fn => fn,
    useRef: value => { const i = cursor++; return slots[i] ??= { current: value }; },
    useEffect: fn => { const i = cursor++; if (!slots[i]) { slots[i] = true; cleanup = fn(); } },
  };
  const exports = {};
  runInNewContext(compiled, { exports, require: name => name === 'react' ? react : name === '@/lib/agent-client' ? agent : name === '@/lib/session-view-service' ? view : createRequire(import.meta.url)(name), console: { error() {} } });
  const sessionIdRef = { current: 'A' }, notices = [], synced = [];
  let automation = { autoCompactionEnabled: null, autoRetryEnabled: null, steeringMode: null, followUpMode: null };
  const options = { sessionIdRef, setAutomation: update => { automation = update(automation); }, addNotice: n => notices.push(n), resync: state => { synced.push(state); } };
  const render = () => { cursor = 0; return exports.useSessionAutomationActions(options); };
  return { render, sessionIdRef, notices, synced, get automation() { return automation; }, unmount: () => cleanup?.() };
}

test('static failed write reconciles via sessions.state IPC, never HTTP', async () => {
  const vite = readFileSync(new URL('../static-frontend/vite.config.ts', import.meta.url), 'utf8');
  assert.match(vite, /find: \/\^@\\\/lib\\\/session-view-service\$\/[\s\S]*?src\/data\/session-view-service\.ts/);
  const mock = new ipc.MockTransport(), commands = [], reads = [];
  mock.on('agent.command', args => { commands.push(args); throw new Error('write failed'); });
  mock.on('sessions.state', args => { reads.push(args); return { running: true, state: { autoCompactionEnabled: false } }; });
  staticAgent.bindAgentClient(mock); staticView.bindSessionViewService(new ipc.IpcClient(mock));
  const oldFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('unexpected HTTP'); };
  try {
    const h = harness(staticAgent, staticView);
    await h.render().handleSetAutomation({ autoCompaction: true });
    assert.equal(commands.length, 1); assert.equal(commands[0].type, 'set_auto_compaction');
    assert.deepEqual(reads, [{ session: 'A' }]);
    assert.deepEqual(h.synced, [{ autoCompactionEnabled: false }]);
    assert.equal(h.automation.autoRetryEnabled, null);
  } finally { globalThis.fetch = oldFetch; }
});

test('Next failed write retains HTTP command and state endpoints', async () => {
  const requests = [], oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    requests.push([url, options]);
    return options?.method === 'POST' ? { ok: false, status: 500, json: async () => ({ error: 'failed' }) } : { ok: true, json: async () => ({ running: true, state: { autoRetryEnabled: false } }) };
  };
  try {
    const h = harness(nextAgent, nextView); h.sessionIdRef.current = 'A /';
    await h.render().handleSetAutomation({ autoRetry: true });
    assert.equal(requests.length, 2); assert.equal(requests[0][0], '/api/agent/A%20%2F');
    assert.equal(JSON.parse(requests[0][1].body).type, 'set_auto_retry');
    assert.equal(requests[1][0], '/api/agent/A%20%2F');
    assert.deepEqual(h.synced, [{ autoRetryEnabled: false }]);
  } finally { globalThis.fetch = oldFetch; }
});

test('a write rejected after switching does not notify or read the old session', async () => {
  const write = deferred(), reads = [];
  const h = harness({ sendAgentCommand: () => write.promise }, { fetchAgentRunningState: sid => reads.push(sid) });
  const pending = h.render().handleSetAutomation({ autoRetry: true });
  h.sessionIdRef.current = 'B'; h.render();
  write.reject(new Error('failed')); await pending;
  assert.equal(h.notices.length, 0); assert.equal(reads.length, 0);
});

for (const transition of ['switch', 'return', 'unmount']) {
  test(`late failed-write state cannot cross ${transition}`, async () => {
    const read = deferred(), started = deferred();
    const agent = { sendAgentCommand: async () => { throw new Error('failed'); } };
    const view = { fetchAgentRunningState: () => { started.resolve(); return read.promise; } };
    const h = harness(agent, view); const pending = h.render().handleSetAutomation({ autoCompaction: true });
    await started.promise;
    if (transition === 'unmount') h.unmount();
    else { h.sessionIdRef.current = 'B'; h.render(); if (transition === 'return') { h.sessionIdRef.current = 'A'; h.render(); } }
    read.resolve({ state: { autoCompactionEnabled: false } }); await pending;
    assert.equal(h.synced.length, 0);
  });
}
