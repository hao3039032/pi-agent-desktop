import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// A parked draft's cwd is only resolvable from server data while its project is
// selected. This store keeps the identity alive; give it the same localStorage
// shim the components see, populated before the module hydrates.
const storage = new Map([
  // Written by an earlier page load, before this module ever ran.
  ["pi-web:cwd-project-roots", JSON.stringify({ "/repo/worktrees/wt-persisted": "/repo" })],
]);
const windowListeners = new Map();
/** Counts `setItem` calls so "writes nothing" can be asserted directly, and
 *  can refuse a write so a quota / private-mode failure is testable. */
const writes = { count: 0, fail: false };
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      if (writes.fail) throw new DOMException("quota", "QuotaExceededError");
      writes.count += 1;
      storage.set(key, value);
    },
    removeItem: (key) => storage.delete(key),
  },
  addEventListener(type, handler) {
    const list = windowListeners.get(type) ?? [];
    list.push(handler);
    windowListeners.set(type, list);
  },
  removeEventListener(type, handler) {
    const list = windowListeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index !== -1) list.splice(index, 1);
  },
};

/** A `storage` event as another window's write delivers it — this window's own
 *  writes never fire one. */
const fireStorage = (key, newValue) => {
  for (const handler of [...(windowListeners.get("storage") ?? [])]) {
    handler({ key, newValue, storageArea: globalThis.window.localStorage });
  }
};

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  recallCwdProjectRoot,
  rememberCwdProjectRoots,
} = await jiti.import("@/lib/cwd-project-roots");
const { deriveSidebarDraftRows, draftRowProjectRootFor } = await jiti.import("@/lib/sidebar-draft-rows");

/** An independent module instance, as a second window of the same app has: its
 *  own in-memory map over the same localStorage. */
const loadFreshWindow = () => createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false })
  .import("@/lib/cwd-project-roots");

test.after(() => {
  delete globalThis.window;
});

const ROOTS_KEY = "pi-web:cwd-project-roots";
const storedRoots = () => JSON.parse(storage.get(ROOTS_KEY) ?? "{}");
const resetStorage = () => {
  storage.delete(ROOTS_KEY);
  writes.count = 0;
  writes.fail = false;
};

const draft = (value) => ({ value, images: [] });
const group = (projectRoot) => ({
  projectRoot,
  displayName: projectRoot.split("/").pop(),
  sessions: [],
  latestModified: "2024-01-01T00:00:00Z",
  unreadIds: new Set(),
  runningIds: new Set(),
  branches: [],
});

/** Resolve a parked draft's row exactly as the sidebar does. */
const rowsFor = (worktreeCwd, resolveRoot) => deriveSidebarDraftRows({
  parked: [{ cwd: worktreeCwd, draft: draft("parked") }],
  groups: [group("/repo")],
  selectedCwd: "/projB",
  selectedSessionId: null,
  projectRootFor: resolveRoot,
  isChatCwd: () => false,
  archivedRoots: new Set(["/repo"]),
});

test("roots persisted by an earlier page load resolve before anything is remembered", () => {
  // This is the cold-start half of the bug: a session-less worktree has no
  // session row, and its project's worktree listing is gone after a reload.
  assert.equal(recallCwdProjectRoot("/repo/worktrees/wt-persisted"), "/repo");
  assert.equal(recallCwdProjectRoot("/repo/never-seen"), null);
  assert.equal(recallCwdProjectRoot(null), null);
});

test("an incomplete server answer is never remembered as a project of its own", () => {
  rememberCwdProjectRoots([
    // Defensive: a partial row without a resolved root must not be stored as
    // "its own project". The session list fills `projectRoot`, so this covers
    // an incomplete shape rather than the normal answer.
    ["/repo/summary-row", undefined],
    [undefined, "/repo"],
    ["", "/repo"],
  ]);
  assert.equal(recallCwdProjectRoot("/repo/summary-row"), null);
  assert.equal(storedRoots()["/repo/summary-row"], undefined);
});

