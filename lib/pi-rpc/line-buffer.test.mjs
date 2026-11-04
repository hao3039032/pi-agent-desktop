import assert from 'node:assert/strict';
import test from 'node:test';
import { RpcLineBuffer } from './line-buffer.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createJiti } from 'jiti';
const { PiRpcClient } = await createJiti(import.meta.url).import('./client.ts');

test('RPC framing preserves fragmented CRLF, unicode separators, empty and multiple lines', () => {
  const buffer = new RpcLineBuffer();
  assert.deepEqual(buffer.push('{"x":"你\u2028好\u2029"}'), []);
  assert.deepEqual(buffer.push('\r'), []);
  assert.deepEqual(buffer.push('\n\n{"x":2}\npar'), ['{"x":"你\u2028好\u2029"}', '', '{"x":2}']);
  assert.deepEqual(buffer.push('tial\n'), ['partial']);
  assert.deepEqual(buffer.push(''), []);
});

test('large replies assemble once at LF and are not truncated', () => {
  const buffer = new RpcLineBuffer();
  const line = JSON.stringify({ data: 'x'.repeat(16 * 1024 * 1024) });
  for (let i = 0; i < line.length; i += 16384) {
    assert.deepEqual(buffer.push(line.slice(i, i + 16384)), []);
  }
  assert.deepEqual(buffer.push('\n'), [line]);
  assert.deepEqual(buffer.push('{}\n'), ['{}']);
});

test('real client correlates fragmented large command replies and preserves following events', async () => {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const client = new PiRpcClient('fake', { spawnChild: () => child });
  const events = [];
  client.onEvent(e => events.push(e));
  try {
    const command = client.command('get_entries', { id: 'large' }, 2000);
    const text = '你\u2028好\u2029'.repeat(1024 * 256);
    const reply = JSON.stringify({ type: 'response', id: 'large', command: 'get_entries', success: true, data: { text } }) + '\r\n';
    // Byte fragments can split a UTF-8 character; the client's stream decoder
    // must still deliver the original text before JSONL framing.
    const bytes = Buffer.from(reply);
    for (let i = 0; i < bytes.length; i += 16381) child.stdout.write(bytes.subarray(i, i + 16381));
    child.stdout.write('{"type":"agent_settled"}\n');
    assert.equal((await command).text, text);
    assert.equal(events.at(-1).type, 'agent_settled');
  } finally { child.emit('exit', 0, null); }
});

test('failed process drops partial replies', () => {
  const buffer = new RpcLineBuffer();
  buffer.push('abandoned');
  buffer.clear();
  assert.deepEqual(buffer.push('{}\n'), ['{}']);
});
