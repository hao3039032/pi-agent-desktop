import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { TurnImageOwner, TurnImageTargetContext } = await jiti.import("./TurnResultImages.tsx");
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { collectTurnResultImages } = await jiti.import("../lib/turn-result-images.ts");
const { setToolCallExpanded } = await jiti.import("@/lib/tool-call-expansion");
const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } };
const call = { role: "assistant", content: [{ type: "toolCall", toolCallId: "g1", toolName: "bash", input: { command: "imagegen" } }] };
const result = { role: "toolResult", toolCallId: "g1", content: [png], details: { modelImages: { version: 1, outputs: [{ blockIndex: 0, kind: "generated-image" }] } } };
const results = new Map([["g1", result]]);
const images = collectTurnResultImages([call, result], results);
const render = (node) => renderToStaticMarkup(h(I18nProvider, null, node));

test("generated image is visible when the entire trace is unmounted", () => {
  const markup = render(h(TurnImageOwner, { id: "gallery", images }, h("button", { "aria-expanded": false }, "Process details")));
  assert.match(markup, /aria-expanded="false"/);
  assert.equal((markup.match(/<img /g) ?? []).length, 1);
  assert.match(markup, /Save image/);
});

test("expanding the process shows a reference rather than a duplicate image", () => {
  setToolCallExpanded("g1", true);
  try {
    const markup = render(h(TurnImageOwner, { id: "gallery", images }, h(MessageView, { message: call, toolResults: results })));
    assert.equal((markup.match(/<img /g) ?? []).length, 1);
    assert.match(markup, /View result images/);
    assert.match(markup, /imagegen/);
    assert.doesNotMatch(markup, /\(no output\)/i, "promoted images are output even without inline images");
  } finally {
    setToolCallExpanded("g1", false);
  }
});

test("standalone tools retain their image fallback; read images are not suppressed by an owner", () => {
  assert.equal((render(h(MessageView, { message: call, toolResults: results })).match(/<img /g) ?? []).length, 1);
  const readResult = { ...result, details: undefined, toolName: "read" };
  const markup = render(h(TurnImageTargetContext.Provider, { value: "gallery" }, h(MessageView, { message: call, toolResults: new Map([["g1", readResult]]) })));
  assert.equal((markup.match(/<img /g) ?? []).length, 1);
  assert.doesNotMatch(markup, /View result images/);
});

test("mixed results suppress only tagged blocks", () => {
  const mixed = { ...result, content: [png, png], details: { modelImages: { version: 1, outputs: [{ blockIndex: 1, kind: "generated-image" }] } } };
  const map = new Map([["g1", mixed]]);
  const markup = render(h(TurnImageOwner, { id: "gallery", images: collectTurnResultImages([call, mixed], map) }, h(MessageView, { message: call, toolResults: map })));
  assert.equal((markup.match(/<img /g) ?? []).length, 2, "one reference image inside the trace, one generated image outside");
});

test("nested custom images render once outside the trace", () => {
  const custom = { role: "custom", customType: "model-image", display: true, content: "generated", details: { data: "QUJD", mimeType: "image/png" } };
  const markup = render(h(TurnImageOwner, { id: "gallery", images: collectTurnResultImages([custom], new Map(), ["c1"]) }, h(MessageView, { message: custom })));
  assert.equal((markup.match(/<img /g) ?? []).length, 1);
  assert.doesNotMatch(markup, /&quot;data&quot;/, "no raw base64 details card");
});

test("gallery bounds large batches and preserves partial-error images", () => {
  const markup = render(h(TurnImageOwner, { id: "gallery", images: Array.from({ length: 7 }, (_, i) => ({ ...images[0], key: String(i), isError: i === 0 })) }));
  assert.equal((markup.match(/<img /g) ?? []).length, 4);
  assert.match(markup, /Show all 7 images/);
  assert.match(markup, /source tool reported an error/);
});

test("the turn owner is independent of final-answer availability and uses the existing render-window slot", async () => {
  const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(source, /messages\.slice\(userIdx \+ 1, endIdx\)/);
  assert.match(source, /if \(streamingMessage\) turnMessages\.push\(streamingMessage\)/);
  assert.match(source, /if \(processViews\.length > 0 \|\| turnImages\.length > 0\)/);
  assert.match(source, /<TurnImageOwner[^>]+>[\s\S]*?<ProcessDetailsGroup key=\{finalAnswerMessage \? "answered" : "unanswered"\}[\s\S]*?<\/TurnImageOwner>/);
  assert.ok(source.indexOf("<TurnImageOwner") < source.indexOf("if (finalAnswerMessage && finalAssistant)"));
  const component = await readFile(new URL("./TurnResultImages.tsx", import.meta.url), "utf8");
  assert.match(component, /<\/TurnImageTargetContext.Provider>\s*<TurnResultImages/);
});