test("remembering a root persists it, and a repeated confirmation writes nothing", () => {
  resetStorage();
  rememberCwdProjectRoots([["/repo/worktrees/wt2", "/repo"]]);
  assert.equal(recallCwdProjectRoot("/repo/worktrees/wt2"), "/repo");
  assert.equal(storedRoots()["/repo/worktrees/wt2"], "/repo");

  const afterFirst = writes.count;
  const stored = storage.get(ROOTS_KEY);
  // The same answer again only refreshes the in-memory eviction order; it must
  // not rewrite the snapshot on every poll.
  rememberCwdProjectRoots([["/repo/worktrees/wt2", "/repo"]]);
  assert.equal(writes.count, afterFirst, "a repeated confirmation performs no write");
  assert.equal(storage.get(ROOTS_KEY), stored, "the stored value is untouched");
  assert.equal(recallCwdProjectRoot("/repo/worktrees/wt2"), "/repo", "the value is unchanged too");
});

test("a corrected identity replaces the old one", () => {
  rememberCwdProjectRoots([["/repo/worktrees/moved", "/repo"]]);
  rememberCwdProjectRoots([["/repo/worktrees/moved", "/repo-new"]]);
  assert.equal(recallCwdProjectRoot("/repo/worktrees/moved"), "/repo-new");
  assert.equal(storedRoots()["/repo/worktrees/moved"], "/repo-new");
});

test("the cache stays bounded, evicting the least recently remembered", () => {
  resetStorage();
  const entries = Array.from({ length: 260 }, (_, index) => [`/bulk/${index}`, "/bulk"]);
  rememberCwdProjectRoots(entries);
  const roots = storedRoots();
  assert.ok(Object.keys(roots).length <= 200, "the persisted map is capped");
  assert.equal(roots["/bulk/259"], "/bulk", "the newest entry survives");
  assert.equal(recallCwdProjectRoot("/bulk/0"), null, "the oldest entry is evicted");
});

test("a draft row keeps its worktree's project root once the listing is gone", () => {
  // The sidebar resolved this at selection time (its project's worktree
  // listing), then the user switched to another project: no loaded data
  // identifies the worktree any more.
  const worktreeCwd = "/repo/worktrees/wt-sessionless";
  rememberCwdProjectRoots([[worktreeCwd, "/repo"]]);

  const loadedRoot = null; // what the loaded session/worktree data now says
  assert.equal(
    draftRowProjectRootFor(loadedRoot, worktreeCwd),
    "/repo",
    "the row resolves to the project the server reported",
  );

  // The failure mode this fixes, spelled out: with the raw cwd as the root the
  // parked draft becomes a synthetic project group of its own and the archived
  // project can no longer hide it.
  const preFix = rowsFor(worktreeCwd, (cwd) => cwd);
  assert.deepEqual(preFix.rows.map((row) => row.cwd), ["/projB", worktreeCwd]);
  assert.deepEqual(
    preFix.syntheticGroups.map((entry) => entry.projectRoot),
    ["/projB", worktreeCwd],
    "the parked row claims to be a project of its own",
  );
  assert.equal(
    preFix.rowsByProjectRoot.has("/repo"),
    false,
    "the archived project no longer holds the worktree's row",
  );

  // With the remembered root the row lands in its project's group, so
  // archiving that project hides it exactly like its sessions.
  const resolvedRootFor = (cwd) => draftRowProjectRootFor(null, cwd);
  const archived = rowsFor(worktreeCwd, resolvedRootFor);
  assert.deepEqual(archived.rows.map((row) => row.cwd), ["/projB"], "archived project hides its worktree draft row");
  assert.deepEqual(archived.syntheticGroups.map((entry) => entry.projectRoot), ["/projB"]);

  const visible = deriveSidebarDraftRows({
    parked: [{ cwd: worktreeCwd, draft: draft("parked") }],
    groups: [group("/repo")],
    selectedCwd: "/projB",
    selectedSessionId: null,
    projectRootFor: resolvedRootFor,
    isChatCwd: () => false,
    archivedRoots: new Set(),
  });
  assert.deepEqual(visible.syntheticGroups.map((entry) => entry.projectRoot), ["/projB"], "the worktree is not a synthetic project");
  assert.equal(visible.rowsByProjectRoot.get("/repo").length, 1, "row joins the project group");
});

test("a cwd the browser never resolved still falls back to itself", () => {
  assert.equal(draftRowProjectRootFor(null, "/unknown/proj"), "/unknown/proj");
  assert.equal(draftRowProjectRootFor("/server/root", "/unknown/proj"), "/server/root");
});

