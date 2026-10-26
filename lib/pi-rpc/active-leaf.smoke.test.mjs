/**
 * Real-CLI smoke (no model, no network): the active leaf/branch is read from
 * the CLI child, not from the session file's tail.
 *
 * pi's navigateTree moves the leaf IN MEMORY (sessionManager.branch()); the
 * append-only file keeps the abandoned branch's tail, so a disk re-open
 * computes leafId = last file entry. This pins that the desktop's live reads
 * follow the child: getActiveSnapshot, the detail route (GET /api/sessions/[id])
 * and the active-branch context route all answer with the navigated leaf,
 * explicit-leaf browsing still reads the file, a dead child is an explicit
 * error, and an exited session falls back to disk.
 *
 * Everything is sandboxed: agentDir/sessionDir/cwd are temp dirs, the model
 * fixture points at 127.0.0.1:1 and is never called (no prompt is sent).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createJiti } from 'jiti';
import { cleanupDir, resolvePiCliBin } from './test-utils.mjs';

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: { "@": process.cwd() } });
const { startCliRpcSession } = await jiti.import('./factory.ts');
const { buildSessionContext } = await jiti.import('../session-reader.ts');
const { cacheSessionPath } = await jiti.import('../session-reader.ts');
const { GET: getSessionDetail } = await jiti.import('../../app/api/sessions/[id]/route.ts');
const { GET: getSessionContext } = await jiti.import('../../app/api/sessions/[id]/context/route.ts');
const executable = resolvePiCliBin();

test('real CLI: active leaf follows the child after navigate_tree (no model/network)', { skip: executable ? false : 'PI_CLI_BIN not set' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-active-leaf-'));
  const cwd = join(root, 'work'), agentDir = join(root, 'agent'), sessionDir = join(root, 'sessions');
  for (const p of [cwd, agentDir, sessionDir, join(agentDir, 'extensions')]) await mkdir(p, { recursive: true });
  // A local-only configured model lets the child boot; nothing ever calls it
  // (no prompt is sent — only tree navigation, which needs no model).
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-not-a-credential', api: 'openai-completions', models: [{ id: 'local', name: 'Local fixture', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'local' }));
  await writeFile(join(agentDir, 'extensions', 'fixture.js'), `export default function(pi) {
    pi.registerCommand('fixture-exit', { handler: async () => { setTimeout(() => process.exit(3), 50); } });
  }`);

  // u1 -> a1 -> u2 -> a2. A later branch from a1 exists only once we
  // navigate there (in memory), so before navigation there is exactly one
  // linear branch. The thinking level is pre-pinned to the value the CLI
  // itself records on open ("off", observed against this exact binary): a
  // resumed session with a recorded level applies no change on startup, so
  // the child has NO startup write that could race this test's disk reads —
  // the deterministic boundary is the awaited navigate/response, not a sleep.
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendMessage({ role: 'system', content: '', sections: { core: 'FIRST BRANCH PROMPT' }, timestamp: Date.now() });
  manager.appendMessage({ role: 'user', content: 'first question', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'first answer' }], timestamp: Date.now() });
  manager.appendMessage({ role: 'system', content: '', sections: { core: 'LATER BRANCH PROMPT' }, timestamp: Date.now() });
  manager.appendMessage({ role: 'user', content: 'second question', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'second answer' }], timestamp: Date.now() });
  manager.appendThinkingLevelChange('off');
  const entries0 = manager.getEntries();
  const byContent = (text) => entries0.find((entry) => entry.type === 'message'
    && JSON.stringify(entry.message.content).includes(text)).id;
  const a1Id = byContent('first answer');
  const a2Id = byContent('second answer');
  assert.notEqual(a1Id, a2Id);

  const previousRegistry = globalThis.__piSessions;
  let started;
  try {
    started = await startCliRpcSession({ sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionDir, agentDir, executable, toolNames: ['read'], onLog: () => {} });
    const { core, wrapper } = started;
    globalThis.__piSessions = new Map([[manager.getSessionId(), wrapper]]);

    // startCliRpcSession persists the tool pin before the child opens the
    // file, so the FILE tail (and the fresh child's leaf) is that pin entry,
    // not a2: with the thinking level pre-pinned above, the child performs no
    // startup append, so disk and child agree deterministically here.
    const tailId = SessionManager.open(manager.getSessionFile(), sessionDir).getLeafId();
    assert.notEqual(tailId, a2Id, 'the fixture must have an entry after a2 (the tool pin)');

    // --- before navigation: the child's leaf is the file tail --------------
    // (a fixture-specific fact, not a general invariant: after a navigation
    // the leaf is any legal node of the tree get_entries returns.)
    let snapshot = await core.getActiveSnapshot();
    assert.ok(
      snapshot.entries.some((entry) => entry?.id === snapshot.leafId),
      'the leaf must be a node of the same response\'s entries',
    );
    assert.equal(snapshot.leafId, tailId, 'fresh child must start at the file tail');
    assert.equal((await wrapper.send({ type: 'get_state' })).systemPrompt, 'LATER BRANCH PROMPT');

    // The routes answer through the snapshot path for a live wrapper.
    const routeContext = { params: Promise.resolve({ id: manager.getSessionId() }) };
    const detailUrl = `http://localhost/api/sessions/${manager.getSessionId()}`;
    let detail = await (await getSessionDetail(new Request(detailUrl), routeContext)).json();
    assert.equal(detail.leafId, tailId);
    let activeContext = await (await getSessionContext(new Request(`${detailUrl}/context`), routeContext)).json();
    // entryIds carries only entries that render (the tool pin is a `custom`
    // entry), so the visible chain ends at the last message on the branch.
    assert.equal(activeContext.context.entryIds.at(-1), a2Id);

    // --- navigate to the first assistant entry (a non-tail leaf) -----------
    await wrapper.send({ type: 'navigate_tree', targetId: a1Id });

    // The file still ends at the pin entry: the move is in memory, never a file write.
    const disk = SessionManager.open(manager.getSessionFile(), sessionDir);
    assert.equal(disk.getLeafId(), tailId, 'navigate_tree must not rewrite the file');

    snapshot = await core.getActiveSnapshot();
    assert.equal(snapshot.leafId, a1Id, 'the snapshot must follow the child leaf, not the file tail');
    const promptState = await wrapper.send({ type: 'get_state' });
    assert.equal(promptState.systemPromptStatus, 'recorded');
    assert.equal(promptState.systemPrompt, 'FIRST BRANCH PROMPT', 'prompt replay uses the CLI branch, not the abandoned disk tail');
    const branch = buildSessionContext(snapshot.entries, snapshot.leafId, { tail: 50 });
    assert.equal(branch.entryIds.at(-1), a1Id);
    assert.equal(branch.messages.at(-1).content[0].text, 'first answer');

    // The tree still contains every entry, including the abandoned tail.
    const collectTreeIds = (nodes, into = new Set()) => {
      for (const node of nodes) {
        if (node?.entry?.id) into.add(node.entry.id);
        for (const id of node?.compressedEntryIds ?? []) into.add(id);
        collectTreeIds(node?.children ?? [], into);
      }
      return into;
    };
    const treeIds = collectTreeIds(snapshot.tree);
    assert.ok(treeIds.has(a1Id) && treeIds.has(a2Id), 'the tree keeps the abandoned branch visible');

    // --- the routes read the child's branch while it is live ----------------
    detail = await (await getSessionDetail(new Request(detailUrl), routeContext)).json();
    assert.equal(detail.leafId, a1Id, 'detail route must report the child leaf');
    assert.equal(detail.context.entryIds.at(-1), a1Id);
    assert.equal(detail.context.messages.at(-1).content[0].text, 'first answer');
    assert.ok(collectTreeIds(detail.tree).has(tailId),
      'the projected tree keeps the abandoned tail reachable');

    activeContext = await (await getSessionContext(new Request(`${detailUrl}/context`), routeContext)).json();
    assert.equal(activeContext.context.entryIds.at(-1), a1Id, 'active-branch context must follow the child leaf');

    // Explicit-leaf browsing still answers from the file (it holds every entry).
    const explicit = await (await getSessionContext(
      new Request(`${detailUrl}/context?leafId=${encodeURIComponent(a2Id)}`),
      routeContext,
    )).json();
    assert.equal(explicit.context.entryIds.at(-1), a2Id, 'explicit branch browsing keeps working');

    // --- concurrent navigation: each awaited move lands, the last one wins --
    // Both navigations are awaited command completions, so the child's leaf
    // is deterministic afterwards — no polling, and an older navigation (or
    // the abandoned tail) must never win a later read.
    await wrapper.send({ type: 'navigate_tree', targetId: a2Id });
    assert.equal((await core.getActiveSnapshot()).leafId, a2Id, 'the first navigation must land');
    await wrapper.send({ type: 'navigate_tree', targetId: a1Id });
    snapshot = await core.getActiveSnapshot();
    assert.equal(snapshot.leafId, a1Id, 'the last navigation must win');
    assert.notEqual(snapshot.leafId, tailId, 'the abandoned tail must not come back');
    assert.equal(
      SessionManager.open(manager.getSessionFile(), sessionDir).getLeafId(),
      tailId,
      'no navigation may write the file — the move stays in memory',
    );

    // --- a dead child is an explicit error, never a disk tail as "live" -----
    // The seam rejects; the route-level contract (an alive wrapper whose query
    // fails answers 500, never disk data) is pinned by the mock test below.
    const exited = new Promise((resolve) => core.rpc.onProcessExit(resolve));
    await core.rpc.command('prompt', { message: '/fixture-exit' });
    await exited;
    assert.equal(wrapper.isAlive(), false);
    await assert.rejects(core.getActiveSnapshot(), /exited|closing/i);

    // --- an exited session is history: disk answers, tail and all -----------
    // The wrapper's isAlive() is false, so the routes no longer treat it as a
    // live session and the file (with every abandoned branch) is the source.
    globalThis.__piSessions = new Map();
    cacheSessionPath(manager.getSessionId(), manager.getSessionFile());
    const file = await readFile(manager.getSessionFile(), 'utf8');
    assert.ok(file.includes('second answer'), 'the abandoned branch stays persisted for history');
    const historyDisk = SessionManager.open(manager.getSessionFile(), sessionDir);
    assert.equal(historyDisk.getLeafId(), tailId, 'an exited session reads from disk (pi resume semantics)');
    const historyContext = buildSessionContext(historyDisk.getEntries(), historyDisk.getLeafId(), { tail: 50 });
    assert.equal(historyContext.entryIds.at(-1), a2Id, 'the visible history chain ends at the last message, not the invisible pin');
    const historyDetail = await (await getSessionDetail(new Request(detailUrl), routeContext)).json();
    assert.equal(historyDetail.leafId, tailId, 'exited sessions fall back to the disk leaf');
  } finally {
    globalThis.__piSessions = previousRegistry;
    if (started) { await started.wrapper.shutdown().catch(() => {}); await started.core.rpc.close(100).catch(() => {}); }
    await cleanupDir(root);
  }
});

test('route contract: an alive wrapper whose live query fails answers an explicit error, never disk data', async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = 'active-leaf-query-failure';
  const sessionFile = join(tmpdir(), `pi-web-active-leaf-failure-${process.pid}.jsonl`);
  const inner = {
    // No sessionManager members are needed: the snapshot path must be taken
    // and fail there, before any file read could impersonate the live branch.
    sessionId: id,
    getActiveSnapshot: async () => {
      throw new Error("pi RPC 'get_entries' failed");
    },
  };
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => false,
    inner,
    sessionFile,
    sessionId: id,
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const detail = await getSessionDetail(new Request(`http://localhost/api/sessions/${id}`), routeContext);
  assert.equal(detail.status, 500);
  assert.match((await detail.json()).error, /could not be read from the CLI process.*get_entries/);

  const context = await getSessionContext(new Request(`http://localhost/api/sessions/${id}/context`), routeContext);
  assert.equal(context.status, 500);
  assert.match((await context.json()).error, /could not be read from the CLI process.*get_entries/);
});
