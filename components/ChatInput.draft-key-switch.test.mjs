import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { createJiti } from "jiti";

// The composer's draft-key layout effect moves the composer's state between
// draft keys. This harness runs the effect body extracted from the component
// source against the real draft store, with the component's refs and state
// setters replaced by stand-ins. It is NOT a React render: no scheduler, no
// passive effects, no reconciliation. It proves which key the effect writes to;
// it cannot prove scheduling or effect-ordering behaviour.
const source = (await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const appShellSource = (await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
  location: { pathname: "/", search: "" },
  addEventListener() {},
  removeEventListener() {},
};

const draftStore = await createJiti(import.meta.url, { tsconfigPaths: true }).import("@/lib/draft-store");

test.after(() => {
  delete globalThis.window;
});

/** The component's `useState` initializers read the stored draft images into
 *  attached-image state; the harness needs the same shape outside the vm. */
const toAttachedImages = (list) => (list ?? []).map((image) => ({ ...image }));

function draftKeyEffectSource() {
  const start = source.indexOf("useLayoutEffect(() => {\n    const previousDraftKey = draftKeyRef.current;");
  assert.notEqual(start, -1, "the draft-key layout effect moved or was renamed");
  const marker = "}, [draftKey, setHashQuery]);";
  const end = source.indexOf(marker, start);
  assert.notEqual(end, -1, "the draft-key layout effect lost its dependency list");
  return source.slice(start, end + marker.length);
}

/**
 * A composer mounted with `draftKey`. The mount state mirrors the component:
 * `useRef(draftKey)` for the key ref and `useState(() => getDraft(draftKey))`
 * for the text/attachments, so the mount run of the effect is the same no-op
 * it is in the browser.
 */
function mountComposer({ draftKey }) {
  const mounted = draftStore.getDraft(draftKey);
  const renders = { value: [mounted?.value ?? ""] };
  const context = vm.createContext({
    ...draftStore,
    draftKey,
    useLayoutEffect: (body) => { context.runDraftKeyEffect = body; },
    draftKeyRef: { current: draftKey },
    valueRef: { current: mounted?.value ?? "" },
    attachedImagesRef: { current: toAttachedImages(mounted?.images) },
    attachedFilesRef: { current: mounted?.files ?? [] },
    imageToDraftImage: (image) => ({ data: image.data, mimeType: image.mimeType }),
    draftImagesToAttachedImages: (list) => (list ?? []).map((image) => ({ ...image })),
    revokeImagePreview: () => {},
    setAttachedFiles: () => {},
    setValue: (next) => renders.value.push(next),
    setAtQuery: () => {},
    setHashQuery: () => {},
    setHistoryMenuOpen: () => {},
    setAttachedImages: () => {},
  });
  vm.runInContext(stripTypeScriptTypes(draftKeyEffectSource()), context);
  // The mounting commit runs the effect once; the key did not change.
  context.runDraftKeyEffect();
  return {
    renders,
    /** The draft key prop changed and the effect re-ran after the commit. */
    switchTo(nextDraftKey, { value: nextValue } = {}) {
      if (nextValue !== undefined) {
        context.valueRef.current = nextValue;
        context.attachedImagesRef.current = [];
      }
      context.draftKey = nextDraftKey;
      context.runDraftKeyEffect();
    },
    /** Typing: the composer's own persistence effect stores the new value
     *  under the current key (it only runs after the key is settled). */
    type(nextValue, images = []) {
      context.valueRef.current = nextValue;
      context.attachedImagesRef.current = images;
      draftStore.setDraft(context.draftKey, { value: nextValue, images });
    },
  };
}

test("AppShell parks the active draft with the store move this test replays", () => {
  // The park paths write parked-new:<cwd> and clear the active key through
  // lib/draft-store's rekeyDraft — the exact call the harness performs below.
  assert.match(appShellSource, /import \{ clearDraft, flushDrafts, parkedNewSessionDraftKey, rekeyDraft \} from "@\/lib\/draft-store";/);
  assert.match(appShellSource, /rekeyDraft\(activeDraftKey, parkedNewSessionDraftKey\(activeDraftCwd\)\)/);
  assert.match(appShellSource, /rekeyDraft\(previousDraftKey, parkedNewSessionDraftKey\(previousDraftCwd\)\)/);
});

test("mounting the composer does not rewrite its own draft key", () => {
  // `useRef(draftKey)` plus the `useState` initializer mean the mount run of
  // the layout effect sees `previousDraftKey === draftKey` and returns early.
  const activeKey = "new:draft-mount:/repo/worktrees/wt0";
  draftStore.setDraft(activeKey, { value: "restored on mount", images: [] });
  const composer = mountComposer({ draftKey: activeKey });
  assert.equal(draftStore.getDraft(activeKey)?.value, "restored on mount");
  assert.deepEqual(composer.renders.value, ["restored on mount"], "the mount value comes from the store, not the effect");
  draftStore.clearDraft(activeKey);
});

test("switching away after the draft was parked does not resurrect the old new:* key", () => {
  // A new-session composer in a worktree without sessions: the sidebar keeps
  // its unsent text as a row through parked-new:<cwd>.
  const activeKey = "new:draft-1:/repo/worktrees/wt2";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/repo/worktrees/wt2");
  const composer = mountComposer({ draftKey: activeKey });
  composer.type("unsent worktree draft");

  // The user picks another project: AppShell parks the outgoing draft…
  draftStore.rekeyDraft(activeKey, parkedKey);
  assert.equal(draftStore.getDraft(parkedKey)?.value, "unsent worktree draft");
  assert.equal(draftStore.getDraft(activeKey), null);

  // …and the composer receives the new project's draft key.
  composer.switchTo("new:draft-2:/projB");

  assert.equal(draftStore.getDraft(activeKey), null, "the parked-from key must stay empty");
  assert.equal(draftStore.getDraft(parkedKey)?.value, "unsent worktree draft");
  assert.equal(draftStore.getDraft("new:draft-2:/projB"), null, "the new composer starts empty");
  assert.deepEqual(composer.renders.value.at(-1), "", "the new composer shows its own draft");
});

test("images in a parked draft are not copied back to the old key either", () => {
  const activeKey = "new:draft-images:/repo/worktrees/wt3";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/repo/worktrees/wt3");
  const image = { data: "aGVsbG8=", mimeType: "image/png" };
  const composer = mountComposer({ draftKey: activeKey });
  // The image lives in the composer state, and the change effect persisted it.
  composer.type("", [image]);

  draftStore.rekeyDraft(activeKey, parkedKey);
  composer.switchTo("new:draft-images-2:/projB");

  assert.equal(draftStore.getDraft(activeKey), null, "no image-only orphan appears");
  assert.deepEqual(draftStore.getDraft(parkedKey)?.images, [image]);
});

test("an ordinary draft-key switch still hands the text to the outgoing session", () => {
  // Per-session drafts have no other owner: the write-back keeps the freshest
  // keystrokes under the session the user is leaving.
  const sessionA = "session-a";
  const sessionB = "session-b";
  draftStore.setDraft(sessionA, { value: "older", images: [] });
  const composer = mountComposer({ draftKey: sessionA });
  composer.type("older");

  composer.switchTo(sessionB, { value: "newest edit" });
  assert.equal(draftStore.getDraft(sessionA)?.value, "newest edit");

  // And back: the target key's stored draft is what the composer shows.
  composer.switchTo(sessionA);
  assert.deepEqual(composer.renders.value.at(-1), "newest edit");
  draftStore.clearDraft(sessionA);
  draftStore.clearDraft(sessionB);
});

test("a parked draft never leaks into the following session's draft", () => {
  // Same shape as the reported flow, ending on a session instead of a new
  // composer: handleSelectSession parks, then the composer swaps in place.
  const activeKey = "new:draft-3:/repo/worktrees/wt4";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/repo/worktrees/wt4");
  const composer = mountComposer({ draftKey: activeKey });
  composer.type("keep me");

  draftStore.rekeyDraft(activeKey, parkedKey);
  composer.switchTo("session-open", { value: "keep me" });

  assert.equal(draftStore.getDraft(parkedKey)?.value, "keep me");
  assert.equal(draftStore.getDraft(activeKey), null);
  assert.equal(draftStore.getDraft("session-open"), null);
  draftStore.clearDraft(parkedKey);
});

test("the real handleCwdChange park leaves no orphan for the in-place composer", () => {
  // The reported flow, wired from the park handler through the extracted
  // effect (still not a React render): the composer sits in a worktree without
  // sessions, the user switches to another project, and AppShell parks the
  // draft through handleCwdChange — which does NOT bump `sessionKey`, so the
  // composer really does see its draftKey prop change and re-runs the effect.
  const activeKey = "new:draft-live:/repo/worktrees/wt5";
  const parkedKey = draftStore.parkedNewSessionDraftKey("/repo/worktrees/wt5");
  const composer = mountComposer({ draftKey: activeKey });
  composer.type("unsent worktree draft");

  const start = appShellSource.indexOf("const handleCwdChange = useCallback((");
  assert.notEqual(start, -1, "handleCwdChange moved");
  const marker = "}, [activeCwd, activeFileTabId, invalidateWorkspaceRestore, newSessionCwd, router, selectedSession, restoreWorkspaceContext]);";
  const end = appShellSource.indexOf(marker, start);
  assert.notEqual(end, -1, "handleCwdChange lost its dependency list");
  const handler = appShellSource.slice(start, end + marker.length);

  const sessionKeyBumps = [];
  const context = vm.createContext({
    ...draftStore,
    useCallback: (fn) => fn,
    workspaceKeyOf: (session) => session.projectRoot ?? session.cwd,
    crypto: globalThis.crypto,
    window: globalThis.window,
    activeCwd: "/repo/worktrees/wt5",
    newSessionCwd: null,
    selectedSession: null,
    activeFileTabId: null,
    activeProjectKeyRef: { current: "keyA" },
    activeNewSessionDraftKeyRef: { current: activeKey },
    activeNewSessionCwdRef: { current: "/repo/worktrees/wt5" },
    suppressCwdBumpRef: { current: false },
    scheduledOpenRef: { current: false },
    router: { replace: () => {} },
    invalidateWorkspaceRestore: () => {},
    restoreWorkspaceContext: () => {},
    setActiveCwd: () => {},
    setNewSessionWorkspaceKind: () => {},
    setNewSessionDraftId: () => {},
    setSelectedSession: () => {},
    setNewSessionCwd: () => {},
    setBranchTree: () => {},
    setBranchActiveLeafId: () => {},
    setBranchSwitchLocked: () => {},
    setSystemPrompt: () => {},
    setSystemPromptStatus: () => {},
    setSystemTools: () => {},
    setSystemInfoLoading: () => {},
    setActiveTopPanel: () => {},
    setFileTabs: () => {},
    setActiveFileTabId: () => {},
    setRightPanelOpen: () => {},
    setSessionKey: (update) => sessionKeyBumps.push(update),
  });
  vm.runInContext(stripTypeScriptTypes(`${handler}\nhandleCwdChange("/projB", "/projB", "keyB", "project");`), context);

  assert.deepEqual(sessionKeyBumps, [], "no remount: the composer swaps keys in place");
  assert.equal(draftStore.getDraft(activeKey), null, "the parked-from key is cleared");
  assert.equal(draftStore.getDraft(parkedKey)?.value, "unsent worktree draft");
  const nextKey = context.activeNewSessionDraftKeyRef.current;
  assert.match(nextKey, /^new:[^:]+:\/projB$/);

  // The composer receives that key as a prop and runs the effect again.
  composer.switchTo(nextKey);
  assert.equal(draftStore.getDraft(activeKey), null, "no orphan new:* copy is written back");
  assert.equal(draftStore.getDraft(parkedKey)?.value, "unsent worktree draft");
});