test("an incomplete session row does not mask a remembered identity", () => {
  // `serverProjectRootFor()` answers null for a row without `projectRoot`
  // (never the cwd), which is what lets the draft row consult the remembered
  // root instead of inventing a synthetic project for the worktree.
  const worktreeCwd = "/repo/worktrees/wt-partial-row";
  rememberCwdProjectRoots([[worktreeCwd, "/repo"]]);
  assert.equal(draftRowProjectRootFor(null, worktreeCwd), "/repo");
});

test("a re-confirmed identity is not the next one evicted", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  windowA.rememberCwdProjectRoots([["/lru/wt", "/lru"]]);
  windowA.rememberCwdProjectRoots(
    Array.from({ length: 199 }, (_, index) => [`/lru/filler-${index}`, "/lru"]),
  );
  // A later poll re-confirms the first identity with the same value: it is now
  // the most recently remembered, so eviction must take another entry.
  windowA.rememberCwdProjectRoots([["/lru/wt", "/lru"]]);
  windowA.rememberCwdProjectRoots([["/lru/newest", "/lru"]]);

  assert.equal(windowA.recallCwdProjectRoot("/lru/wt"), "/lru", "the re-confirmed identity survives");
  assert.equal(windowA.recallCwdProjectRoot("/lru/filler-0"), null, "the oldest identity was evicted instead");
  assert.ok(Object.keys(storedRoots()).length <= 200, "the persisted map is still capped");
});

test("an identity another window learned arrives through storage and re-renders rows", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  const windowB = await loadFreshWindow();
  // B hydrated before A learned anything: this is the stale-window case that
  // used to keep the wrong grouping until a reload.
  assert.equal(windowB.recallCwdProjectRoot("/repo/worktrees/wt-live"), null);

  let notified = 0;
  const unsubscribe = windowB.subscribeCwdProjectRoots(() => { notified += 1; });

  // Order 1, identity first: the parked draft's own event may follow, and the
  // row already resolves. Order 2 is the next assertion block.
  windowA.rememberCwdProjectRoots([["/repo/worktrees/wt-live", "/repo"]]);
  fireStorage(ROOTS_KEY, storage.get(ROOTS_KEY));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(windowB.recallCwdProjectRoot("/repo/worktrees/wt-live"), "/repo");
  assert.ok(notified >= 1, "the sidebar is told to re-render its parked rows");

  // What the row resolver does with that identity: the draft joins /repo, so
  // archiving /repo hides it exactly like its sessions.
  const resolvedRootFor = (cwd) => windowB.recallCwdProjectRoot(cwd) ?? cwd;
  const afterIdentity = rowsFor("/repo/worktrees/wt-live", resolvedRootFor);
  assert.deepEqual(afterIdentity.rows.map((row) => row.cwd), ["/projB"]);
  unsubscribe();
});

test("an identity that arrives after the draft's event still fixes the row", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  const windowB = await loadFreshWindow();
  const worktreeCwd = "/repo/worktrees/wt-late";

  let notified = 0;
  const unsubscribe = windowB.subscribeCwdProjectRoots(() => { notified += 1; });

  // Order 2, draft first: the row is projected while the identity is still
  // unknown, so it wrongly claims to be its own project…
  const resolveRoot = (cwd) => windowB.recallCwdProjectRoot(cwd) ?? cwd;
  const beforeIdentity = rowsFor(worktreeCwd, resolveRoot);
  assert.ok(
    beforeIdentity.syntheticGroups.some((entry) => entry.projectRoot === worktreeCwd),
    "without the identity the row is a synthetic project (the bug)",
  );

  // …and the identity event that follows corrects it. A synchronous projection
  // inside the parked-draft subscriber sees the fixed map.
  windowA.rememberCwdProjectRoots([[worktreeCwd, "/repo"]]);
  fireStorage(ROOTS_KEY, storage.get(ROOTS_KEY));
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(notified >= 1, "the late identity notifies subscribers");

  const afterIdentity = rowsFor(worktreeCwd, resolveRoot);
  assert.deepEqual(afterIdentity.rows.map((row) => row.cwd), ["/projB"], "archived /repo hides the row again");
  assert.deepEqual(afterIdentity.syntheticGroups.map((entry) => entry.projectRoot), ["/projB"]);
  unsubscribe();
});

