import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const storage = new Map();
const windowListeners = new Map();
globalThis.window = {
  localStorage: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); },
    removeItem(key) { storage.delete(key); },
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
const dispatchStorage = (event) => {
  for (const handler of [...(windowListeners.get("storage") ?? [])]) handler(event);
};

const {
  clearDraft,
  flushDrafts,
  getDraft,
  listParkedNewSessionDrafts,
  parkedNewSessionDraftKey,
  restoreDraftSubmission,
  rekeyDraft,
  setDraft,
  subscribeParkedDrafts,
} = await createJiti(import.meta.url, { tsconfigPaths: true })
  .import("./draft-store.ts");

const flushMicrotasks = () => new Promise((resolve) => queueMicrotask(resolve));

after(() => {
  delete globalThis.window;
});

test("the persistence cap keeps the most recently edited drafts", async () => {
  for (let index = 0; index < 41; index++) {
    setDraft(`session-${index}`, { value: `draft-${index}`, images: [] });
  }
  setDraft("session-0", { value: "edited-most-recently", images: [] });

  await new Promise((resolve) => setTimeout(resolve, 300));
  const persisted = JSON.parse(storage.get("pi-chat-drafts-v1"));
  assert.equal(Object.keys(persisted).length, 40);
  assert.equal(persisted["session-0"].value, "edited-most-recently");
  assert.equal(persisted["session-1"], undefined);
});

const file = (id, name, text) => ({ id, name, size: text.length, text });

test("attached files belong to the draft they were attached in and never reach storage", async () => {
  setDraft("chat-a", { value: "", images: [], files: [file("f1", "notes.md", "SECRET A")] });
  assert.equal(getDraft("chat-b"), null);
  assert.deepEqual(getDraft("chat-a").files.map((f) => f.name), ["notes.md"]);
  // A draft holding only a file is not empty.
  setDraft("chat-a", { value: "", images: [], files: [file("f1", "notes.md", "SECRET A")] });
  assert.ok(getDraft("chat-a"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const persisted = JSON.parse(storage.get("pi-chat-drafts-v1"));
  assert.equal(JSON.stringify(persisted).includes("SECRET A"), false);
  clearDraft("chat-a");
  assert.equal(getDraft("chat-a"), null);
});

test("a submission restored with file markup comes back as attachments, not text", () => {
  const message = 'look\n\n<attached_file name="a.txt">\nBODY\n</attached_file>';
  const restored = restoreDraftSubmission("chat-r", message);
  assert.equal(restored.value, "look");
  assert.deepEqual(restored.files.map((f) => [f.name, f.text]), [["a.txt", "BODY"]]);
  clearDraft("chat-r");
});

test("parkedNewSessionDraftKey spells the key every surface shares", () => {
  assert.equal(parkedNewSessionDraftKey("/home/me/proj"), "parked-new:/home/me/proj");
  // Windows-style paths keep their colons; the cwd is never parsed back out.
  assert.equal(parkedNewSessionDraftKey("C:\\work\\proj"), "parked-new:C:\\work\\proj");
});

test("listParkedNewSessionDrafts enumerates only parked keys with cloned drafts", () => {
  setDraft(parkedNewSessionDraftKey("/p/a"), { value: "a", images: [] });
  setDraft(parkedNewSessionDraftKey("/p/b"), { value: "b", images: [] });
  setDraft("new:id-1:/p/c", { value: "active", images: [] });
  setDraft("session-9", { value: "not parked", images: [] });

  const listed = listParkedNewSessionDrafts();
  assert.deepEqual(listed.map((entry) => entry.cwd).sort(), ["/p/a", "/p/b"]);
  assert.equal(listed.every((entry) => entry.draft.value === entry.cwd.slice(3)), true);

  // Cloned: mutating the returned draft cannot touch the store.
  const first = listed.find((entry) => entry.cwd === "/p/a");
  first.draft.value = "mutated";
  assert.equal(getDraft(parkedNewSessionDraftKey("/p/a")).value, "a");

  clearDraft(parkedNewSessionDraftKey("/p/a"));
  clearDraft(parkedNewSessionDraftKey("/p/b"));
  clearDraft("new:id-1:/p/c");
  clearDraft("session-9");
  assert.deepEqual(listParkedNewSessionDrafts().filter((entry) => entry.cwd.startsWith("/p/")), []);
});

test("subscribeParkedDrafts notifies on parked-key changes only, debounced per microtask", async () => {
  const calls = [];
  const unsubscribe = subscribeParkedDrafts(() => calls.push(Date.now()));
  assert.equal(windowListeners.get("storage")?.length >= 1, true);

  // Active-key keystrokes never notify.
  setDraft("new:id-1:/p/c", { value: "typing", images: [] });
  await flushMicrotasks();
  assert.equal(calls.length, 0);

  // Parked add, edit and remove each notify…
  const parkedKey = parkedNewSessionDraftKey("/p/sub");
  setDraft(parkedKey, { value: "one", images: [] });
  setDraft(parkedKey, { value: "two", images: [] });
  await flushMicrotasks();
  assert.equal(calls.length, 1, "one debounced notification for both writes");
  clearDraft(parkedKey);
  await flushMicrotasks();
  assert.equal(calls.length, 2);

  // …and an empty-draft write that removes the key counts as a change.
  setDraft(parkedKey, { value: "back", images: [] });
  await flushMicrotasks();
  assert.equal(calls.length, 3);
  setDraft(parkedKey, { value: "", images: [] });
  await flushMicrotasks();
  assert.equal(calls.length, 4);
  assert.equal(getDraft(parkedKey), null);

  // Unsubscribed: no further notifications.
  unsubscribe();
  setDraft(parkedKey, { value: "silent", images: [] });
  await flushMicrotasks();
  assert.equal(calls.length, 4);
  clearDraft(parkedKey);
});

test("subscribeParkedDrafts reads parked keys another window persisted", async () => {
  const calls = [];
  const unsubscribe = subscribeParkedDrafts(() => calls.push(calls.length));
  await flushMicrotasks();
  assert.equal(calls.length, 0);

  // Another window wrote the shared storage key with a new parked draft.
  const otherWindowValue = JSON.stringify({
    "parked-new:/shared/proj": { value: "from window B", images: [] },
    "session-x": { value: "not parked", images: [] },
  });
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: otherWindowValue });
  await flushMicrotasks();
  assert.equal(calls.length, 1);
  assert.deepEqual(
    listParkedNewSessionDrafts().map((entry) => [entry.cwd, entry.draft.value]),
    [["/shared/proj", "from window B"]],
  );

  // This window's fresher copy is never overwritten by a later cross-write.
  // (The local edit itself notifies once — calls goes 1 → 2.)
  setDraft(parkedNewSessionDraftKey("/shared/proj"), { value: "local edit", images: [] });
  await flushMicrotasks();
  assert.equal(calls.length, 2);
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: otherWindowValue });
  await flushMicrotasks();
  assert.equal(calls.length, 2, "cross-write of a known key stays silent");
  assert.equal(getDraft(parkedNewSessionDraftKey("/shared/proj")).value, "local edit");

  // Unrelated storage keys are ignored entirely.
  dispatchStorage({ key: "pi-theme", newValue: "dark" });
  await flushMicrotasks();
  assert.equal(calls.length, 2);

  clearDraft(parkedNewSessionDraftKey("/shared/proj"));
  unsubscribe();
});

