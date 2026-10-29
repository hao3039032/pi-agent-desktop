import { APP_PREF_KEYS, getPrefJson } from "./app-prefs";

/**
 * cwd → project root identities the server reported for this browser, kept so
 * a sidebar draft row can still find its project after the data that carried
 * the identity is gone.
 *
 * The gap this closes: a git worktree without sessions has no session row and
 * is only identified through its project's worktree listing
 * (`/api/worktrees`, the selected project's). Once the user switches to
 * another project that listing is replaced, and a parked draft from the
 * worktree fell back to its own path — it became a synthetic project group of
 * its own (basename of the worktree path) and escaped the archived-project
 * hiding, which is keyed by the real project root.
 *
 * Why a cache instead of asking again: re-resolving every parked cwd would be
 * one request per draft, and after a server restart the worktree path is not
 * in the file-access allow-list at all (it is derived from session cwds and
 * project roots), so `/api/worktrees?cwd=<worktree>` is denied. The identity
 * *was* known — the user opened a composer in that directory — so it is kept.
 *
 * Only server answers are stored (`/api/sessions` rows, `/api/worktrees`
 * listings). Nothing is inferred from a path, and this store is display
 * metadata only: it decides which existing project group a row belongs to and
 * therefore whether that project's archived state hides it. It grants no
 * access to the directory — reads, agent starts and worktree operations still
 * pass the server's own authorization.
 *
 * Storage: one bounded map in localStorage, least recently remembered evicted
 * first. Kept separate from the draft snapshot so draft sync/merge rules (and
 * their projection comparison) are untouched.
 *
 * Two windows share the map because they share the parked drafts, so the
 * stored snapshot is the committed authority and memory is a projection of it
 * plus this window's own answers:
 *
 *   - `pending` holds answers whose value the snapshot does not carry (a
 *     correction, a new identity). Only those values may override the
 *     snapshot, and a failed write keeps them so the next real change retries.
 *     An answer that matches the committed snapshot *after* re-reading it is a
 *     re-confirmation (or a revert of an unsaved value), never an override —
 *     that is what keeps a queued correction from resurrecting a reused path's
 *     old project after another window already wrote the new one;
 *   - `observedOrder` is the eviction order: this window's answers in the order
 *     they arrived, pending and re-confirmed together. One list, because a
 *     batch such as "a new identity, then 200 re-confirmed ones" must evict the
 *     new identity first — it was answered first. A pure re-confirmation
 *     carries no value authority and writes nothing;
 *   - an answer is classified only after re-reading the snapshot, and orders
 *     that predate a newer write are dropped, so a poll cannot undo or age out
 *     a correction it never saw;
 *   - a `storage` event ignores its own payload and re-reads the stored
 *     snapshot, because a queued event can predate a correction this window
 *     applied and wrote itself; subscribers are notified after local changes
 *     too, so an already-rendered draft row never keeps a stale grouping;
 *   - nothing is written back from the listener, so windows cannot ping-pong.
 *
 * The read-modify-write of the whole snapshot is not atomic: two windows
 * writing at the same instant resolve last-writer-wins for the *entire*
 * snapshot, so a concurrent write of different keys can be lost. What this
 * module guarantees is narrower and bounded: it never resurrects or reorders an
 * entry merely copied from an older snapshot, and the updates it protects are
 * the ones already visible on disk when it reads before writing.
 */

const MAX_ENTRIES = 200;

/** The readable view: the observed snapshot with this window's own answers
 *  applied. `recallCwdProjectRoot()` reads this. */
const projectRoots = new Map<string, string>();
let hydrated = false;

/** Answers whose value the committed snapshot does not carry. Only these may
 *  override the snapshot, and only these are retried after a failed write. */
const pending = new Map<string, string>();

/** This window's own answers in arrival order, newest last — eviction order.
 *  Pending values and pure re-confirmations share one list so a mixed batch
 *  keeps the order the server answered it in. */
const observedOrder: string[] = [];

/** The snapshot this window last read, order included. Comparing it with the
 *  current snapshot tells whether an observation predates another window's
 *  write. `null` = no readable snapshot observed. */
let observedSnapshot: Map<string, string> | null = null;

/** Parse a stored snapshot. Anything that is not a plain object of non-empty
 *  strings is rejected, so a corrupt or unrelated value can never read as "an
 *  empty map" and wipe the identity of every parked row. */
function readSnapshot(value: unknown): Array<[string, string]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries: Array<[string, string]> = [];
  for (const [cwd, root] of Object.entries(value)) {
    if (cwd && typeof root === "string" && root) entries.push([cwd, root]);
  }
  return entries;
}

/** Merge entries newest-last: an existing key moves to the end, so map order
 *  stays the eviction order. */
function mergeInto(
  target: Map<string, string>,
  entries: Iterable<readonly [string, string]>,
): void {
  for (const [cwd, root] of entries) {
    target.delete(cwd);
    target.set(cwd, root);
  }
}

