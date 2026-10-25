import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createJiti } from 'jiti';
import { cleanupDir, resolvePiCliBin } from './test-utils.mjs';
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { startCliRpcSession } = await jiti.import('./factory.ts');
const executable = resolvePiCliBin();

test('real CLI: compaction refreshes wrapper usage; unexpected exit ends wrapper (no model/network)', { skip: executable ? false : 'PI_CLI_BIN not set' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-recovery-smoke-'));
  const cwd = join(root, 'work'), agentDir = join(root, 'agent'), sessionDir = join(root, 'sessions');
  for (const p of [cwd, agentDir, sessionDir, join(agentDir, 'extensions')]) await mkdir(p, { recursive: true });
  // A local-only configured model lets the CLI compute limits. Compaction is
  // supplied by the fixture hook: no model or auth endpoint is ever called.
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-not-a-credential', api: 'openai-completions', models: [{ id: 'local', name: 'Local fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'local', compaction: { keepRecentTokens: 1, reserveTokens: 100 } }));
  await writeFile(join(agentDir, 'extensions', 'fixture.js'), `export default function(pi) {
    pi.on('session_before_compact', event => ({ compaction: { summary: 'Fixture summary', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
    pi.registerCommand('fixture-exit', { handler: async () => { setTimeout(() => process.exit(3), 50); } });
  }`);
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendModelChange('fixture', 'local');
  for (let i = 0; i < 4; i++) {
    manager.appendMessage({ role: 'user', content: 'Test input '.repeat(500), timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Test output '.repeat(500) }], api: 'openai-completions', provider: 'fixture', model: 'local', stopReason: 'stop', timestamp: Date.now(), usage: { input: 90000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 91000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  let started;
  try {
    started = await startCliRpcSession({ sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionDir, agentDir, executable, toolNames: ['read'], onLog: () => {} });
    const { core, wrapper } = started;
    const commands = await core.rpc.command('get_commands');
    assert.ok(commands.commands.some(c => c.name === 'fixture-exit'), 'fixture must load before any compaction request');
    await core.refreshStats();
    const before = await wrapper.send({ type: 'get_state' });
    assert.ok(before.contextUsage.percent > 0);
    const result = await wrapper.send({ type: 'compact' });
    assert.equal(result.summary, 'Fixture summary');
    const after = await wrapper.send({ type: 'get_state' });
    assert.equal(after.contextUsage.tokens, null);
    assert.equal(after.contextUsage.percent, null);
    const entries = (await readFile(manager.getSessionFile(), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(entries.some(e => e.type === 'compaction' && e.summary === 'Fixture summary'));
    const events = [];
    wrapper.onEvent(e => events.push(e));
    const exited = new Promise(resolve => core.rpc.onProcessExit(resolve));
    await core.rpc.command('prompt', { message: '/fixture-exit' });
    assert.equal(await exited, 3);
    assert.equal(wrapper.isAlive(), false);
    assert.equal(wrapper.isRunning(), false);
    assert.equal(events.filter(e => e.type === 'session_process_exit').length, 1);
    await assert.rejects(wrapper.send({ type: 'steer', message: 'no' }), /closed/);
    // A fresh sandbox wrapper verifies force termination against a real child,
    // never the app or the session this test was invoked from.
    const replacement = await startCliRpcSession({ sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionDir, agentDir, executable, toolNames: ['read'], onLog: () => {} });
    started = replacement;
    await replacement.wrapper.send({ type: 'abort' });
    await assert.rejects(replacement.wrapper.forceStop(wrapper.instanceId), /replacement/);
    assert.equal(replacement.core.rpc.hasExited, false);
    await replacement.wrapper.forceStop(replacement.wrapper.instanceId);
    assert.equal(replacement.core.rpc.hasExited, true);
    assert.equal(replacement.wrapper.isAlive(), false);
  } finally {
    if (started) { await started.wrapper.shutdown(); await started.core.rpc.close(100); }
    await cleanupDir(root);
  }
});