test("a window's write keeps identities another window already persisted", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  const windowB = await loadFreshWindow();
  // B hydrates an empty map first, so it never sees A's identity in memory.
  assert.equal(windowB.recallCwdProjectRoot("/anything"), null);

  windowA.rememberCwdProjectRoots([["/repo/worktrees/wt-from-a", "/repo"]]);
  // No `storage` event reaches B before it writes. A plain overwrite would drop
  // A's mapping here, and A's parked draft would regroup wrongly on reload.
  windowB.rememberCwdProjectRoots([["/other/worktrees/wt-from-b", "/other"]]);

  const roots = storedRoots();
  assert.equal(roots["/repo/worktrees/wt-from-a"], "/repo", "A's identity survives B's write");
  assert.equal(roots["/other/worktrees/wt-from-b"], "/other");
});

test("a stale local copy cannot undo another window's correction", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  const windowB = await loadFreshWindow();
  const worktreeCwd = "/repo/worktrees/wt-corrected";

  windowB.rememberCwdProjectRoots([[worktreeCwd, "/old-project"]]);
  // A hydrates the value B persisted, then the server corrects it (the path was
  // reused by another project) and A persists the correction.
  const windowC = await loadFreshWindow();
  assert.equal(windowC.recallCwdProjectRoot(worktreeCwd), "/old-project");
  windowC.rememberCwdProjectRoots([[worktreeCwd, "/new-project"]]);
  assert.equal(storedRoots()[worktreeCwd], "/new-project");

  // B still holds the stale value and has not consumed C's `storage` event. Its
  // next write learns an unrelated cwd: only that answer may reach the disk.
  windowB.rememberCwdProjectRoots([["/other/worktrees/wt-unrelated", "/other"]]);

  assert.equal(
    storedRoots()[worktreeCwd],
    "/new-project",
    "the unrelated write did not resurrect the stale value on disk",
  );
  assert.equal(storedRoots()["/other/worktrees/wt-unrelated"], "/other");
  // The write also re-adopts the disk value, so the stale window stops grouping
  // the draft under the old project immediately.
  assert.equal(windowB.recallCwdProjectRoot(worktreeCwd), "/new-project");
  assert.equal(windowA.recallCwdProjectRoot("/never-written"), null);
});

test("a queued storage event older than a local correction is ignored", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  const worktreeCwd = "/repo/worktrees/wt-queued";
  const unsubscribe = windowA.subscribeCwdProjectRoots(() => {});

  windowA.rememberCwdProjectRoots([[worktreeCwd, "/old-project"]]);
  const stalePayload = storage.get(ROOTS_KEY);
  assert.match(stalePayload, /old-project/);

  // The correction lands and is persisted before the older event is delivered.
  windowA.rememberCwdProjectRoots([[worktreeCwd, "/new-project"]]);
  assert.equal(storedRoots()[worktreeCwd], "/new-project");

  // The queued event still carries the pre-correction snapshot. Trusting its
  // payload would revert memory to /old-project.
  fireStorage(ROOTS_KEY, stalePayload);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    windowA.recallCwdProjectRoot(worktreeCwd),
    "/new-project",
    "the current snapshot wins over the queued event's payload",
  );
  unsubscribe();
});

test("a window that misses an event does not evict the identity it never saw", async () => {
  resetStorage();
  const seed = await loadFreshWindow();
  const oldKeys = Array.from({ length: 200 }, (_, index) => [`/cap/k${index}`, "/cap"]);
  seed.rememberCwdProjectRoots(oldKeys);
  assert.equal(Object.keys(storedRoots()).length, 200);

  const windowA = await loadFreshWindow();
  const windowB = await loadFreshWindow();
  // Hydrate both windows from the 200 shared identities *before* A writes, so
  // B really is the window that misses A's `storage` event.
  assert.equal(windowA.recallCwdProjectRoot("/cap/k0"), "/cap");
  assert.equal(windowB.recallCwdProjectRoot("/cap/k0"), "/cap");

  // A learns x and persists it; B never consumes A's `storage` event.
  windowA.rememberCwdProjectRoots([["/cap/x", "/cap"]]);
  assert.equal(storedRoots()["/cap/x"], "/cap");

  // B's own answer appends y. Promoting B's whole (older) map to newest would
  // push x in front of the eviction line and drop it on this write.
  windowB.rememberCwdProjectRoots([["/cap/y", "/cap"]]);

  const roots = storedRoots();
  assert.ok(Object.keys(roots).length <= 200, "the persisted map stays capped");
  assert.equal(roots["/cap/x"], "/cap", "the other window's fresh identity survives");
  assert.equal(roots["/cap/y"], "/cap", "this window's answer is kept");
  assert.equal(roots["/cap/k0"], undefined, "the oldest identity is evicted instead");
});

