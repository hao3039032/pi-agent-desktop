import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
const source = ts.createSourceFile('route.ts', readFileSync(new URL('./route.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const post = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'POST');
const script = new Script(ts.transpileModule(post.getText(source).replace('export ', '') + '\nPOST;', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText);
function harness(existing) {
  const calls = { starts: 0, reads: 0 };
  const POST = script.runInNewContext({
    NextResponse: { json: (body, init) => Response.json(body, init) },
    getRpcSession: () => existing,
    resolveSessionPath: async () => { calls.reads++; return '/fake/session'; },
    startRpcSession: async () => { calls.starts++; throw new Error('must not start'); },
  });
  return { calls, request: body => POST(new Request('http://local/api', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 's1' }) }) };
}
for (const type of ['abort', 'abort_bash', 'abort_compaction', 'abort_retry', 'abort_branch_summary', 'steer', 'follow_up', 'force_stop']) {
  test(`${type} does not respawn a dead session`, async () => {
    const h = harness(undefined);
    const response = await h.request({ type });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'session_closed');
    assert.equal(h.calls.starts, 0);
    assert.equal(h.calls.reads, 0);
  });
}
test('Stop failure carries the exact process instance for explicit force-stop confirmation', async () => {
  const h = harness({ instanceId: 'one', isAlive: () => true, send: async () => { throw new Error('abort timed out'); } });
  const response = await h.request({ type: 'abort' });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).instanceId, 'one');
});
test('force-stop rejects a confirmation for a superseded runtime', async () => {
  let killed = 0;
  const h = harness({ instanceId: 'two', isAlive: () => true, forceStop: async () => { killed++; } });
  assert.equal((await h.request({ type: 'force_stop', instanceId: 'one' })).status, 409);
  assert.equal(killed, 0);
  assert.equal((await h.request({ type: 'force_stop', instanceId: 'two' })).status, 200);
  assert.equal(killed, 1);
  assert.equal(h.calls.starts, 0);
});