/** The stored snapshot as an ordered map, or null when nothing readable is
 *  stored (absent, corrupt, an array). */
function readStoredSnapshot(): Map<string, string> | null {
  const entries = readSnapshot(getPrefJson<unknown>(APP_PREF_KEYS.cwdProjectRoots));
  if (!entries) return null;
  const map = new Map<string, string>();
  mergeInto(map, entries);
  return map;
}

/** Drop the oldest entries past `limit`. */
function trim(map: Map<string, string>, limit: number): boolean {
  const overflow = map.size - limit;
  if (overflow <= 0) return false;
  for (const cwd of [...map.keys()].slice(0, overflow)) map.delete(cwd);
  return true;
}

/** Order-sensitive comparison: the order is the eviction order, so two maps
 *  with the same values but a different order are still different snapshots. */
function sameEntries(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  const left = [...a];
  const right = [...b];
  return left.every(([cwd, root], index) => right[index][0] === cwd && right[index][1] === root);
}

/** Order-insensitive comparison: only the groupings matter to a reader, so a
 *  pure recency refresh must not notify the sidebar. */
function sameValues(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [cwd, root] of a) if (b.get(cwd) !== root) return false;
  return true;
}

/** Whether another window wrote the snapshot since this window last read it. A
 *  different order counts: the order is the eviction order. */
function snapshotMoved(disk: Map<string, string> | null): boolean {
  if (observedSnapshot === null) return disk !== null;
  if (disk === null) return true;
  return !sameEntries(observedSnapshot, disk);
}

/** Move `cwd` to the end of the eviction order (it was just answered). */
function touchOrder(cwd: string): void {
  const index = observedOrder.indexOf(cwd);
  if (index !== -1) observedOrder.splice(index, 1);
  observedOrder.push(cwd);
}

/** Drop observations that predate the current snapshot: their order is stale.
 *  Only still-pending values may survive them. */
function dropStaleOrder(): void {
  for (let index = observedOrder.length - 1; index >= 0; index -= 1) {
    if (!pending.has(observedOrder[index])) observedOrder.splice(index, 1);
  }
}

/** The snapshot with this window's answers applied: pending values win, and a
 *  still-current order moves answered keys to the end. When `keepOrder` is
 *  false the order predates the snapshot and is dropped; pending values are
 *  still applied (appended) because they are owed to the snapshot. */
function composeView(disk: Map<string, string> | null, keepOrder: boolean): Map<string, string> {
  const view = new Map<string, string>();
  if (disk) mergeInto(view, disk);
  if (keepOrder) {
    for (const cwd of observedOrder) {
      const root = pending.get(cwd) ?? view.get(cwd);
      if (root === undefined) continue;
      view.delete(cwd);
      view.set(cwd, root);
    }
  }
  for (const [cwd, root] of pending) {
    if (view.get(cwd) === root) continue;
    view.delete(cwd);
    view.set(cwd, root);
  }
  return view;
}

/** Rebuild the readable view and drop bookkeeping for keys that did not fit.
 *  Returns whether a grouping (key or value) changed — a pure order change does
 *  not, and must not notify. */
function recompose(): boolean {
  const view = composeView(observedSnapshot, true);
  trim(view, MAX_ENTRIES);
  for (const cwd of [...pending.keys()]) if (!view.has(cwd)) pending.delete(cwd);
  for (let index = observedOrder.length - 1; index >= 0; index -= 1) {
    if (!view.has(observedOrder[index])) observedOrder.splice(index, 1);
  }
  if (sameEntries(projectRoots, view)) return false;
  const valuesChanged = !sameValues(projectRoots, view);
  projectRoots.clear();
  mergeInto(projectRoots, view);
  return valuesChanged;
}

/** Read the stored snapshot into memory. Returns false when it is unreadable:
 *  the last good map is kept rather than replaced with an empty one. Returns
 *  whether a grouping changed. */
function adoptStoredSnapshot(): boolean {
  const disk = readStoredSnapshot();
  if (!disk) return false;
  // A queued answer the snapshot already carries is no longer unsaved, so drop
  // it *before* the stale-order sweep: it has no value authority left, and its
  // old position must not outlive the value it was waiting for. Otherwise the
  // keys another window has just committed still look pending, keep their
  // superseded order, and would evict that window's newer identity.
  for (const [cwd, root] of [...pending]) if (disk.get(cwd) === root) pending.delete(cwd);
  if (snapshotMoved(disk)) dropStaleOrder();
  observedSnapshot = disk;
  return recompose();
}

function hydrate(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  observedSnapshot = readStoredSnapshot();
  recompose();
}

/** Write the snapshot with this window's own answers applied. An unreadable
 *  stored value is replaced: keeping it would block corrections forever, and
 *  there is nothing in it worth preserving. Returns whether a grouping changed
 *  for the reader. */
