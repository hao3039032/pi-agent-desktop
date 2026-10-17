import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chatWindowSource = (await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const useDragDropSource = await readFile(new URL("../hooks/useDragDrop.ts", import.meta.url), "utf8");
const useDesktopDragDropSource = await readFile(new URL("../hooks/useDesktopDragDrop.ts", import.meta.url), "utf8");
const windowSource = await readFile(new URL("../src-tauri/src/shell/window.rs", import.meta.url), "utf8");

test("the desktop shell keeps Tauri's native drag/drop handler enabled", () => {
  // Disabling it hides absolute paths from the webview, which is what routed
  // dropped folders into the (failing) blob-upload path (#79-style network
  // errors). A merge must not bring `disable_drag_drop_handler` back.
  assert.match(windowSource, /pub fn build_window\(/);
  assert.ok(!windowSource.includes("disable_drag_drop_handler"));
  assert.match(windowSource, /native drag\/drop handler enabled/);
});

test("ChatWindow routes desktop drops through useDesktopDragDrop", () => {
  assert.match(chatWindowSource, /import \{ useDesktopDragDrop \} from "@\/hooks\/useDesktopDragDrop"/);
  assert.match(
    chatWindowSource,
    /const \{ isDragOver: desktopDragOver \} = useDesktopDragDrop\(\{\s*dropZoneRef,\s*onDropPaths: handleDesktopDropPaths,\s*\}\)/,
  );
  // The native drop lands only on the chat column, like the HTML5 zone it replaces.
  assert.match(chatWindowSource, /ref=\{dropZoneRef\}/);
});

test("the drag overlay lights up for both HTML5 and native drags", () => {
  assert.match(chatWindowSource, /const dragOverlayVisible = isDragOver \|\| desktopDragOver;/);
  assert.match(chatWindowSource, /\{dragOverlayVisible && \(/);
});

test("HTML5 drops step aside inside the packaged shell", () => {
  // The native handler owns OS file drops there; without the guard a stray
  // HTML5 event could double-process the same drop.
  const onDropMatch = chatWindowSource.match(
    /const onDrop = useCallback\(\(files: File\[\], directories: string\[\]\) => \{\s*([\s\S]*?)\s*\}, \[/,
  );
  assert.ok(onDropMatch, "onDrop callback not found");
  assert.match(onDropMatch[1], /if \(isTauriDesktop\(\)\) return;/);
});

test("dropped directories insert their absolute paths into the composer", () => {
  assert.match(
    chatWindowSource,
    /chatInputRef\?\.current\?\.insertText\(formatDroppedPathsForComposer\(directoryPaths\)\)/,
  );
  assert.match(chatWindowSource, /"chat\.dropPathInserted"/);
  // Images dropped in the shell still go through the path-based reader.
  assert.match(chatWindowSource, /readDesktopImageAttachments\(imagePaths\)/);
  // Other files are copied into the project by path instead of blob upload.
  assert.match(chatWindowSource, /importLocalFiles\(\{\s*destDirectory: cwd,/);
});

test("mixed desktop drops degrade per item instead of aborting", () => {
  // Oversized images and the attachment-count overflow are rejected per item
  // into the partial-failure notice rather than being sent to a route that
  // throws and losing the drop.
  assert.match(chatWindowSource, /MAX_ATTACHED_IMAGE_BYTES \/ \(1024 \* 1024\)/);
  assert.match(chatWindowSource, /at most \$\{MAX_ATTACHED_IMAGES\} images can be attached/);
  // The reader 413s a whole selection over the shared total, so the drop
  // pre-filter mirrors it per item instead of losing every image to one
  // rejected request.
  assert.match(
    chatWindowSource,
    /imageTotalBytes \+ \(item\.size \?\? 0\) > MAX_ATTACHED_IMAGE_SELECTION_BYTES/,
  );
  assert.match(
    chatWindowSource,
    /selected images must total \$\{MAX_ATTACHED_IMAGE_SELECTION_BYTES \/ \(1024 \* 1024\)\}MB or less/,
  );
  // Imported files are copied by local path (desktop token, disk-to-disk),
  // so the browser upload's 25MB/100MB caps must NOT be pre-filtered here —
  // a merge must not bring them back to the desktop path.
  assert.doesNotMatch(chatWindowSource, /PROJECT_UPLOAD_MAX/);
  assert.doesNotMatch(chatWindowSource, /importTotalBytes/);
  // Duplicate basenames keep the last occurrence, like the browser path.
  assert.match(chatWindowSource, /importsByName\.set\(getFileName\(item\.path\) \|\| item\.path, item\)/);
  // An image read failure is contained so the import/unsupported steps run.
  const imageStep = chatWindowSource.match(
    /if \(imagePaths\.length > 0 && !sessionBusy\) \{([\s\S]*?)\n        \}\n\n        let importMentionPaths/,
  );
  assert.ok(imageStep, "image step of handleDesktopDropPaths not found");
  assert.match(imageStep[1], /try \{/);
  assert.match(imageStep[1], /catch \(error\) \{/);
});

test("browser drops reject directories explicitly instead of uploading them", () => {
  assert.match(chatWindowSource, /"chat\.dropDirectoryBrowserUnsupported"/);
  assert.match(useDragDropSource, /collectDirectoryNames\(e\)/);
  assert.match(
    useDragDropSource,
    /Array\.from\(e\.dataTransfer\.files\)\.filter\(\(file\) => !directories\.includes\(file\.name\)\)/,
  );
});

test("the native drop listener converts drag pixels per platform and cleans up", () => {
  assert.match(useDesktopDragDropSource, /isTauriDesktop\(\)/);
  // wry reports physical pixels on Windows but logical points on macOS/Linux,
  // so the devicePixelRatio conversion is Windows-only.
  assert.match(useDesktopDragDropSource, /navigator\.platform\.includes\("Win"\)/);
  assert.match(useDesktopDragDropSource, /navigator\.userAgent\.includes\("Windows"\)/);
  assert.match(useDesktopDragDropSource, /window\.devicePixelRatio \|\| 1 : 1/);
  assert.match(useDesktopDragDropSource, /elementFromPoint\(dragX \/ ratio, dragY \/ ratio\)/);
  assert.match(useDesktopDragDropSource, /unlisten\?\.\(\)/);
  assert.match(useDesktopDragDropSource, /onDragDropEvent/);
});
