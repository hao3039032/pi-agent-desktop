import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true, jsx: { runtime: "automatic" } });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { RecoveryNoticeContent } = await jiti.import("./RecoveryNotice.tsx");
const render = (status, error = false) => renderToStaticMarkup(React.createElement(RecoveryNoticeContent, { locale: "en", status, error, onRefresh() {} }));

test("notice reports each unresolved category and offers only a read-only check", () => {
  const html = render({ trustPolicy: "pending", sessionWriters: "uninspectable", sessionWriterCleanup: "pending", deletionJournal: "clear" });
  assert.match(html, /Trust policy: pending/);
  assert.match(html, /Session writer: cannot inspect/);
  assert.match(html, /Known session outcome: cleanup: pending/);
  assert.doesNotMatch(html, /Session deletion:/);
  assert.match(html, /Do not retry uncertain changes/);
  assert.match(html, /Check again/);
  assert.doesNotMatch(html, /<button[^>]*>[^<]*(?:clear|repair|recover)/i);
});

test("clear status hides notice but unavailable status is visible", () => {
  assert.equal(render({ trustPolicy: "clear", sessionWriters: "clear", sessionWriterCleanup: "clear", deletionJournal: "clear" }), "");
  assert.match(render(null, true), /Recovery status could not be checked/);
});
