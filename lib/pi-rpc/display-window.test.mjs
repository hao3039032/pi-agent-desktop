import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { sessionWindowEntries } from './assets/pi-web-session-window.mjs';
const jiti = createJiti(import.meta.url, { alias: { '@': process.cwd() } });
const { buildSessionContext, sliceActiveBranch } = await jiti.import('../session-reader.ts');
const { computeSessionStats } = await jiti.import('../session-stats.ts');
const { computeSessionTotalActiveMs } = await jiti.import('../session-timing.ts');

function fixture(count) {
  return Array.from({ length: count }, (_, i) => ({ id: `e${i}`, parentId: i ? `e${i-1}` : null,
    type: 'message', timestamp: new Date(1700000000000 + i * 1000).toISOString(),
    message: { role: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'assistant' : 'toolResult',
      provider: 'fixture', model: 'test', responseModel: 'physical',
      usage: { input: 10, output: 2, cost: { total: 0.1 } },
      content: [{ type: 'text', text: `${i} ` + 'x'.repeat(8192) }] },
  }));
}

test('display window preserves exact recent context, pagination, cumulative stats and timing with much smaller transfer', () => {
  const entries = fixture(4000);
  entries.splice(2, 0, { type: 'model_change', id: 'model', parentId: 'e1', provider: 'fixture', modelId: 'test' });
  entries.find(e => e.id === 'e2').parentId = 'model';
  const leaf = 'e3999';
  const projected = sessionWindowEntries(entries, leaf, 50, true);
  const options = { tail: 50, wholeTurns: true, deferThinking: true, deferToolResultImages: true };
  assert.deepEqual(buildSessionContext(projected, leaf, options), buildSessionContext(entries, leaf, options));
  assert.deepEqual(computeSessionStats(projected), computeSessionStats(entries));
  assert.equal(computeSessionTotalActiveMs(projected), computeSessionTotalActiveMs(entries));
  assert.ok(JSON.stringify(projected).length < JSON.stringify(entries).length / 8);
  assert.equal(entries[2].type, 'model_change');
});

test('window follows the CLI non-tail leaf and leaves every page body intact', () => {
  const entries = fixture(300);
  const leaf = 'e155';
  for (const tail of [1, 10, 50]) for (const wholeTurns of [true, false]) {
    const projected = sessionWindowEntries(entries, leaf, tail, wholeTurns);
    for (const entry of sliceActiveBranch(entries, leaf, tail, false, wholeTurns)) {
      assert.equal(projected.find(e => e.id === entry.id), entry, entry.id);
    }
    assert.deepEqual(buildSessionContext(projected, leaf, { tail, wholeTurns }), buildSessionContext(entries, leaf, { tail, wholeTurns }));
  }
});

test('old image/system/tool payloads are dropped, metadata and recent contents are not mutated', () => {
  const entries = fixture(300);
  entries[0].message.content.push({ type: 'image', data: 'SECRET_IMAGE_BYTES' });
  entries[1].message.content.push({ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'SECRET_ARGS' } });
  entries[1].message.sections = { core: 'SECRET_PROMPT' };
  entries[2].message.details = { private: 'SECRET_DETAILS' };
  const projected = sessionWindowEntries(entries, 'e299', 10, false);
  assert.doesNotMatch(JSON.stringify(projected), /SECRET_/);
  assert.match(JSON.stringify(entries), /SECRET_IMAGE_BYTES/);
  assert.deepEqual(computeSessionStats(projected), computeSessionStats(entries));
});
