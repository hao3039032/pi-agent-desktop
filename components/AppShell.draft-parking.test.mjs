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
const draftStore = await jiti.import("../lib/draft-store.ts");

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
  assert.match(source, /import \{ clearDraft, flushDrafts, parkedNewSessionDraftKey, rekeyDraft \} from "@\/lib\/draft-store";/);
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

/** Behavioral harness: run the real pagehide/pageshow handler bodies against
 *  the real lib/draft-store, with addEventListener captured so the tests can
 *  fire the exact browser events the component registers. */
function runPageLifecycleEffect() {
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
  });
  vm.runInContext(stripTypeScriptTypes(source.slice(effectStart, effectEnd)), context);
  return vm.runInContext("({ key: activeNewSessionDraftKeyRef, cwd: activeNewSessionCwdRef })", context);
}

test("pagehide→pageshow moves the draft back without duplicating or losing it", () => {
  const refs = runPageLifecycleEffect();
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

  // Switch away without editing: a clean move, no self-merge duplication.
  draftStore.rekeyDraft(activeKey, parkedKey);
  assert.equal(draftStore.getDraft(parkedKey).value, "unsent text");
  assert.equal(draftStore.getDraft(parkedKey).value.includes("\n\n"), false, "text not duplicated");
  draftStore.clearDraft(parkedKey);
});

test("pagehide→pageshow→edit→switch away does not duplicate the draft", () => {
  const refs = runPageLifecycleEffect();
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
  refs.key.current = "new:other:/proj/z";
  refs.cwd.current = "/proj/z";
  fireWindowEvent("pagehide");
  refs.key.current = "new:moved:/proj/z";
  fireWindowEvent("pageshow");
  assert.equal(draftStore.getDraft(parkedKey)?.value, "survivor", "moved-on key is left parked");
  draftStore.clearDraft(parkedKey);
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
