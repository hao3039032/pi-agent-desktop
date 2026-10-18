import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";
import ts from "typescript";

const sources = Object.fromEntries(["ChatWindow", "ChatInput", "AppShell"].map((name) => [name,
  readFileSync(new URL(`./${name}.tsx`, import.meta.url), "utf8"),
]));
function callback(component, name, context) {
  const source = ts.createSourceFile(`${component}.tsx`, sources[component], ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  return new Script(ts.transpileModule(`(${find(source).getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function dropContext() {
  const writes = [];
  return {
    writes, chatOnly: false, cwd: "/project", sessionBusy: false,
    dropBusyRef: { current: false }, dropGenerationRef: { current: 0 }, sessionIdRef: { current: "A" },
    chatInputRef: { current: Object.fromEntries(["insertText", "focus", "addImages"].map((key) => [key, () => writes.push(key)])) },
    addNotice: () => writes.push("notice"), onProjectFilesImported: () => writes.push("refresh"), t: (key) => key,
    MAX_ATTACHED_IMAGES: 10, MAX_ATTACHED_IMAGE_BYTES: 100, MAX_ATTACHED_IMAGE_SELECTION_BYTES: 1000,
    getFileName: (path) => path, formatDroppedPathsForComposer: (paths) => paths.join(" "),
    buildFileAtMentionsText: (paths) => paths.join(" "), encodeFilePathForApi: (path) => path,
    base64ToImageFile: () => ({}),
  };
}
function leaveAndReturn(context) {
  context.dropGenerationRef.current += 2;
  // Simulate another import already running in the returned session.
  context.dropBusyRef.current = true;
}

test("drop generation invalidates on session/workspace changes and unmount", () => {
  assert.match(sources.ChatWindow, /useLayoutEffect\(\(\) => \(\) => \{\s*dropGenerationRef.current \+= 1;\s*dropBusyRef.current = false;\s*\}, \[session\?\.id, session\?\.cwd, newSessionDraftKey, newSessionCwd, chatOnly\]\)/);
  assert.match(sources.ChatInput, /useLayoutEffect\(\(\) => \(\) => \{\s*imageReadGenerationRef.current \+= 1;\s*pendingImageCountRef.current = 0;\s*\}, \[draftKey, cwd, chatOnly\]\)/);
});

for (const fails of [false, true]) {
  test(`browser import ignores stale ${fails ? "errors" : "mentions and notices"} after A -> B -> A`, async () => {
    const pending = deferred();
    const context = { ...dropContext(), importDroppedProjectFiles: () => pending.promise };
    callback("ChatWindow", "importProjectFiles", context)([{}]);
    leaveAndReturn(context);
    if (fails) pending.reject(new Error("old error"));
    else pending.resolve({ mentionText: "@old", uploaded: ["old"], skipped: [], rejected: [], errors: [] });
    await flush();
    assert.deepEqual(context.writes, []);
    assert.equal(context.dropBusyRef.current, true, "old finally must not unlock the new import");
  });
}

for (const step of ["describe", "images", "import"]) {
  for (const fails of [false, true]) {
    test(`native ${step} ignores stale ${fails ? "rejection" : "completion"}`, async () => {
      const pending = deferred();
      const items = [{ kind: "file", path: "/image", imageMime: "image/png", size: 1 }, { kind: "file", path: "/file" }];
      const context = { ...dropContext(),
        describeDroppedPaths: () => step === "describe" ? pending.promise : Promise.resolve(items),
        readDesktopImageAttachments: () => step === "images" ? pending.promise : Promise.resolve([]),
        importLocalFiles: () => pending.promise,
      };
      callback("ChatWindow", "handleDesktopDropPaths", context)(["/file"]);
      await flush();
      context.writes.length = 0;
      leaveAndReturn(context);
      if (fails) pending.reject(new Error("old error"));
      else pending.resolve(step === "describe" ? items : step === "images" ? [] : { status: 200, data: { uploaded: ["/file"] } });
      await flush();
      assert.deepEqual(context.writes, []);
      assert.equal(context.dropBusyRef.current, true);
    });
  }
}

test("current browser import still inserts mentions, refreshes the explorer and reports success", async () => {
  const context = { ...dropContext(), importDroppedProjectFiles: async () => ({ mentionText: "@file", uploaded: ["file"], skipped: [], errors: [], rejected: [] }) };
  callback("ChatWindow", "importProjectFiles", context)([{}]);
  await flush();
  assert.deepEqual(context.writes, ["insertText", "focus", "refresh", "notice"]);
  assert.equal(context.dropBusyRef.current, false);
});

for (const generations of [0, 1, 2]) {
  test(`image compression ${generations ? `discards stale generation +${generations}` : "attaches in the current composer"}`, async () => {
    const pending = deferred();
    const added = [], revoked = [];
    const context = {
      compact: false, MAX_ATTACHED_IMAGES: 10, MAX_ATTACHED_IMAGE_BYTES: 100,
      attachedImagesRef: { current: [] }, pendingImageCountRef: { current: 0 }, imageReadGenerationRef: { current: 0 },
      compressImageFile: () => pending.promise, URL: { createObjectURL: () => "blob:preview" },
      appendAttachedImages: (images) => added.push(...images), revokeImagePreview: (image) => revoked.push(image),
    };
    const running = callback("ChatInput", "processImageFiles", context)([{ type: "image/png", size: 1 }]);
    context.imageReadGenerationRef.current += generations;
    if (generations) context.pendingImageCountRef.current = 3;
    pending.resolve({ data: "abc", mimeType: "image/png" });
    await running;
    assert.equal(added.length, generations ? 0 : 1);
    assert.equal(revoked.length, generations ? 1 : 0);
    assert.equal(context.pendingImageCountRef.current, generations ? 3 : 0);
  });
}

test("AppShell connects composer imports to the FileExplorer refresh key", () => {
  assert.match(sources.AppShell, /<ChatWindow[\s\S]*?onProjectFilesImported=\{\(\) => setExplorerRefreshKey\(\(key\) => key \+ 1\)\}/);
  assert.match(sources.AppShell, /<FileExplorer[\s\S]*?refreshKey=\{explorerRefreshKey\}/);
});