test("a malformed or cleared snapshot leaves this window's map untouched", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  const worktreeCwd = "/repo/worktrees/wt-safe";
  let notified = 0;
  const unsubscribe = windowA.subscribeCwdProjectRoots(() => { notified += 1; });

  windowA.rememberCwdProjectRoots([[worktreeCwd, "/repo"]]);

  // Control: a legitimate snapshot written by another window really does reach
  // this instance through the listener, so the assertions below are not vacuous.
  const other = await loadFreshWindow();
  other.rememberCwdProjectRoots([[worktreeCwd, "/repo-updated"]]);
  fireStorage(ROOTS_KEY, storage.get(ROOTS_KEY));
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(notified >= 1, "the listener of this instance ran");
  assert.equal(windowA.recallCwdProjectRoot(worktreeCwd), "/repo-updated", "a valid snapshot is adopted");

  // Now the garbage: an unparsable value, an array, and a key removal. Each
  // must leave the last good map in place.
  storage.set(ROOTS_KEY, "{not json");
  fireStorage(ROOTS_KEY, "{not json");
  storage.set(ROOTS_KEY, JSON.stringify([["/repo/worktrees/wt-safe", "/hijacked"]]));
  fireStorage(ROOTS_KEY, storage.get(ROOTS_KEY));
  fireStorage(ROOTS_KEY, null);
  await Promise.resolve();

  assert.equal(windowA.recallCwdProjectRoot(worktreeCwd), "/repo-updated");
  unsubscribe();
});

test("a recency-only confirmation cannot undo another window's correction", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  const windowB = await loadFreshWindow();
  const worktreeCwd = "/repo/worktrees/wt-reconfirm";
  const unsubscribe = windowB.subscribeCwdProjectRoots(() => {});

  windowB.rememberCwdProjectRoots([[worktreeCwd, "/old-project"]]);
  // The sidebar polls the same answer again: the value is unchanged, nothing is
  // written, but the key becomes the most recently remembered one.
  const beforePoll = writes.count;
  windowB.rememberCwdProjectRoots([[worktreeCwd, "/old-project"]]);
  assert.equal(writes.count, beforePoll, "the repeated confirmation writes nothing");

  // Another window corrects the identity (the path was reused by a project).
  windowA.rememberCwdProjectRoots([[worktreeCwd, "/new-project"]]);
  assert.equal(storedRoots()[worktreeCwd], "/new-project");

  // The correction reaches this window. A stale recency observation must not win.
  fireStorage(ROOTS_KEY, storage.get(ROOTS_KEY));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    windowB.recallCwdProjectRoot(worktreeCwd),
    "/new-project",
    "the correction wins over the earlier repeated confirmation",
  );

  // And a later unrelated write cannot put the stale value back on disk.
  windowB.rememberCwdProjectRoots([["/other/worktrees/wt-unrelated-reconfirm", "/other"]]);
  assert.equal(
    storedRoots()[worktreeCwd],
    "/new-project",
    "the re-confirmed value never overrides the snapshot",
  );
  unsubscribe();
});

test("a recency-only confirmation never reaches the disk after another window's correction", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  const windowB = await loadFreshWindow();
  const worktreeCwd = "/repo/worktrees/wt-reconfirm-silent";

  windowB.rememberCwdProjectRoots([[worktreeCwd, "/old-project"]]);
  windowB.rememberCwdProjectRoots([[worktreeCwd, "/old-project"]]); // poll, no write

  windowA.rememberCwdProjectRoots([[worktreeCwd, "/new-project"]]);
  // B never consumes the storage event; its next write learns an unrelated cwd.
  windowB.rememberCwdProjectRoots([["/other/worktrees/wt-unrelated-silent", "/other"]]);

  assert.equal(
    storedRoots()[worktreeCwd],
    "/new-project",
    "the stale re-confirmation is not written back",
  );
  assert.equal(
    windowB.recallCwdProjectRoot(worktreeCwd),
    "/new-project",
    "and that write adopts the correction instead of keeping the stale copy",
  );
});

