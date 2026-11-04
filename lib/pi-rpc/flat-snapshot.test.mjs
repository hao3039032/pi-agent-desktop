import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { decodeFlatSnapshot } from './flat-snapshot.ts';
const jiti = createJiti(import.meta.url);
const { CliAgentSessionCore } = await jiti.import('./core.ts');
const { RpcAgentSession } = await jiti.import('./session.ts');
const { default: bridge } = await import('./assets/pi-web-bridge.mjs');

test('bridge serializes a deep SDK tree without recursion, preserving child order, labels and non-tail leaf', async () => {
  const entries = Array.from({ length: 4000 }, (_, i) => ({ id: `e${i}`, type: 'message', parentId: i ? `e${i - 1}` : null }));
  const roots = [], nodes = entries.map(entry => ({ entry, children: [] }));
  roots.push(nodes[0]);
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].children.push(nodes[i]);
  nodes[1].label = 'branch'; nodes[1].labelTimestamp = '2026-01-01';
  const commands = new Map();
  bridge({ registerCommand: (name, def) => commands.set(name, def), on() {} });
  const old = process.env.PI_WEB_BRIDGE_NONCE;
  process.env.PI_WEB_BRIDGE_NONCE = 'test-nonce';
  let wire;
  try {
    const token = Buffer.from(JSON.stringify({ nonce: 'test-nonce', op: 'session.snapshot-flat' })).toString('base64url');
    await commands.get('pi-web:bridge').handler(`pwb-12345678 ${token}`, {
      sessionManager: { getEntries: () => entries, getTree: () => roots, getLeafId: () => 'e1', getSessionId: () => 's1' },
      ui: { notify: message => { wire = message; } },
    });
    const envelope = JSON.parse(wire.slice(wire.indexOf('{')));
    assert.equal(envelope.ok, true, wire?.slice(0, 200));
    const restored = decodeFlatSnapshot(envelope.result);
    assert.equal(restored.leafId, 'e1');
    let node = restored.tree[0];
    for (let i = 0; i < nodes.length; i++) {
      assert.equal(node.entry.id, `e${i}`);
      if (i === 1) { assert.equal(node.label, 'branch'); assert.equal(node.labelTimestamp, '2026-01-01'); }
      node = node.children[0];
    }
    assert.equal(node, undefined);
  } finally {
    if (old === undefined) delete process.env.PI_WEB_BRIDGE_NONCE;
    else process.env.PI_WEB_BRIDGE_NONCE = old;
  }
});

test('flat decoder refuses cycles, missing references and invalid leaves', () => {
  const entry = { id: 'a' };
  const base = { entries: [entry], leafId: 'a', nodes: [{ entryId: 'a', children: [] }], roots: [0] };
  assert.equal(decodeFlatSnapshot(base).tree[0].entry, entry);
  for (const value of [null, { ...base, leafId: 'missing' }, { ...base, roots: [] },
    { ...base, nodes: [{ entryId: 'a', children: [0] }] }, { ...base, roots: [9] }]) {
    assert.throws(() => decodeFlatSnapshot(value), /Invalid flat snapshot/);
  }
});

test('core fallback only handles native get_tree stack overflow, not dead child or other read errors', async (t) => {
  const original = RpcAgentSession.prototype.getActiveSnapshot;
  t.after(() => { RpcAgentSession.prototype.getActiveSnapshot = original; });
  let calls = 0;
  const core = Object.create(CliAgentSessionCore.prototype);
  core.bridgeRequest = async op => { assert.equal(op, 'session.snapshot-flat'); calls++; return { entries: [], nodes: [], roots: [], leafId: null }; };
  RpcAgentSession.prototype.getActiveSnapshot = async () => { throw new Error("pi RPC 'get_tree' failed: Maximum call stack size exceeded"); };
  assert.deepEqual(await core.getActiveSnapshot(), { entries: [], tree: [], leafId: null });
  assert.equal(calls, 1);
  for (const message of ['child exited', 'get_tree timeout', 'get_entries Maximum call stack size exceeded']) {
    RpcAgentSession.prototype.getActiveSnapshot = async () => { throw new Error(message); };
    await assert.rejects(core.getActiveSnapshot(), e => e.message === message);
  }
  assert.equal(calls, 1);
});
