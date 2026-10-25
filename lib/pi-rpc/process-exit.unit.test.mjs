import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { PiRpcClient } = await jiti.import('./client.ts');
const { AgentSessionWrapper } = await jiti.import('../rpc-manager.ts');
const { redactCliDiagnostic } = await jiti.import('./diagnostics.ts');

test('child exit rejects commands, clears wrapper running state, and closes SSE once', async () => {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 123, kill() {} });
  const client = new PiRpcClient('fake', { spawnChild: () => child });
  let disposed = 0;
  const wrapper = new AgentSessionWrapper({ sessionId: 'exit-fixture', isStreaming: true, isIdle: false, isBashRunning: false, dispose() { disposed++; } });
  const events = [];
  wrapper.onEvent(e => events.push(e));
  client.onProcessExit(code => wrapper.handleProcessExit(code, client.terminationSignal));
  const pending = client.command('abort');
  const rejected = assert.rejects(pending, /code 3/);
  child.emit('exit', 3, null);
  await rejected;
  assert.equal(wrapper.isAlive(), false);
  assert.equal(wrapper.isRunning(), false);
  assert.equal(wrapper.getLifecycleAbortSignal().aborted, true);
  assert.deepEqual(events.map(e => e.type), ['session_process_exit', 'session_shutdown']);
  assert.equal(events[0].code, 3);
  wrapper.handleProcessExit(3);
  assert.equal(disposed, 1);
  await assert.rejects(wrapper.send({ type: 'steer', message: 'no' }), /closed/);
});

test('force stop requires a prior Stop and the exact runtime instance', async () => {
  let kills = 0;
  const wrapper = new AgentSessionWrapper({ sessionId: 'force-fixture', isIdle: true, abort: async () => { throw new Error('timeout'); }, dispose() {} }, { terminateProcess: async () => { kills++; } });
  try {
    await assert.rejects(wrapper.forceStop(wrapper.instanceId), /Request Stop/);
    await assert.rejects(wrapper.send({ type: 'abort' }), /timeout/);
    await assert.rejects(wrapper.forceStop('previous-runtime'), /replacement/);
    assert.equal(kills, 0);
    await wrapper.forceStop(wrapper.instanceId);
    assert.equal(kills, 1);
  } finally { wrapper.destroy(); }
});

test('stderr is framed before redaction, including secrets split across chunks', () => {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const logs = [];
  const client = new PiRpcClient('fake', { spawnChild: () => child, onLog: line => logs.push(redactCliDiagnostic(line, { MY_TOKEN: 'sensitive-value' })) });
  child.stderr.write('diagnostic sensitive-');
  assert.equal(logs.length, 0);
  child.stderr.write('value\n');
  assert.deepEqual(logs, ['diagnostic [REDACTED]']);
  child.stderr.write('x'.repeat(20000));
  child.stderr.write('\n');
  assert.match(logs[1], /omitted/);
  child.emit('exit', 0, null);
  client.kill();
});

test('diagnostics are bounded and strip env secrets, auth headers, URL credentials and query strings', () => {
  const line = redactCliDiagnostic('custom opaque-value Authorization: Bearer abc password="xyz" https://u:p@host/path?token=zzz\nnext', { CUSTOM_TOKEN: 'opaque-value' });
  for (const secret of ['opaque-value', 'abc', 'xyz', 'u:p', 'zzz', '\n']) assert.ok(!line.includes(secret), line);
  assert.equal(redactCliDiagnostic('a'.repeat(10000)).length, 2048);
});
