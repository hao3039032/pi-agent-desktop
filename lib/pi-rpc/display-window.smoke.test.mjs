import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { resolvePiCliBin } from './test-utils.mjs';
const jiti = createJiti(import.meta.url, { alias: { '@': process.cwd() }, moduleCache: false });
const { startCliRpcSession } = await jiti.import('./factory.ts');
const { GET } = await jiti.import('../../app/api/sessions/[id]/route.ts');
const executable = resolvePiCliBin();

test('real CLI: 4000-entry conversation opens with recent bodies, correct leaf and complete statistics', { skip: executable ? false : 'PI_CLI_BIN not set' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-display-window-'));
  const agentDir = join(root, 'agent'), cwd = join(root, 'work'), sessionDir = join(root, 'sessions');
  for (const p of [agentDir, cwd, sessionDir]) await mkdir(p);
  const model = { providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture', models: [{ id: 'local', name: 'Local', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 4096 }] } } };
  await writeFile(join(agentDir, 'models.json'), JSON.stringify(model));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'local' }));
  const id = '11111111-1111-4111-8111-111111111111', timestamp = new Date().toISOString();
  const rows = [{ type: 'session', version: 3, id, timestamp, cwd }];
  for (let i = 0; i < 4000; i++) rows.push({ type: 'message', id: `e${i}`, parentId: i ? `e${i-1}` : null, timestamp,
    message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `${i}:` + 'x'.repeat(4096) }], timestamp: Date.now() } });
  rows.push({ type: 'thinking_level_change', id: 'thinking', parentId: 'e3999', timestamp, thinkingLevel: 'off' });
  const file = join(sessionDir, 'long.jsonl'); await writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const oldRegistry = globalThis.__piSessions;
  let started;
  try {
    started = await startCliRpcSession({ sessionId: id, sessionFile: file, sessionDir, agentDir, executable, toolNames: ['read'], onLog() {} });
    globalThis.__piSessions = new Map([[id, started.wrapper]]);
    const snapshot = await started.core.getDisplaySnapshot({ tail: 50, wholeTurns: true });
    assert.ok(JSON.stringify(snapshot.entries).length < JSON.stringify(rows).length / 8);
    // Generic callers still recover native deep-tree overflow, never a disk-tail fallback.
    const full = await started.core.getActiveSnapshot();
    assert.equal(full.leafId, snapshot.leafId);
    const url = `http://localhost/api/sessions/${id}?tree=summary&wholeTurns=1&deferThinking=1&deferMedia=1`;
    let response = await GET(new Request(url), { params: Promise.resolve({ id }) });
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.equal(body.stats.totalMessages, 4000);
    assert.equal(body.context.hasMore, true);
    assert.ok(body.context.messages.length <= 51);
    assert.match(body.context.messages.at(-1).content[0].text, /^3999:/);
    await started.wrapper.send({ type: 'navigate_tree', targetId: 'e1999' });
    response = await GET(new Request(url), { params: Promise.resolve({ id }) });
    body = await response.json();
    assert.equal(body.leafId, 'e1999');
    assert.match(body.context.messages.at(-1).content[0].text, /^1999:/);
    assert.equal(body.stats.totalMessages, 4000);
  } finally {
    globalThis.__piSessions = oldRegistry;
    if (started) { await started.wrapper.shutdown(); await started.core.waitForChildExit(); }
    await rm(root, { recursive: true, force: true });
  }
});
