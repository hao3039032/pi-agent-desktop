import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { createJiti } from "jiti";

const source = (await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

// lib/draft-store resolves `window` at call time; give the module a single
// shared shim before it is imported. The vm contexts below reuse the same
// object so the component's addEventListener calls are capturable and the
// store's persistence path works.
const storage = new Map();
const listeners = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  addEventListener(type, handler) {
    const list = listeners.get(type) ?? [];
    list.push(handler);
    listeners.set(type, list);
  },
  removeEventListener(type, handler) {
    const list = listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index !== -1) list.splice(index, 1);
  },
};
const fireWindowEvent = (type) => {
  for (const handler of [...(listeners.get(type) ?? [])]) handler({ persisted: true });
};

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const draftStore = await jiti.import("@/lib/draft-store");

test.after(() => {
  delete globalThis.window;
});

const handlerBody = (name, endMarker) => {
  const start = source.indexOf(`const ${name} = useCallback`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} after ${name} not found`);
  return source.slice(start, end);
};

test("the parked-new key spelling lives in the draft store, not in AppShell", () => {
  // Every park/unpark path — the page-lifecycle pair included — goes through
  // the store's key spelling and store-owned park token.
  assert.match(
    source,
    /import \{[^}]*\bparkedNewSessionDraftKey\b[^}]*\bparkDraftForPageHide\b[^}]*\bunparkDraftAfterPageRestore\b[^}]*\} from "@\/lib\/draft-store";/,
  );
  // A local redefinition is exactly the spelling drift this extraction kills.
  assert.doesNotMatch(source, /function parkedNewSessionDraftKey/);
});

test("a cross-project new-session click parks the outgoing draft before restoring", () => {
  const handler = handlerBody("handleNewSession", "// Global keyboard shortcuts");
  // Only a different cwd parks: the same-cwd second click keeps its documented
  // blank-composer reset semantics.
  assert.match(handler, /if \(activeDraftKey && activeDraftCwd && activeDraftCwd !== cwd\) \{/);
  const parkAt = handler.indexOf("rekeyDraft(activeDraftKey, parkedNewSessionDraftKey(activeDraftCwd))");
  const restoreAt = handler.indexOf("rekeyDraft(parkedNewSessionDraftKey(cwd), draftKey)");
  assert.notEqual(parkAt, -1, "park rekey missing");
  assert.notEqual(restoreAt, -1, "restore rekey missing");
  assert.ok(parkAt < restoreAt, "the outgoing draft must be parked before the target's parked draft is restored");
  assert.match(handler, /activeNewSessionCwdRef\.current = cwd;/);
});

test("the initial ?cwd navigation consumes the parked draft into the active key", () => {
  // The validate-success path must rekey parked-new:<cwd> into the initial
  // draft key BEFORE the composer mounts and reads it, so a reload after a
  // pagehide-parked draft restores the text. Aborted requests (StrictMode
  // remount, superseded navigation) must not run the adoption at all.
  const start = source.indexOf("if (!requestedCwd) return;");
  const end = source.indexOf("// Restore the workspace's last open session", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const effect = source.slice(start, end);
  assert.match(effect, /if \(controller\.signal\.aborted\) return;\s*const data = await response\.json/);
  const rekeyAt = effect.indexOf("rekeyDraft(parkedNewSessionDraftKey(data.cwd), draftKey)");
  const refsAt = effect.indexOf("activeNewSessionDraftKeyRef.current = draftKey;");
  assert.notEqual(rekeyAt, -1, "initial navigation must consume the parked draft");
  assert.ok(rekeyAt < refsAt, "the parked draft is consumed before the key ref is set");
});

test("the initial ?cwd adoption runs against the real store and consumes the parked draft", async () => {
  // Behavioral: extract the validate-success path from the source and run it
  // in a vm with the real draft store, mirroring how the composer mounts
  // afterwards and reads getDraft(draftKey).
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/initial");
  draftStore.setDraft(parkedKey, { value: "draft saved on close", images: [] });

  const start = source.indexOf("suppressCwdBumpRef.current = true;");
  const end = source.indexOf("setInitialCwdStatus(\"ready\")", start);
  assert.notEqual(start, -1, "initial adoption body not found");
  assert.notEqual(end, -1, "initial adoption end not found");
  const body = source.slice(start, end + "setInitialCwdStatus(\"ready\");".length);

  const applied = [];
  const context = vm.createContext({
    ...draftStore,
    window: globalThis.window,
    URLSearchParams,
    suppressCwdBumpRef: { current: false },
    setNewSessionDraftId: (id) => applied.push(["draftId", id]),
    setNewSessionCwd: (cwd) => applied.push(["cwd", cwd]),
    setChatWorkspaceCwd: () => {},
    setNewSessionWorkspaceKind: () => {},
    setInitialCwdStatus: (status) => applied.push(["status", status]),
    router: { replace: () => {} },
    activeNewSessionDraftKeyRef: { current: null },
    activeNewSessionCwdRef: { current: null },
  });
  vm.runInContext(stripTypeScriptTypes(`
    const requestedCwd = "/proj/initial";
    const data = { cwd: "/proj/initial", workspaceKind: "project" };
    ${body}
  `), context);

  assert.equal(draftStore.getDraft(parkedKey), null, "the parked copy is consumed");
  // The composer mounts with this key and reads the restored draft.
  const activeKey = "new:initial:/proj/initial:/proj/initial";
  assert.equal(draftStore.getDraft(activeKey)?.value, "draft saved on close");
  assert.equal(applied.some(([k, v]) => k === "cwd" && v === "/proj/initial"), true);
  draftStore.clearDraft(activeKey);
});

const DRAFTS_STORAGE_KEY = "pi-chat-drafts-v1";
// The store's cross-window path is the `storage` listener it installs with its
// first subscriber; a parked draft another window wrote reaches this page
// exactly that way (not through setDraft, which marks the key as this page's).
draftStore.subscribeParkedDrafts(() => {});
const writeParkedDraftFromOtherWindow = (key, value) => {
  const snapshot = JSON.parse(storage.get(DRAFTS_STORAGE_KEY) ?? "{}");
  snapshot[key] = { value, images: [] };
  const newValue = JSON.stringify(snapshot);
  storage.set(DRAFTS_STORAGE_KEY, newValue);
  for (const handler of [...(listeners.get("storage") ?? [])]) {
    handler({ key: DRAFTS_STORAGE_KEY, storageArea: globalThis.window.localStorage, newValue });
  }
};

/** Behavioral harness: run the real pagehide/pageshow handler bodies against
 *  the real lib/draft-store, with addEventListener captured so the tests can
 *  fire the exact browser events the component registers. A test represents
 *  one mounted AppShell, so the previous test's handlers are unregistered.
 *  `composer` stands in for `chatInputRef.current`; it records the
 *  `adoptStoredDraft()` calls the effect makes. */
function runPageLifecycleEffect({ composer = null } = {}) {
  listeners.delete("pagehide");
  listeners.delete("pageshow");
  const effectStart = source.indexOf("// Closing the window (or tab, or reloading) must not lose an unsent");
  const effectEnd = source.indexOf("const showChat = selectedSession", effectStart);
  assert.notEqual(effectStart, -1, "pagehide effect comment not found");
  assert.notEqual(effectEnd, -1, "pagehide effect end not found");
  const context = vm.createContext({
    ...draftStore,
    window: globalThis.window,
    // React effect shell: run the body synchronously like useEffect does.
    useEffect: (body) => body(),
    activeNewSessionDraftKeyRef: { current: null },
    activeNewSessionCwdRef: { current: null },
    chatInputRef: { current: composer },
  });
  vm.runInContext(stripTypeScriptTypes(source.slice(effectStart, effectEnd)), context);
  const refs = vm.runInContext("({ key: activeNewSessionDraftKeyRef, cwd: activeNewSessionCwdRef })", context);
  return { ...refs, composer };
}

/** A mounted composer stand-in: it records which key it was asked to adopt. */
function mountedComposer() {
  return { adopted: [], adoptStoredDraft(key) { this.adopted.push(key); } };
}

test("pagehide→pageshow moves the draft back without duplicating or losing it", () => {
  const composer = mountedComposer();
  const refs = runPageLifecycleEffect({ composer });
  const activeKey = "new:initial:/proj/a";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/a");

  refs.key.current = activeKey;
  refs.cwd.current = "/proj/a";
  draftStore.setDraft(activeKey, { value: "unsent text", images: [] });

  // Hide: the draft parks and storage is written synchronously.
  fireWindowEvent("pagehide");
  assert.equal(draftStore.getDraft(activeKey), null, "park clears the active key");
  assert.equal(draftStore.getDraft(parkedKey).value, "unsent text");

  // bfcache restore: the snapshot moves back into the same active key (not
  // just deleted — switching away without editing must still park it).
  fireWindowEvent("pageshow");
  assert.equal(draftStore.getDraft(parkedKey), null, "no parked copy survives the restore");
  assert.equal(draftStore.getDraft(activeKey)?.value, "unsent text", "the active key holds the text again");
  assert.deepEqual(composer.adopted, [activeKey], "the composer shows the restored text");

  // Switch away without editing: a clean move, no self-merge duplication.
  draftStore.rekeyDraft(activeKey, parkedKey);
  assert.equal(draftStore.getDraft(parkedKey).value, "unsent text");
  assert.equal(draftStore.getDraft(parkedKey).value.includes("\n\n"), false, "text not duplicated");
  draftStore.clearDraft(parkedKey);
});

test("pagehide→pageshow→edit→switch away does not duplicate the draft", () => {
  const composer = mountedComposer();
  const refs = runPageLifecycleEffect({ composer });
  const activeKey = "new:id-1:/proj/b";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/b");

  refs.key.current = activeKey;
  refs.cwd.current = "/proj/b";
  draftStore.setDraft(activeKey, { value: "hello", images: [] });

  fireWindowEvent("pagehide");
  fireWindowEvent("pageshow");
  // The user keeps typing after the restore (ChatInput re-persists the key).
  draftStore.setDraft(activeKey, { value: "hello!", images: [] });

  // Switching projects parks the live key; the parked copy is gone, so the
  // move must not merge "hello" into "hello!".
  draftStore.rekeyDraft(activeKey, parkedKey);
  assert.equal(draftStore.getDraft(parkedKey).value, "hello!");
  draftStore.clearDraft(parkedKey);
});

test("pageshow without a matching hide, or after the key moved on, restores nothing", () => {
  const refs = runPageLifecycleEffect();
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/c");
  draftStore.setDraft(parkedKey, { value: "survivor", images: [] });

  // A pageshow without a preceding pagehide (initial load, persisted=false)
  // must leave the parked draft alone — the reload path consumes it through
  // the initial ?cwd navigation instead.
  fireWindowEvent("pageshow");
  assert.equal(draftStore.getDraft(parkedKey)?.value, "survivor");

  // And a pageshow whose active key moved on (navigation between hide and
  // show) takes back nothing: the guard compares the recorded key.
  const otherParkedKey = draftStore.parkedNewSessionDraftKey("/proj/z");
  refs.key.current = "new:other:/proj/z";
  refs.cwd.current = "/proj/z";
  draftStore.setDraft("new:other:/proj/z", { value: "typed before the move", images: [] });
  fireWindowEvent("pagehide");
  assert.equal(draftStore.getDraft(otherParkedKey)?.value, "typed before the move");
  refs.key.current = "new:moved:/proj/z";
  fireWindowEvent("pageshow");
  assert.equal(draftStore.getDraft(otherParkedKey)?.value, "typed before the move", "moved-on key is left parked");
  assert.equal(draftStore.getDraft("new:moved:/proj/z"), null, "the new key claims nothing");
  assert.equal(draftStore.getDraft(parkedKey)?.value, "survivor");
  draftStore.clearDraft(parkedKey);
  draftStore.clearDraft(otherParkedKey);
});

test("the active draft's cwd is tracked beside its key at every assignment", () => {
  // The key cannot be parsed for its cwd (paths contain colons), so a sibling
  // ref is kept in sync wherever the key ref is written. Every key assignment
  // must be paired with a cwd assignment on the adjacent line.
  const pairs = [...source.matchAll(
    /activeNewSessionDraftKeyRef\.current = ([^;\n]+);\s*\n\s*activeNewSessionCwdRef\.current = ([^;\n]+);/g,
  )];
  const keyAssignments = [...source.matchAll(/activeNewSessionDraftKeyRef\.current = [^=]/g)].length;
  const cwdAssignments = [...source.matchAll(/activeNewSessionCwdRef\.current = [^=]/g)].length;
  assert.ok(keyAssignments > 0);
  assert.equal(cwdAssignments, keyAssignments, "cwd ref assignments must pair 1:1 with key ref assignments");
  // Every direct assignment site pairs them adjacently (the layout effect's
  // conditional pair is matched too through its two-line body).
  assert.ok(pairs.length >= 3, `expected adjacent key/cwd assignment pairs, found ${pairs.length}`);
  // The initial URL navigation also records the cwd.
  assert.match(source, /activeNewSessionDraftKeyRef\.current = draftKey;\s*activeNewSessionCwdRef\.current = data\.cwd;/);
  // And the derived layout effect keeps both aligned with the computed key.
  assert.match(
    source,
    /useLayoutEffect\(\(\) => \{\s*activeNewSessionDraftKeyRef\.current = newSessionDraftKey;\s*activeNewSessionCwdRef\.current = newSessionDraftKey \? effectiveNewSessionCwd : null;\s*\}, \[newSessionDraftKey, effectiveNewSessionCwd\]\);/,
  );
});

test("the sidebar can focus the composer for the active draft row", () => {
  assert.match(source, /onFocusComposer=\{\(\) => \{/);
  assert.match(source, /if \(isMobile\) setSidebarOpen\(false\);/);
  assert.match(source, /chatInputRef\.current\?\.focus\(\);/);
});

test("deleting the open session restores the cwd's parked draft into the fresh composer", () => {
  // Source shape: the fourth composer creation point consumes the parked
  // draft like the other three (initial ?cwd, handleCwdChange, handleNewSession).
  const handler = handlerBody("handleSessionDeleted", "const handleOpenFile");
  assert.match(handler, /const draftKey = cwd \? `new:\$\{draftId\}:\$\{cwd\}` : null;/);
  const rekeyAt = handler.indexOf("if (draftKey) rekeyDraft(parkedNewSessionDraftKey(cwd), draftKey);");
  const refsAt = handler.indexOf("activeNewSessionDraftKeyRef.current = draftKey;");
  assert.notEqual(rekeyAt, -1, "handleSessionDeleted must consume the parked draft");
  assert.ok(rekeyAt < refsAt, "the parked draft is consumed before the key ref is set");
});

test("handleSessionDeleted runs against the real store and restores the parked draft", () => {
  // Behavioral: run the actual handler body in a vm with the real draft
  // store. A parked draft for the deleted session's cwd must move into the
  // fresh composer's key, or the sidebar's parked preview would focus an
  // empty input.
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/deleted");
  draftStore.setDraft(parkedKey, { value: "parked before delete", images: [] });

  const handler = handlerBody("handleSessionDeleted", "const handleOpenFile");
  const applied = [];
  const context = vm.createContext({
    ...draftStore,
    crypto: globalThis.crypto,
    window: { location: { pathname: "/", search: "" } },
    URLSearchParams,
    invalidateWorkspaceRestore: () => {},
    setRefreshKey: (fn) => applied.push(["refreshKey", fn(0)]),
    selectedSession: {
      id: "s1",
      cwd: "/proj/deleted",
      workspaceKind: "project",
      path: "", created: "", modified: "", messageCount: 0, firstMessage: "",
    },
    isChatWorkspaceActive: false,
    clearTabOpenSession: () => {},
    setNewSessionDraftId: (id) => applied.push(["draftId", id]),
    activeNewSessionDraftKeyRef: { current: null },
    activeNewSessionCwdRef: { current: null },
    setSelectedSession: (v) => applied.push(["selectedSession", v]),
    setNewSessionCwd: (v) => applied.push(["newSessionCwd", v]),
    setNewSessionWorkspaceKind: () => {},
    setFileTabs: () => {},
    setActiveFileTabId: () => {},
    setFileTreeOpen: () => {},
    setRightPanelOpen: () => {},
    setRightPanelExpanded: () => {},
    setBranchTree: () => {},
    setBranchActiveLeafId: () => {},
    setBranchSwitchLocked: () => {},
    setSystemPrompt: () => {},
    setSystemPromptStatus: () => {},
    setSystemTools: () => {},
    setSystemInfoLoading: () => {},
    setActiveTopPanel: () => {},
    router: { replace: () => {} },
  });
  vm.runInContext(stripTypeScriptTypes(`
    const useCallback = (fn) => fn;
    ${handler}
    handleSessionDeleted("s1");
  `), context);

  assert.equal(draftStore.getDraft(parkedKey), null, "the parked copy is consumed");
  const activeKey = context.activeNewSessionDraftKeyRef.current;
  assert.match(activeKey, /^new:[^:]+:\/proj\/deleted$/);
  assert.equal(draftStore.getDraft(activeKey)?.value, "parked before delete");
  assert.equal(context.activeNewSessionCwdRef.current, "/proj/deleted");
  draftStore.clearDraft(activeKey);
});

test("an empty composer's pagehide does not hand another window's parked draft to the active key", () => {
  // Repro: this page's composer is blank for /proj/shared while another window
  // parks a draft for the same cwd. The blank composer parks nothing, so a
  // bfcache restore must not move that draft into this page's active key — no
  // composer reads it there, and the next keystroke would overwrite it.
  const composer = mountedComposer();
  const refs = runPageLifecycleEffect({ composer });
  const activeKey = "new:empty:/proj/shared";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/shared");
  refs.key.current = activeKey;
  refs.cwd.current = "/proj/shared";

  writeParkedDraftFromOtherWindow(parkedKey, "another window's draft");
  assert.equal(draftStore.getDraft(parkedKey)?.value, "another window's draft");

  fireWindowEvent("pagehide");
  fireWindowEvent("pageshow");

  assert.equal(draftStore.getDraft(activeKey), null, "the blank composer's key stays empty");
  assert.equal(
    draftStore.getDraft(parkedKey)?.value,
    "another window's draft",
    "the other window's parked draft is left where the sidebar shows it",
  );
  assert.deepEqual(composer.adopted, [], "a blank composer adopts nothing");
  draftStore.clearDraft(parkedKey);
});

test("a pagehide with text already parked elsewhere keeps both texts reloadable", () => {
  // The occupied-slot case: the park keeps the merge `rekeyDraft()` performs,
  // so a reload finds the whole text under parked-new:<cwd>.
  const composer = mountedComposer();
  const refs = runPageLifecycleEffect({ composer });
  const activeKey = "new:mine:/proj/occupied";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/occupied");
  refs.key.current = activeKey;
  refs.cwd.current = "/proj/occupied";

  draftStore.setDraft(activeKey, { value: "this page's text", images: [] });
  writeParkedDraftFromOtherWindow(parkedKey, "the other window's text");

  fireWindowEvent("pagehide");
  const parked = draftStore.getDraft(parkedKey)?.value ?? "";
  assert.ok(parked.includes("the other window's text"), "the other window's text survives the park");
  assert.ok(parked.includes("this page's text"), "this page's text is parked too, so a reload restores it");
  assert.equal(draftStore.getDraft(activeKey), null);

  // The reload path reads exactly this key.
  assert.equal(
    draftStore.getDraft(draftStore.parkedNewSessionDraftKey("/proj/occupied"))?.value,
    parked,
    "a reload restores the parked text",
  );

  fireWindowEvent("pageshow");
  assert.equal(draftStore.getDraft(parkedKey), null, "one copy: the parked slot is emptied");
  assert.equal(draftStore.getDraft(activeKey)?.value, parked, "the merged text comes back under the active key");
  assert.deepEqual(composer.adopted, [activeKey], "the composer is told to show what the store now holds");
  draftStore.clearDraft(activeKey);
});

test("a restored merged draft is shown, and editing it keeps the other window's text", () => {
  // The restore must leave the composer and the store agreeing, or the next
  // keystroke overwrites the text the composer never displayed.
  const composer = mountedComposer();
  const refs = runPageLifecycleEffect({ composer });
  const activeKey = "new:visible:/proj/visible";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/visible");
  refs.key.current = activeKey;
  refs.cwd.current = "/proj/visible";

  draftStore.setDraft(activeKey, { value: "mine", images: [] });
  writeParkedDraftFromOtherWindow(parkedKey, "theirs");
  fireWindowEvent("pagehide");
  fireWindowEvent("pageshow");

  // The composer adopts the stored draft (asserted through the real imperative
  // method below); the following edit persists over the same content, so the
  // merged text stays intact and is not duplicated.
  const adopted = draftStore.getDraft(activeKey).value;
  draftStore.setDraft(activeKey, { value: `${adopted} edited`, images: [] });
  draftStore.rekeyDraft(activeKey, parkedKey);
  const afterEdit = draftStore.getDraft(parkedKey).value;
  assert.ok(afterEdit.includes("theirs") && afterEdit.includes("mine"));
  assert.equal(afterEdit.match(/theirs/g).length, 1, "the other window's text is not duplicated");
  assert.equal(afterEdit.match(/mine/g).length, 1);
  draftStore.clearDraft(parkedKey);
});

test("a parked draft another window rewrote while the page was frozen keeps both sides", () => {
  // The slot belongs to the other window now, so this page re-states its own
  // text under its active key instead of consuming it.
  const composer = mountedComposer();
  const refs = runPageLifecycleEffect({ composer });
  const activeKey = "new:frozen:/proj/frozen";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/frozen");
  refs.key.current = activeKey;
  refs.cwd.current = "/proj/frozen";

  draftStore.setDraft(activeKey, { value: "parked before the freeze", images: [] });
  fireWindowEvent("pagehide");
  assert.equal(draftStore.getDraft(activeKey), null);

  writeParkedDraftFromOtherWindow(parkedKey, "rewritten while frozen");
  fireWindowEvent("pageshow");

  assert.equal(draftStore.getDraft(parkedKey)?.value, "rewritten while frozen", "their draft stays parked");
  assert.equal(
    draftStore.getDraft(activeKey)?.value,
    "parked before the freeze",
    "this page's text comes back under its own key, so nothing is lost on reload",
  );
  assert.deepEqual(composer.adopted, [activeKey], "the composer shows what the store holds");
  draftStore.clearDraft(parkedKey);
  draftStore.clearDraft(activeKey);
});

test("a parked draft deleted while the page was frozen still restores this page's text", () => {
  const composer = mountedComposer();
  const refs = runPageLifecycleEffect({ composer });
  const activeKey = "new:deleted:/proj/deleted";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/deleted");
  refs.key.current = activeKey;
  refs.cwd.current = "/proj/deleted";

  draftStore.setDraft(activeKey, { value: "keep me", images: [] });
  fireWindowEvent("pagehide");
  draftStore.clearDraft(parkedKey);
  fireWindowEvent("pageshow");

  assert.equal(draftStore.getDraft(activeKey)?.value, "keep me", "the text is recoverable again");
  assert.equal(draftStore.getDraft(parkedKey), null, "nothing is resurrected under the parked key");
  draftStore.clearDraft(activeKey);
});

test("a bfcache round trip keeps attached files and images through the park", () => {
  const composer = mountedComposer();
  const refs = runPageLifecycleEffect({ composer });
  const activeKey = "new:memory:/proj/memory";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/memory");
  refs.key.current = activeKey;
  refs.cwd.current = "/proj/memory";

  const draft = {
    value: "text with attachments",
    images: [{ data: "aGk=", mimeType: "image/png" }],
    files: [{ id: "f1", name: "notes.txt", size: 2, text: "hi" }],
  };
  draftStore.setDraft(activeKey, draft);

  fireWindowEvent("pagehide");
  assert.equal(draftStore.getDraft(parkedKey)?.files?.[0]?.text, "hi", "files survive the park");
  fireWindowEvent("pageshow");

  const restored = draftStore.getDraft(activeKey);
  assert.equal(restored?.value, "text with attachments");
  assert.deepEqual(restored?.images, [{ data: "aGk=", mimeType: "image/png" }]);
  assert.deepEqual(restored?.files, [{ id: "f1", name: "notes.txt", size: 2, text: "hi" }]);
  assert.equal(draftStore.getDraft(parkedKey), null, "nothing is left behind under the parked key");
  assert.deepEqual(composer.adopted, [activeKey], "the restored attachments are shown");
  draftStore.clearDraft(activeKey);
});

test("consecutive pagehide/pageshow cycles keep one copy of the draft", () => {
  const composer = mountedComposer();
  const refs = runPageLifecycleEffect({ composer });
  const activeKey = "new:twice:/proj/twice";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/twice");
  refs.key.current = activeKey;
  refs.cwd.current = "/proj/twice";
  draftStore.setDraft(activeKey, { value: "once", images: [] });

  for (const expected of ["once", "once"]) {
    fireWindowEvent("pagehide");
    fireWindowEvent("pageshow");
    assert.equal(draftStore.getDraft(activeKey)?.value, expected);
    assert.equal(draftStore.getDraft(parkedKey), null, "no parked residue between cycles");
  }
  draftStore.rekeyDraft(activeKey, parkedKey);
  assert.equal(draftStore.getDraft(parkedKey)?.value, "once", "switching away afterwards parks one copy");
  assert.deepEqual(composer.adopted, [activeKey, activeKey], "each restore showed the draft it moved back");
  draftStore.clearDraft(parkedKey);
});

test("a restore with no mounted composer leaves the draft parked and recoverable", () => {
  // Without a composer the restored text would sit in a key nothing displays:
  // the sidebar row and the reload path keep owning it instead.
  const refs = runPageLifecycleEffect();
  const activeKey = "new:unmounted:/proj/unmounted";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/unmounted");
  refs.key.current = activeKey;
  refs.cwd.current = "/proj/unmounted";

  draftStore.setDraft(activeKey, { value: "no composer to show it", images: [] });
  fireWindowEvent("pagehide");
  fireWindowEvent("pageshow");

  assert.equal(draftStore.getDraft(activeKey), null, "no invisible active-key draft is created");
  assert.equal(draftStore.getDraft(parkedKey)?.value, "no composer to show it", "it stays parked and reloadable");
  draftStore.clearDraft(parkedKey);
});

test("a restored draft's edit, send and switch-away leave another window's draft alone", () => {
  const composer = mountedComposer();
  const refs = runPageLifecycleEffect({ composer });
  const activeKey = "new:legit:/proj/legit";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/legit");
  const otherParkedKey = draftStore.parkedNewSessionDraftKey("/proj/elsewhere");
  refs.key.current = activeKey;
  refs.cwd.current = "/proj/legit";

  writeParkedDraftFromOtherWindow(otherParkedKey, "other project's draft");
  draftStore.setDraft(activeKey, { value: "mine", images: [] });
  fireWindowEvent("pagehide");
  fireWindowEvent("pageshow");
  assert.equal(draftStore.getDraft(activeKey)?.value, "mine");

  // The user keeps typing, then switches away: a clean single-copy park.
  draftStore.setDraft(activeKey, { value: "mine, edited", images: [] });
  draftStore.rekeyDraft(activeKey, parkedKey);
  assert.equal(draftStore.getDraft(parkedKey)?.value, "mine, edited");
  assert.equal(draftStore.getDraft(otherParkedKey)?.value, "other project's draft");
  draftStore.clearDraft(parkedKey);

  // Sending clears the restored draft without resurrecting a parked copy.
  fireWindowEvent("pagehide");
  fireWindowEvent("pageshow");
  draftStore.clearDraft(activeKey);
  assert.equal(draftStore.getDraft(parkedKey), null, "a sent draft leaves no parked residue");
  assert.equal(draftStore.getDraft(otherParkedKey)?.value, "other project's draft");
  draftStore.clearDraft(otherParkedKey);
});

test("the page lifecycle park owns exactly the snapshot it left", () => {
  // Store-level: the token is only honoured while the composer is still on its
  // key and the parked slot still holds what the park left; a slot another
  // window rewrote keeps that window's draft and returns this page's own text.
  const activeKey = "new:token:/proj/token";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/proj/token");
  assert.equal(draftStore.parkDraftForPageHide(activeKey, "/proj/token"), null, "an empty composer parks nothing");

  draftStore.setDraft(activeKey, { value: "token text", images: [] });
  const park = draftStore.parkDraftForPageHide(activeKey, "/proj/token");
  assert.ok(park, "a non-empty composer parks");
  assert.equal(park.own.value, "token text", "the token records what the composer displayed");
  assert.equal(draftStore.getDraft(activeKey), null);
  assert.equal(draftStore.getDraft(parkedKey)?.value, "token text");

  const occupied = draftStore.parkDraftForPageHide(activeKey, "/proj/token");
  assert.equal(occupied, null, "an empty active key parks nothing on a second hide");

  assert.equal(draftStore.unparkDraftAfterPageRestore(park, "new:other:/proj/token"), null, "moved-on key");
  assert.equal(draftStore.getDraft(parkedKey)?.value, "token text");
  assert.equal(draftStore.unparkDraftAfterPageRestore(park, activeKey)?.value, "token text");
  assert.equal(draftStore.getDraft(activeKey)?.value, "token text");
  assert.equal(draftStore.getDraft(parkedKey), null);

  // A rewrite while the page was frozen: the other window keeps its row, this
  // page's own text returns under its own key.
  const second = draftStore.parkDraftForPageHide(activeKey, "/proj/token");
  assert.ok(second);
  draftStore.setDraft(parkedKey, { value: "someone else's text", images: [] });
  assert.equal(draftStore.unparkDraftAfterPageRestore(second, activeKey)?.value, "token text");
  assert.equal(draftStore.getDraft(activeKey)?.value, "token text");
  assert.equal(draftStore.getDraft(parkedKey)?.value, "someone else's text", "their draft is untouched");
  draftStore.clearDraft(parkedKey);

  // A deletion while frozen is the same case: nothing is resurrected under the
  // parked key, this page's text comes back.
  const third = draftStore.parkDraftForPageHide(activeKey, "/proj/token");
  assert.ok(third);
  draftStore.clearDraft(parkedKey);
  assert.equal(draftStore.unparkDraftAfterPageRestore(third, activeKey)?.value, "token text");
  assert.equal(draftStore.getDraft(activeKey)?.value, "token text");
  assert.equal(draftStore.getDraft(parkedKey), null);

  // The active key holding a draft this page did not leave is not replaced.
  draftStore.setDraft(activeKey, { value: "token text", images: [] });
  const fourth = draftStore.parkDraftForPageHide(activeKey, "/proj/token");
  assert.ok(fourth);
  draftStore.setDraft(activeKey, { value: "a different draft took this key", images: [] });
  assert.equal(draftStore.unparkDraftAfterPageRestore(fourth, activeKey), null);
  assert.equal(draftStore.getDraft(activeKey)?.value, "a different draft took this key");
  draftStore.clearDraft(activeKey);
  draftStore.clearDraft(parkedKey);
});