test("re-confirmed identities cannot age out an identity another window just learned", async () => {
  resetStorage();
  const seed = await loadFreshWindow();
  const oldKeys = Array.from({ length: 200 }, (_, index) => [`/cap2/k${index}`, "/cap2"]);
  seed.rememberCwdProjectRoots(oldKeys);

  const windowA = await loadFreshWindow();
  const windowB = await loadFreshWindow();
  assert.equal(windowA.recallCwdProjectRoot("/cap2/k0"), "/cap2");
  assert.equal(windowB.recallCwdProjectRoot("/cap2/k0"), "/cap2");

  // A poll re-confirms every old identity with the same value: order only.
  const beforePoll = writes.count;
  windowB.rememberCwdProjectRoots(oldKeys);
  assert.equal(writes.count, beforePoll, "re-confirming the whole map writes nothing");

  windowA.rememberCwdProjectRoots([["/cap2/x", "/cap2"]]);
  // B misses that event and answers y. Its backlog of stale recency must not be
  // treated as newer than the identity A just learned.
  windowB.rememberCwdProjectRoots([["/cap2/y", "/cap2"]]);

  const roots = storedRoots();
  assert.ok(Object.keys(roots).length <= 200, "the persisted map stays capped");
  assert.equal(roots["/cap2/x"], "/cap2", "the other window's fresh identity survives");
  assert.equal(roots["/cap2/y"], "/cap2", "this window's answer is kept");
});

test("a failed write keeps the correction and retries on the next change", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  const worktreeCwd = "/repo/worktrees/wt-quota";
  windowA.rememberCwdProjectRoots([[worktreeCwd, "/old-project"]]);

  writes.fail = true;
  windowA.rememberCwdProjectRoots([[worktreeCwd, "/new-project"]]);
  assert.equal(storedRoots()[worktreeCwd], "/old-project", "the failed write changed nothing on disk");
  assert.equal(
    windowA.recallCwdProjectRoot(worktreeCwd),
    "/new-project",
    "the correction is still readable in memory",
  );

  writes.fail = false;
  // An unrelated answer is a real change, so it also retries the queued one.
  windowA.rememberCwdProjectRoots([["/other/worktrees/wt-after-quota", "/other"]]);
  assert.equal(storedRoots()[worktreeCwd], "/new-project", "the queued correction reached the disk");
  assert.equal(storedRoots()["/other/worktrees/wt-after-quota"], "/other");
});

test("an answer that arrives after another window's write is a real answer, not a poll", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  const windowB = await loadFreshWindow();
  const worktreeCwd = "/repo/worktrees/wt-reverse-order";
  let listenerRan = 0;
  const unsubscribeB = windowB.subscribeCwdProjectRoots(() => { listenerRan += 1; });

  windowB.rememberCwdProjectRoots([[worktreeCwd, "/old-project"]]);
  windowA.rememberCwdProjectRoots([[worktreeCwd, "/new-project"]]);
  assert.equal(storedRoots()[worktreeCwd], "/new-project");

  // B has not consumed A's `storage` event yet, and the server now really
  // answers B with the old value. Comparing against B's stale memory would call
  // that a re-confirmation and skip the write; it is a value the committed
  // snapshot does not carry, so it has to be submitted.
  const before = writes.count;
  windowB.rememberCwdProjectRoots([[worktreeCwd, "/old-project"]]);
  assert.ok(writes.count > before, "the answer is written instead of being mistaken for a poll");
  assert.equal(storedRoots()[worktreeCwd], "/old-project", "the newest answer is on disk");

  // A's queued event still carries the pre-answer payload; the listener has to
  // run for that to be proven, so count its calls and re-read the snapshot: it
  // keeps this window on what it just submitted.
  listenerRan = 0;
  fireStorage(ROOTS_KEY, JSON.stringify({ [worktreeCwd]: "/new-project" }));
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(listenerRan > 0, "the storage listener actually handled the queued event");
  assert.equal(windowB.recallCwdProjectRoot(worktreeCwd), "/old-project");
  unsubscribeB();
});