const snapshotOf = (entries) => JSON.stringify(Object.fromEntries(entries));

async function withParkedListener() {
  const calls = [];
  const unsubscribe = subscribeParkedDrafts(() => calls.push(calls.length));
  await flushMicrotasks();
  return { calls, unsubscribe, done: () => unsubscribe() };
}

test("remote parked updates and deletes sync once the local copy is committed", async () => {
  const parkedKey = parkedNewSessionDraftKey("/sync/proj");
  const { calls, done } = await withParkedListener();

  // Local committed copy (persistNow clears the dirty flag).
  setDraft(parkedKey, { value: "v1", images: [] });
  flushDrafts();
  await flushMicrotasks();
  const baselineCalls = calls.length;

  // Remote update wins while the local copy is clean.
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([[parkedKey, { value: "v2 from B", images: [] }]]) });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey).value, "v2 from B");
  assert.equal(calls.length, baselineCalls + 1, "the update notifies subscribers");

  // Remote delete removes the committed copy…
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([]) });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey), null);
  assert.equal(calls.length, baselineCalls + 2, "the delete notifies subscribers");

  // …and a later persist of an unrelated active key must not resurrect it.
  setDraft("new:id-1:/sync/proj", { value: "active typing", images: [] });
  flushDrafts();
  const persisted = JSON.parse(storage.get("pi-chat-drafts-v1"));
  assert.equal(parkedKey in persisted, false, "the deleted parked key is not resurrected");
  assert.equal(listParkedNewSessionDrafts().some((entry) => entry.cwd === "/sync/proj"), false);
  clearDraft("new:id-1:/sync/proj");
  done();
});

