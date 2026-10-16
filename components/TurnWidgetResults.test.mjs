import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
  alias: { "@": new URL("../..", import.meta.url).pathname.replace(/\/$/, "") },
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TurnWidgetResults } = await jiti.import("./TurnWidgetResults.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { WIDGET_TOOL_NAME, collectTurnWidgets } = await jiti.import("@/lib/widget-tool.ts");

function render(element) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, element));
}

function completedEntries(blocks) {
  return collectTurnWidgets(blocks, new Map(blocks.map((block) => [block.toolCallId, {
    role: "toolResult", toolCallId: block.toolCallId, content: [], isError: false,
  }])));
}

function makeWidgetCall(id, title, code = "<div>content</div>", width = 640, height = 480) {
  return {
    type: "toolCall",
    toolCallId: id,
    toolName: WIDGET_TOOL_NAME,
    input: { title, widget_code: code, width, height },
  };
}

test("single widget defaults to expanded preview", () => {
  const blocks = [makeWidgetCall("call-1", "sales_dashboard", "<div>sales</div>")];
  const entries = completedEntries(blocks);
  const html = render(React.createElement(TurnWidgetResults, { entries }));

  // The single widget's preview is expanded and contains an iframe
  assert.match(html, /turn-widget-results/);
  assert.match(html, /sales dashboard/);
  assert.match(html, /<iframe/);
  assert.equal((html.match(/<iframe/g) ?? []).length, 1);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /aria-live="polite"/);
});

test("multiple widgets arrange horizontal tabs in generation order and default to expanding only the last", () => {
  const blocks = [
    makeWidgetCall("call-1", "first_chart", "<div>first</div>"),
    makeWidgetCall("call-2", "second_chart", "<div>second</div>"),
    makeWidgetCall("call-3", "third_chart", "<div>third</div>"),
  ];
  const entries = completedEntries(blocks);
  const html = render(React.createElement(TurnWidgetResults, { entries }));

  // Tabs rendered in order 1/3, 2/3, 3/3
  assert.match(html, /1\/3/);
  assert.match(html, /2\/3/);
  assert.match(html, /3\/3/);

  // Tab 3 is selected by default
  assert.match(html, /id="turn-widget-tab-call-3"[^>]*aria-selected="true"/);
  assert.match(html, /id="turn-widget-tab-call-1"[^>]*aria-selected="false"/);
  assert.match(html, /id="turn-widget-tab-call-2"[^>]*aria-selected="false"/);

  // Exactly ONE iframe is mounted (for third_chart, the last one)
  assert.equal((html.match(/<iframe/g) ?? []).length, 1);
  assert.match(html, /third_chart|third/);
});

test("only the selected widget mounts an iframe while other widgets only display cards", () => {
  const blocks = [
    makeWidgetCall("call-1", "widget_a", "<div>widget a</div>"),
    makeWidgetCall("call-2", "widget_b", "<div>widget b</div>"),
  ];
  const entries = completedEntries(blocks);
  const html = render(React.createElement(TurnWidgetResults, { entries }));

  // Total tab buttons = 2
  assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
  // Total mounted iframes = 1 (only the selected widget)
  assert.equal((html.match(/<iframe/g) ?? []).length, 1);
});

test("a streaming widget displays a placeholder without mounting an iframe", () => {
  const entries = collectTurnWidgets(
    [
      {
        type: "toolCall",
        toolCallId: "call-live",
        toolName: WIDGET_TOOL_NAME,
        rawInput: '{"title": "live_streaming", "widget_code": "<div class=\\"loading\\">',
      },
    ],
    undefined,
    { isStreaming: true },
  );

  const html = render(React.createElement(TurnWidgetResults, { entries, isStreaming: true }));

  assert.match(html, /live streaming/);
  assert.match(html, /Generating|正在生成/);
  assert.ok(!html.includes("<iframe"), "no iframe mounted while streaming");
});

test("a completed scripted widget from history renders source-first in the results area", () => {
  const blocks = [
    makeWidgetCall("call-script", "scripted_widget", "<div>content</div><script>dangerous()</script>"),
  ];
  const entries = completedEntries(blocks);
  const html = render(React.createElement(TurnWidgetResults, { entries }));

  assert.match(html, /scripted widget/);
  // Security guard: history script widgets must NOT auto-run
  assert.ok(!html.includes("<iframe"), "history scripts do not auto-run in results area");
  assert.match(html, /Preview|预览/, "offers preview button");
});

test("failed widgets show the actual error without mounting an iframe", () => {
  const blocks = [
    makeWidgetCall("call-err", "failed_widget", "<div>err</div>"),
  ];
  const toolResults = new Map([
    ["call-err", { role: "toolResult", toolCallId: "call-err", isError: true, content: [{ type: "text", text: "Compilation failed" }] }],
  ]);
  const entries = collectTurnWidgets(blocks, toolResults);
  const html = render(React.createElement(TurnWidgetResults, { entries }));

  assert.match(html, /failed widget/);
  assert.match(html, /Compilation failed/);
  assert.match(html, /is-error/);
  assert.ok(!html.includes("<iframe"));
});

for (const status of ["running", "cancelled", "streaming"]) {
  test(`${status} results never mount an iframe`, () => {
    const entries = completedEntries([makeWidgetCall("pending", "pending")]).map((entry) => ({ ...entry, status }));
    const html = render(React.createElement(TurnWidgetResults, { entries }));
    assert.match(html, new RegExp(`is-${status}`));
    assert.ok(!html.includes("<iframe"));
  });
}

test("empty entries render null", () => {
  const html = render(React.createElement(TurnWidgetResults, { entries: [] }));
  assert.equal(html, "");
});

test("a source-message target reveals a non-default widget", () => {
  const blocks = [
    makeWidgetCall("call-1", "widget_1", "<div>1</div>"),
    makeWidgetCall("call-2", "widget_2", "<div>2</div>"),
  ];
  const entries = completedEntries(blocks);

  const html1 = render(React.createElement(TurnWidgetResults, { entries, revealToolCallId: "call-1" }));
  assert.match(html1, /id="turn-widget-tab-call-1"[^>]*aria-selected="true"/);
  assert.match(html1, /id="turn-widget-tab-call-2"[^>]*aria-selected="false"/);

  // If selectedId refers to non-existent entry, safely falls back to the last valid entry (call-2)
  const html2 = render(React.createElement(TurnWidgetResults, { entries, revealToolCallId: "non-existent" }));
  assert.match(html2, /id="turn-widget-tab-call-2"[^>]*aria-selected="true"/);
});