test("a value reverted to the committed one stops being a queued correction", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  const windowB = await loadFreshWindow();
  const worktreeCwd = "/repo/worktrees/wt-quota-revert";
  let listenerRan = 0;
  const unsubscribeB = windowB.subscribeCwdProjectRoots(() => { listenerRan += 1; });

  windowB.rememberCwdProjectRoots([[worktreeCwd, "/old-project"]]);

  // The write fails, then the server answers the committed value again: that is
  // a revert, not a correction, and it may not stay queued.
  writes.fail = true;
  windowB.rememberCwdProjectRoots([[worktreeCwd, "/temporary-project"]]);
  windowB.rememberCwdProjectRoots([[worktreeCwd, "/old-project"]]);
  writes.fail = false;
  assert.equal(storedRoots()[worktreeCwd], "/old-project");

  // Another window corrects the identity.
  windowA.rememberCwdProjectRoots([[worktreeCwd, "/corrected-project"]]);
  assert.equal(storedRoots()[worktreeCwd], "/corrected-project");

  // B learns an unrelated cwd without consuming the event: the reverted value
  // must not come back as if it were still owed to the snapshot.
  windowB.rememberCwdProjectRoots([["/other/worktrees/wt-quota-revert", "/other"]]);
  assert.equal(
    storedRoots()[worktreeCwd],
    "/corrected-project",
    "a reverted answer never overrides the correction",
  );
  assert.equal(windowB.recallCwdProjectRoot(worktreeCwd), "/corrected-project");

  // Same with the event delivered first. The listener has to run for this
  // branch to be the one under test, so its calls are counted.
  writes.fail = true;
  windowB.rememberCwdProjectRoots([[worktreeCwd, "/temporary-project"]]);
  windowB.rememberCwdProjectRoots([[worktreeCwd, "/corrected-project"]]);
  writes.fail = false;
  windowA.rememberCwdProjectRoots([[worktreeCwd, "/final-project"]]);
  listenerRan = 0;
  fireStorage(ROOTS_KEY, storage.get(ROOTS_KEY));
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(listenerRan > 0, "the storage listener actually adopted the delivered snapshot");
  assert.equal(windowB.recallCwdProjectRoot(worktreeCwd), "/final-project", "the event replaced the reverted value");
  windowB.rememberCwdProjectRoots([["/other/worktrees/wt-quota-revert-2", "/other"]]);
  assert.equal(storedRoots()[worktreeCwd], "/final-project", "the reverted value stays gone after the event");
  assert.equal(windowB.recallCwdProjectRoot(worktreeCwd), "/final-project");
  unsubscribeB();
});

test("a mixed batch evicts the identity it answered first", async () => {
  resetStorage();
  const seed = await loadFreshWindow();
  const oldKeys = Array.from({ length: 200 }, (_, index) => [`/cap3/k${index}`, "/cap3"]);
  seed.rememberCwdProjectRoots(oldKeys);

  const windowA = await loadFreshWindow();
  assert.equal(windowA.recallCwdProjectRoot("/cap3/k0"), "/cap3");

  // One batch, one array: a brand-new identity answered first, then the 200
  // existing ones re-confirmed. The new identity is the least recently
  // remembered one, so it is the one that gets evicted — not a key that was
  // just re-confirmed.
  windowA.rememberCwdProjectRoots([["/cap3/first", "/cap3"], ...oldKeys]);

  const roots = storedRoots();
  assert.equal(roots["/cap3/first"], undefined, "the identity answered first is evicted first");
  assert.equal(roots["/cap3/k0"], "/cap3", "a key re-confirmed after it survives");
  assert.equal(roots["/cap3/k199"], "/cap3", "the identity answered last survives");
  assert.ok(Object.keys(roots).length <= 200, "the persisted map stays capped");
});