test("unsaved local parked edits survive remote updates and deletes", async () => {
  const parkedKey = parkedNewSessionDraftKey("/dirty/proj");
  const { calls, done } = await withParkedListener();

  setDraft(parkedKey, { value: "local", images: [] });
  await flushMicrotasks();
  const baselineCalls = calls.length;

  // Remote update while the local edit is still unsaved: local wins.
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([[parkedKey, { value: "remote", images: [] }]]) });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey).value, "local");
  assert.equal(calls.length, baselineCalls, "a dirty key does not churn");

  // Remote delete while unsaved: the draft must not vanish under the user.
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([]) });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey)?.value, "local");

  // Once committed, the same delete syncs.
  flushDrafts();
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([]) });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey), null);
  done();
});

test("malformed snapshots and other storage areas never touch local drafts", async () => {
  const parkedKey = parkedNewSessionDraftKey("/odd/proj");
  const { done } = await withParkedListener();
  setDraft(parkedKey, { value: "keep", images: [] });
  flushDrafts();

  // Malformed JSON, numbers and null newValue are ignored entirely.
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: "{not json" });
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: "42" });
  // A null newValue (whole-key removal) is out of scope: keep local data.
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: null });
  // Another origin's storage area must not leak into this one.
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([]), storageArea: { getItem: () => null } });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey)?.value, "keep");

  // An entry with the wrong shape is skipped without breaking the loop.
  dispatchStorage({
    key: "pi-chat-drafts-v1",
    newValue: snapshotOf([
      [parkedNewSessionDraftKey("/odd/broken"), { value: 42, images: [] }],
      [parkedKey, { value: "still keep", images: [] }],
    ]),
  });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey).value, "still keep");
  assert.equal(getDraft(parkedNewSessionDraftKey("/odd/broken")), null);
  clearDraft(parkedKey);
  done();
});

test("an array snapshot is not an empty draft map and never mirror-deletes", async () => {
  const parkedKey = parkedNewSessionDraftKey("/arr/proj");
  const { done } = await withParkedListener();
  setDraft(parkedKey, { value: "keep", images: [] });
  flushDrafts();

  // `JSON.parse("[]")` is an object; treating it as an empty map would read
  // as "the other window deleted every parked key" and wipe local drafts.
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: "[]" });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey)?.value, "keep", "an array is not a snapshot");

  // An empty OBJECT is a legitimate "no drafts" snapshot and still syncs.
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: "{}" });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey), null, "an empty map is a real delete");
  done();
});

test("remote image swaps with the same count are adopted, not stuck", async () => {
  const parkedKey = parkedNewSessionDraftKey("/img/proj");
  const { calls, done } = await withParkedListener();

  setDraft(parkedKey, { value: "hi", images: [{ data: "AAAA", mimeType: "image/png" }] });
  flushDrafts();
  await flushMicrotasks();
  const baselineCalls = calls.length;

  // Same text, same image count, different bytes: the old length-only check
  // mistook this for "no change" and kept the stale image forever.
  dispatchStorage({
    key: "pi-chat-drafts-v1",
    newValue: snapshotOf([[parkedKey, { value: "hi", images: [{ data: "BBBB", mimeType: "image/png" }] }]]),
  });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey).images[0].data, "BBBB");
  assert.equal(calls.length, baselineCalls + 1, "the swap notifies subscribers");

  // Once adopted, this window's persist must write the new bytes back.
  flushDrafts();
  const persisted = JSON.parse(storage.get("pi-chat-drafts-v1"));
  assert.equal(persisted[parkedKey].images[0].data, "BBBB");

  // Identical content (projection-equal) stays silent.
  dispatchStorage({
    key: "pi-chat-drafts-v1",
    newValue: snapshotOf([[parkedKey, { value: "hi", images: [{ data: "BBBB", mimeType: "image/png" }] }]]),
  });
  await flushMicrotasks();
  assert.equal(calls.length, baselineCalls + 1, "projection-equal write is silent");
  clearDraft(parkedKey);
  done();
});

