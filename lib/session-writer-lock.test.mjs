import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { withSessionWriterLock } = await jiti.import('./session-writer-lock.ts');
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
const turn = () => new Promise(r => setImmediate(r));

test('replacement cannot open the file until old-child exit AND host append complete', async () => {
  const exited = deferred(), appended = deferred();
  const order = [];
  const change = withSessionWriterLock('one', async () => {
    order.push('shutdown'); await exited.promise; order.push('exit');
    await appended.promise; order.push('append');
  });
  const start = withSessionWriterLock('one', async () => { order.push('open'); });
  await turn();
  assert.deepEqual(order, ['shutdown']);
  exited.resolve(); await turn();
  assert.deepEqual(order, ['shutdown', 'exit']);
  appended.resolve(); await Promise.all([change, start]);
  assert.deepEqual(order, ['shutdown', 'exit', 'append', 'open']);
});

test('different sessions do not block one another; failed mutation releases ownership', async () => {
  const held = deferred();
  const failure = withSessionWriterLock('one', () => held.promise);
  const rejected = assert.rejects(failure, /failed/);
  assert.equal(await withSessionWriterLock('two', async () => 'other'), 'other');
  const next = withSessionWriterLock('one', async () => 'next');
  held.reject(new Error('failed')); await rejected;
  assert.equal(await next, 'next');
  assert.equal(globalThis.__piSessionWriterLocks.size, 0);
});

const source = ts.createSourceFile('rpc-manager.ts', readFileSync(new URL('./rpc-manager.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function fn(name) { const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name); assert.ok(node, name); return node.getText(source).replace(/^export /, ''); }
const gateScript = new Script(ts.transpileModule(fn('recordChildExitWait') + '\nrecordChildExitWait;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
test('failed exit wait remains a blocking gate on every retry, success alone clears it', async () => {
  const gates = new Map();
  const record = gateScript.runInNewContext({ getChildExitWaits: () => gates });
  const exit = deferred();
  record('one', { inner: { waitForChildExit: () => exit.promise } });
  exit.reject(new Error('still running')); await turn();
  assert.equal(gates.has('one'), true);
  for (let i = 0; i < 2; i++) await assert.rejects(gates.get('one'), /still running/);
  const success = deferred();
  record('two', { inner: { waitForChildExit: () => success.promise } });
  success.resolve(); await turn();
  assert.equal(gates.has('two'), false);
});

test('a rejected closing wait releases the start lock without authorizing an unproven writer exit', async () => {
  const exit = deferred();
  const locks = new Map();
  const registry = new Map([['one', {
    isAlive: () => false,
    waitUntilDisposed: async () => false,
    inner: { waitForChildExit: () => exit.promise },
  }]]);
  let opened = 0;
  const script = new Script(ts.transpileModule(
    fn('closingRpcSessionWait') + '\n' + fn('startRpcSessionLocked') + '\nstartRpcSessionLocked;',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText);
  const start = script.runInNewContext({
    getRegistry: () => registry,
    getLocks: () => locks,
    getChildExitWaits: () => new Map(),
    closingSessionWaits: new WeakMap(),
    SESSION_SHUTDOWN_DEADLINE_MS: 5000,
    CLOSING_SESSION_WAIT_MARGIN_MS: 1000,
    SessionManager: { open() { opened++; throw new Error('fresh-open-boundary'); } },
    console,
  });
  const pending = start('one', 'fixture.jsonl', undefined);
  await turn();
  assert.equal(locks.has('one'), true);
  exit.reject(new Error('child-still-running'));
  await assert.rejects(pending, /child-still-running/);
  assert.equal(locks.has('one'), false, 'failed start cannot poison the start-lock map');
  await assert.rejects(start('one', 'fixture.jsonl', undefined), /child-still-running/);
  assert.equal(locks.has('one'), false);
  assert.equal(opened, 0, 'the closing wrapper still blocks file access');
  // Simulate completed teardown; a stale rejected start must not mask this
  // newly safe path. The file boundary stub proves execution reaches it.
  registry.delete('one');
  await assert.rejects(start('one', 'fixture.jsonl', undefined), /fresh-open-boundary/);
  assert.equal(opened, 1);
});

test('production start/tool/chat entry points all acquire ownership before awaiting', async () => {
  const calls = [];
  for (const name of ['startRpcSession', 'setRpcSessionTools', 'setRpcChatUnlock']) {
    const script = new Script(ts.transpileModule(fn(name) + '\n' + name + ';', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
    const globals = { withSessionWriterLock: async (id, action) => { calls.push('lock:' + id); return action(); } };
    globals[name + 'Locked'] = async () => { calls.push(name); return 'ok'; };
    const entry = script.runInNewContext(globals);
    assert.equal(await entry('one', 'file', undefined), 'ok');
    assert.deepEqual(calls.splice(0), ['lock:one', name]);
  }
});
