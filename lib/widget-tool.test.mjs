import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  WIDGET_DEFAULT_HEIGHT,
  WIDGET_DEFAULT_WIDTH,
  WIDGET_TOOL_NAME,
  extractWidgetCall,
  partialWidgetCode,
  streamingWidgetBytes,
  streamingWidgetTitle,
  widgetBlockView,
  widgetPreviewKind,
} = await createJiti(import.meta.url).import("./widget-tool.ts");

test("extractWidgetCall validates and defaults a show_widget input", () => {
  const call = extractWidgetCall({
    i_have_seen_read_me: true,
    title: "sales_dashboard",
    widget_code: "<div>hello</div>",
    width: 640,
    height: 480,
  });
  assert.deepEqual(call, { code: "<div>hello</div>", title: "sales dashboard", width: 640, height: 480, isSVG: false });

  assert.deepEqual(
    extractWidgetCall({ widget_code: "<svg><rect/></svg>" }),
    { code: "<svg><rect/></svg>", title: "Widget", width: WIDGET_DEFAULT_WIDTH, height: WIDGET_DEFAULT_HEIGHT, isSVG: true },
    "missing title/size fall back and <svg is auto-detected",
  );
  assert.equal(extractWidgetCall({ widget_code: "<div/>", isSVG: true })?.isSVG, true, "explicit isSVG wins");

  assert.equal(extractWidgetCall({ widget_code: "" }), null);
  assert.equal(extractWidgetCall({ widget_code: "   " }), null);
  assert.equal(extractWidgetCall({ title: "x" }), null);
  assert.equal(extractWidgetCall(null), null);
  assert.equal(extractWidgetCall(undefined), null);
  assert.equal(extractWidgetCall("not-an-object"), null);
  assert.equal(extractWidgetCall([]), null);
  assert.equal(extractWidgetCall({ widget_code: 42 }), null);
  // A width of 0 or garbage falls back to the default instead of a broken frame.
  assert.equal(extractWidgetCall({ widget_code: "<div/>", width: 0 })?.width, WIDGET_DEFAULT_WIDTH);
  assert.equal(extractWidgetCall({ widget_code: "<div/>", height: "tall" })?.height, WIDGET_DEFAULT_HEIGHT);
});

test("widgetPreviewKind maps the preview document type", () => {
  assert.equal(widgetPreviewKind(true), "svg");
  assert.equal(widgetPreviewKind(false), "html");
});

test("widgetBlockView dispatches: streaming, complete, and not-a-widget", () => {
  assert.equal(widgetBlockView({ toolName: "bash", rawInput: "{" }), null, "other tools never take the widget path");
  assert.equal(widgetBlockView({}), null);
  assert.equal(widgetBlockView({ toolName: WIDGET_TOOL_NAME }), null, "a widget call without usable input is null");

  assert.equal(
    widgetBlockView({ toolName: WIDGET_TOOL_NAME, rawInput: '{"widget_code": "<div' }),
    "streaming",
  );

  const view = widgetBlockView({
    toolName: WIDGET_TOOL_NAME,
    parsedInput: { title: "demo", widget_code: "<div/>", width: 320, height: 240 },
  });
  assert.deepEqual(view, { code: "<div/>", title: "demo", width: 320, height: 240, isSVG: false });
});

test("streaming helpers read the partial tool-call JSON", () => {
  const titleFirst = '{"title": "my_widget", "widget_code": "<div class=\\"a\\">hi</div>';
  assert.equal(streamingWidgetTitle(titleFirst), "my widget");
  assert.equal(streamingWidgetTitle('{"widget_code": "<div/>"'), null);
  assert.equal(streamingWidgetTitle(undefined), null);
  // A title whose closing quote has not arrived yet does not count.
  assert.equal(streamingWidgetTitle('{"title": "partial'), null);

  const streaming = '{"i_have_seen_read_me": true, "title": "t", "widget_code": "<div>line1\\nline2</div>';
  const code = partialWidgetCode(streaming);
  assert.equal(code, "<div>line1\nline2</div>", "JSON escapes are undone, the string stays open");
  assert.ok(streamingWidgetBytes(streaming) >= "<div>line1\nline2</div>".length);

  assert.equal(partialWidgetCode('{"title": "t"}'), "");
  assert.equal(streamingWidgetBytes('{"title": "t"}'), 0);
  assert.equal(streamingWidgetBytes(undefined), 0);

  // A closed widget_code string stops at the closing quote; the rest of the
  // JSON (later params) is not counted as code.
  const closed = '{"widget_code": "<b>x</b>", "width": 999999999}';
  assert.equal(partialWidgetCode(closed), "<b>x</b>");
  assert.equal(streamingWidgetBytes(closed), "<b>x</b>".length);

  // A trailing partial escape is dropped, not decoded.
  assert.equal(partialWidgetCode('{"widget_code": "abc\\'), "abc");
  assert.equal(partialWidgetCode('{"widget_code": "\\u4e2d\\u6587"}'), "中文", "unicode escapes decode");
});
