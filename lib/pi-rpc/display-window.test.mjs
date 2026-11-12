import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createJiti } from 'jiti';
import { sessionWindowEntries } from './assets/pi-web-session-window.mjs';
const jiti = createJiti(import.meta.url, { alias: { '@': process.cwd() } });
const { buildSessionContext, sliceActiveBranch } = await jiti.import('../session-reader.ts');
const { computeSessionStats } = await jiti.import('../session-stats.ts');
const { computeSessionTotalActiveMs } = await jiti.import('../session-timing.ts');
const { isMessageGroupAnchor } = await jiti.import('../message-display.ts');

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

test('child and host pagination agree on all three subagent notification kinds, display:false included', () => {
  for (const customType of ['subagent-notify', 'subagent-notification', 'pi-web:subagent-notification']) {
    const entries = [
      { id: 'u', parentId: null, type: 'message', message: { role: 'user', content: 'u'.repeat(400) } },
      { id: 'a', parentId: 'u', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(400) }] } },
      { id: 'notice', parentId: 'a', type: 'custom_message', customType, display: false, content: 'done' },
      { id: 'tool', parentId: 'notice', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'tool' }] } },
      { id: 'result', parentId: 'tool', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'result' }] } },
      { id: 'after', parentId: 'result', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'after' }] } },
    ];
    const projected = sessionWindowEntries(entries, 'after', 2, true);
    const notice = projected.find((entry) => entry.id === 'notice');
    assert.ok(notice, `${customType} is retained at the whole-turn boundary`);
    assert.equal(notice.content, 'done', 'the notification body stays intact');
    // Entry ids alone cannot detect a lost anchor: every entry is still
    // projected. The kept set decides whether the old payload is truncated.
    assert.equal(projected.find((entry) => entry.id === 'u').message.content.length, 160, `${customType} keeps the old user entry outside the kept set`);
    assert.equal(projected.find((entry) => entry.id === 'a').message.content[0].text.length, 160, `${customType} keeps the old assistant payload outside the kept set`);
    assert.equal(isMessageGroupAnchor({ role: 'custom', customType, display: false }), true);
    const windowSource = readFileSync(new URL('./assets/pi-web-session-window.mjs', import.meta.url), 'utf8');
    const withoutThirdKind = windowSource.replace(`'${customType}'`, 'null').replace('export function sessionWindowEntries', 'function sessionWindowEntries');
    assert.notEqual(withoutThirdKind, windowSource, 'the mutation actually removes this notification kind');
    const windowWithoutThirdKind = new Function(`${withoutThirdKind}; return sessionWindowEntries;`)();
    const mutated = windowWithoutThirdKind(entries, 'after', 2, true);
    assert.equal(mutated.find((entry) => entry.id === 'a').message.content[0].text.length, 400,
      'mutation evidence: dropping this kind keeps the entire turn in the body window');
    for (const tail of [1, 2, 3, 4]) {
      assert.deepEqual(buildSessionContext(projected, 'result', { tail, wholeTurns: true }).entryIds,
        buildSessionContext(entries, 'result', { tail, wholeTurns: true }).entryIds);
    }
    assert.deepEqual(buildSessionContext(projected, 'result', { tail: 2, wholeTurns: true }).entryIds, ['notice', 'tool', 'result']);
  }
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