function persist(): boolean {
  if (typeof window === "undefined") return false;
  const disk = readStoredSnapshot();
  // Once another window wrote, this window's order predates its entries;
  // applying it would push a fresher identity in front of the eviction line.
  const keepOrder = !snapshotMoved(disk);
  if (!keepOrder) dropStaleOrder();
  const merged = composeView(disk ?? observedSnapshot, keepOrder);
  trim(merged, MAX_ENTRIES);
  const valuesChanged = !sameValues(projectRoots, merged);
  // The bounded result can already equal the stored snapshot — an identity this
  // batch answered first was answered again by the same batch's tail and then
  // trimmed off the end. The sidebar re-sends the whole list on every poll, so
  // writing an identical snapshot would be a `setItem` per refresh that changes
  // nothing. An unreadable snapshot is still replaced (there is nothing to
  // keep), so a corrupt value cannot block corrections.
  if (!disk || !sameEntries(disk, merged)) {
    try {
      window.localStorage.setItem(APP_PREF_KEYS.cwdProjectRoots, JSON.stringify(Object.fromEntries(merged)));
    } catch {
      // Quota / private mode. Keep `pending` so the next real change retries
      // instead of letting the correction disappear.
      return false;
    }
  }
  pending.clear();
  observedOrder.length = 0;
  // The write is the authority this window now knows: adopting it makes a stale
  // local copy stop grouping a draft wrongly.
  observedSnapshot = merged;
  projectRoots.clear();
  mergeInto(projectRoots, merged);
  return valuesChanged;
}

type CwdProjectRootsListener = () => void;
const listeners = new Set<CwdProjectRootsListener>();
let notifyQueued = false;

function scheduleNotify(): void {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const listener of [...listeners]) listener();
  });
}

let storageListenerInstalled = false;
function installStorageListener(): void {
  if (storageListenerInstalled || typeof window === "undefined") return;
  storageListenerInstalled = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key !== APP_PREF_KEYS.cwdProjectRoots) return;
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (!event.newValue) return; // key removed: not a set of identities
    hydrate();
    // Deliberately ignore `event.newValue` and read the stored snapshot: a
    // queued event can predate a correction this window already applied and
    // wrote, and its payload would revert that correction. Nothing is written
    // back here, so windows cannot ping-pong; subscribers re-render instead.
    adoptStoredSnapshot();
    scheduleNotify();
  });
}

/** Subscribe to identity changes (microtask-debounced): another window's write
 *  as well as this window's own answer that changed a grouping. Read the current
 *  map through `recallCwdProjectRoot()` inside the listener. Installing the
 *  first listener also starts watching `storage`. */
export function subscribeCwdProjectRoots(listener: CwdProjectRootsListener): () => void {
  listeners.add(listener);
  installStorageListener();
  return () => {
    listeners.delete(listener);
  };
}

/** Record server-reported cwd → project root pairs. Incomplete answers are
 *  skipped rather than remembered as "its own project"; the real session list
 *  fills `projectRoot`, so this only guards a defensive/partial shape. Only a
 *  value the committed snapshot does not carry (or an eviction) writes storage —
 *  a repeated confirmation only refreshes the eviction order, and the sidebar
 *  calls this on every poll. */
export function rememberCwdProjectRoots(
  entries: Iterable<readonly [string | null | undefined, string | null | undefined]>,
): void {
  if (typeof window === "undefined") return;
  hydrate();
  const answers: Array<[string, string]> = [];
  for (const [cwd, root] of entries) {
    if (!cwd || !root) continue;
    answers.push([cwd, root]);
  }
  if (answers.length === 0) return;

  // Classify against the committed snapshot, re-read now: an answer that agrees
  // with a write another window just made is a re-confirmation of the *new*
  // value, not a repeat of the old one this window still has in memory.
  let changed = adoptStoredSnapshot();

  let queued = false;
  for (const [cwd, root] of answers) {
    if (root === observedSnapshot?.get(cwd)) {
      // The snapshot already carries this. Reordering must never become
      // authority over a value another window writes later.
      pending.delete(cwd);
      touchOrder(cwd);
      continue;
    }
    if (pending.get(cwd) !== root) {
      pending.set(cwd, root);
      queued = true;
    }
    touchOrder(cwd);
  }
  if (recompose()) changed = true;
  // Only a value the snapshot does not carry reaches the disk; a pure poll
  // (including the whole-map re-confirmation) writes nothing.
  if (queued && persist()) changed = true;
  // Notify after local changes too: the sidebar projects draft rows during
  // render and records answers in a passive effect, so without this an
  // already-rendered row could keep the grouping the cache just replaced.
  if (changed) scheduleNotify();
}

/** The last project root the server reported for `cwd`, or null when this
 *  browser never resolved it. */
export function recallCwdProjectRoot(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  hydrate();
  return projectRoots.get(cwd) ?? null;
}