test("memory-only drafts (oversized images, files) survive remote updates and deletes", async () => {
  const big = "A".repeat(600_000); // 450 KB decoded: filtered out of every persist
  const parkedKey = parkedNewSessionDraftKey("/big/proj");
  const { calls, done } = await withParkedListener();

  setDraft(parkedKey, { value: "hi", images: [{ data: big, mimeType: "image/png" }] });
  flushDrafts();
  await flushMicrotasks();
  const baselineCalls = calls.length;

  // The persisted snapshot lost the image; adopting it would delete the only
  // copy. Both the update…
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([[parkedKey, { value: "hi", images: [] }]]) });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey).images.length, 1, "the memory-only image survives a remote update");
  // …and a full remote delete must keep it.
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([]) });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey).images.length, 1, "the memory-only image survives a remote delete");
  assert.equal(calls.length, baselineCalls, "memory-only keys do not churn");

  // Attached text files never reach storage either — same protection.
  const fileKey = parkedNewSessionDraftKey("/files/proj");
  setDraft(fileKey, { value: "v1", images: [], files: [file("f1", "a.md", "ONLY COPY")] });
  flushDrafts();
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([[fileKey, { value: "v2 from B", images: [] }]]) });
  await flushMicrotasks();
  assert.equal(getDraft(fileKey).value, "v1");
  assert.deepEqual(getDraft(fileKey).files.map((f) => f.name), ["a.md"]);
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([]) });
  await flushMicrotasks();
  assert.equal(getDraft(fileKey)?.value, "v1", "the files draft survives a remote delete");

  // Once the draft becomes fully persistable, sync resumes.
  setDraft(parkedKey, { value: "now small", images: [] });
  flushDrafts();
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([]) });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey), null, "persistable again → delete syncs");
  clearDraft(fileKey);
  done();
});

test("a failed persist (quota) keeps local protection against remote deletes", async () => {
  const parkedKey = parkedNewSessionDraftKey("/quota/proj");
  const { done } = await withParkedListener();
  const originalSetItem = window.localStorage.setItem;

  setDraft(parkedKey, { value: "local", images: [] });
  // Quota / private mode: the write throws and is swallowed. The dirty flag
  // must survive, or another window's snapshot could delete the only copy.
  window.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  flushDrafts();
  window.localStorage.setItem = originalSetItem;

  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([]) });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey)?.value, "local", "an unpersisted edit survives a remote delete");

  // A successful persist commits the copy; the same delete then syncs.
  flushDrafts();
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([]) });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey), null);
  done();
});

test("a local delete tombstone resists an older remote snapshot", async () => {
  const parkedKey = parkedNewSessionDraftKey("/tomb/proj");
  const { done } = await withParkedListener();

  setDraft(parkedKey, { value: "v1", images: [] });
  flushDrafts();
  // Deleted locally, not yet persisted: the tombstone is dirty.
  clearDraft(parkedKey);

  // An older snapshot (written before the delete) still carries the key —
  // it must not resurrect the deleted draft.
  dispatchStorage({ key: "pi-chat-drafts-v1", newValue: snapshotOf([[parkedKey, { value: "v1", images: [] }]]) });
  await flushMicrotasks();
  assert.equal(getDraft(parkedKey), null, "the dirty tombstone blocks resurrection");

  // After the tombstone is persisted, it stays gone.
  flushDrafts();
  const persisted = JSON.parse(storage.get("pi-chat-drafts-v1"));
  assert.equal(parkedKey in persisted, false);
  done();
});

test("flushDrafts writes synchronously without waiting for the debounce", () => {
  setDraft(parkedNewSessionDraftKey("/p/flush"), { value: "urgent", images: [] });
  // No 250ms wait: the write is already in storage.
  flushDrafts();
  const persisted = JSON.parse(storage.get("pi-chat-drafts-v1"));
  assert.equal(persisted[parkedNewSessionDraftKey("/p/flush")].value, "urgent");
  clearDraft(parkedNewSessionDraftKey("/p/flush"));

  // Without a window it is a no-op, not a throw (server-side imports).
  const windowRef = globalThis.window;
  delete globalThis.window;
  flushDrafts();
  globalThis.window = windowRef;
});

test("rekeyDraft parks and restores without duplicating the draft", () => {
  const parkedKey = parkedNewSessionDraftKey("/p/rekey");
  const activeKey = "new:id-9:/p/rekey";

  setDraft(activeKey, { value: "composed", images: [] });
  rekeyDraft(activeKey, parkedKey);
  assert.equal(getDraft(activeKey), null);
  assert.equal(getDraft(parkedKey).value, "composed");

  const restored = rekeyDraft(parkedKey, "new:id-10:/p/rekey");
  assert.equal(getDraft(parkedKey), null);
  assert.equal(restored.value, "composed");
  clearDraft("new:id-10:/p/rekey");
});