test("a local answer that changes a grouping notifies subscribers; a poll does not", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  let notified = 0;
  const unsubscribe = windowA.subscribeCwdProjectRoots(() => { notified += 1; });

  windowA.rememberCwdProjectRoots([["/repo/worktrees/wt-notify", "/repo"]]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(notified, 1, "a new identity re-renders the already-projected rows");

  const writesAfterFirst = writes.count;
  notified = 0;
  windowA.rememberCwdProjectRoots([["/repo/worktrees/wt-notify", "/repo"]]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(notified, 0, "a repeated poll does not re-render");
  assert.equal(writes.count, writesAfterFirst, "and writes nothing");

  windowA.rememberCwdProjectRoots([["/repo/worktrees/wt-notify", "/repo-2"]]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(notified, 1, "a correction notifies: the grouping changed");

  // Adopting another window's write inside a poll is a grouping change too.
  const windowB = await loadFreshWindow();
  const unsubscribeB = windowB.subscribeCwdProjectRoots(() => {});
  windowB.rememberCwdProjectRoots([["/repo/worktrees/wt-notify", "/repo-3"]]);
  notified = 0;
  windowA.rememberCwdProjectRoots([["/elsewhere/wt", "/elsewhere"]]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(windowA.recallCwdProjectRoot("/repo/worktrees/wt-notify"), "/repo-3");
  assert.equal(notified, 1, "adopting the newer snapshot notifies exactly once");
  unsubscribeB();
  unsubscribe();
});

test("an eviction caused by a local answer notifies subscribers", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  windowA.rememberCwdProjectRoots(
    Array.from({ length: 200 }, (_, index) => [`/cap4/k${index}`, "/cap4"]),
  );
  // Drain the seed's own queued notification before subscribing, so the single
  // notification counted below can only come from the eviction.
  await Promise.resolve();
  await Promise.resolve();
  let notified = 0;
  const unsubscribe = windowA.subscribeCwdProjectRoots(() => { notified += 1; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(notified, 0, "the seed notification was drained before this subscription");

  windowA.rememberCwdProjectRoots([["/cap4/new", "/cap4"]]);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(notified, 1, "the evicted identity disappears from the rendered rows");
  assert.equal(windowA.recallCwdProjectRoot("/cap4/k0"), null, "the oldest identity was evicted");
  assert.equal(windowA.recallCwdProjectRoot("/cap4/new"), "/cap4");
  unsubscribe();
});

test("a batch that leaves the bounded snapshot unchanged writes nothing", async () => {
  resetStorage();
  const windowA = await loadFreshWindow();
  const oldKeys = Array.from({ length: 200 }, (_, index) => [`/cap5/k${index}`, "/cap5"]);
  windowA.rememberCwdProjectRoots(oldKeys);
  const stored = storage.get(ROOTS_KEY);
  const writesAfterSeed = writes.count;

  // The sidebar re-sends the whole list on every poll. Here the identity
  // answered first is re-confirmed by the same batch's tail and then trimmed
  // off the end, so the bounded result equals the stored snapshot: writing it
  // again would be a `setItem` per refresh that changes nothing.
  for (let round = 0; round < 2; round += 1) {
    windowA.rememberCwdProjectRoots([["/cap5/first", "/cap5"], ...oldKeys]);
    assert.equal(writes.count, writesAfterSeed, `round ${round}: the unchanged snapshot is not rewritten`);
    assert.equal(storage.get(ROOTS_KEY), stored, `round ${round}: the stored value is untouched`);
  }
  assert.equal(windowA.recallCwdProjectRoot("/cap5/first"), null, "the trimmed identity is not held");
  assert.equal(windowA.recallCwdProjectRoot("/cap5/k0"), "/cap5");
  assert.equal(windowA.recallCwdProjectRoot("/cap5/k199"), "/cap5");
});

test("an answer another window committed loses the position it was queued at", async () => {
  resetStorage();
  const oldKeys = Array.from({ length: 200 }, (_, index) => [`/cap6/k${index}`, "/old"]);
  const corrected = oldKeys.slice(1).map(([cwd]) => [cwd, "/corrected"]);
  const seed = await loadFreshWindow();
  seed.rememberCwdProjectRoots(oldKeys);

  // A keeps 199 corrections queued behind a failing write (private mode): they
  // are owed to the snapshot, so the sweep cannot drop them yet.
  const windowA = await loadFreshWindow();
  writes.fail = true;
  windowA.rememberCwdProjectRoots(corrected);
  writes.fail = false;

  // B commits exactly those corrections, then learns a new identity.
  const windowB = await loadFreshWindow();
  windowB.rememberCwdProjectRoots(corrected);
  windowB.rememberCwdProjectRoots([["/cap6/x", "/cap6"]]);
  assert.equal(storedRoots()["/cap6/x"], "/cap6", "the other window's identity is on disk");

  // A never consumed the event and answers a new identity itself. Its queued
  // corrections are on disk now, so the positions they were queued at must not
  // survive: they would push B's newer identity in front of the eviction line.
  windowA.rememberCwdProjectRoots([["/cap6/y", "/cap6"]]);

  const roots = storedRoots();
  assert.equal(roots["/cap6/x"], "/cap6", "the identity another window committed survives");
  assert.equal(roots["/cap6/y"], "/cap6", "this window's new identity is kept");
  assert.equal(roots["/cap6/k1"], undefined, "the oldest identity is the one evicted");
  assert.ok(Object.keys(roots).length <= 200, "the persisted map stays capped");
  assert.equal(windowA.recallCwdProjectRoot("/cap6/k1"), null, "the eviction is visible to this window");
});
