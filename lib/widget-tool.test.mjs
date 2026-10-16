import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  WIDGET_DEFAULT_HEIGHT,
  WIDGET_DEFAULT_WIDTH,
  WIDGET_TOOL_NAME,
  classifyWidgetStatus,
  collectTurnWidgets,
  extractWidgetCall,
  isTurnWidgetBlock,
  lastTurnWidgetId,
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

test("classifyWidgetStatus maps status across streaming, running, complete, error, and cancelled", () => {
  assert.equal(classifyWidgetStatus("streaming", undefined, { isStreaming: true }), "streaming");
  assert.equal(classifyWidgetStatus("streaming"), "cancelled", "interrupted input is terminal");
  assert.equal(classifyWidgetStatus({ code: "<div/>", title: "t", width: 100, height: 100, isSVG: false }), "cancelled", "no result in history => cancelled");
  assert.equal(classifyWidgetStatus({ code: "<div/>", title: "t", width: 100, height: 100, isSVG: false }, undefined, { isStreaming: true }), "running", "no result while streaming => running");

  assert.equal(
    classifyWidgetStatus(
      { code: "<div/>", title: "t", width: 100, height: 100, isSVG: false },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
    ),
    "complete",
  );

  assert.equal(
    classifyWidgetStatus(
      { code: "<div/>", title: "t", width: 100, height: 100, isSVG: false },
      { role: "toolResult", toolCallId: "c1", isError: true, content: [{ type: "text", text: "bad code" }] },
    ),
    "error",
  );

  assert.equal(
    classifyWidgetStatus(
      { code: "<div/>", title: "t", width: 100, height: 100, isSVG: false },
      { role: "toolResult", toolCallId: "c1", isError: true, content: [{ type: "text", text: "Tool call cancelled by user" }] },
    ),
    "cancelled",
  );

  assert.equal(
    classifyWidgetStatus(
      { code: "<div/>", title: "t", width: 100, height: 100, isSVG: false },
      { role: "toolResult", toolCallId: "c1", cancelled: true, content: [] },
    ),
    "cancelled",
  );
});

test("collectTurnWidgets collects a single widget correctly", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: WIDGET_TOOL_NAME,
          input: { title: "Chart", widget_code: "<div>Chart 1</div>" },
        },
      ],
    },
  ];
  const results = new Map([
    ["call-1", { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] }],
  ]);

  const entries = collectTurnWidgets(messages, results);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].toolCallId, "call-1");
  assert.equal(entries[0].order, 1);
  assert.equal(entries[0].status, "complete");
  assert.equal(entries[0].view.title, "Chart");
  assert.equal(lastTurnWidgetId(entries), "call-1");
});

test("collectTurnWidgets arranges multiple widgets in original generation order and defaults to last", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: WIDGET_TOOL_NAME,
          input: { title: "First", widget_code: "<div>1</div>" },
        },
        {
          type: "toolCall",
          toolCallId: "call-2",
          toolName: WIDGET_TOOL_NAME,
          input: { title: "Second", widget_code: "<div>2</div>" },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "call-3",
          toolName: WIDGET_TOOL_NAME,
          input: { title: "Third", widget_code: "<div>3</div>" },
        },
      ],
    },
  ];

  const entries = collectTurnWidgets(messages);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.toolCallId), ["call-1", "call-2", "call-3"]);
  assert.deepEqual(entries.map((e) => e.order), [1, 2, 3]);
  assert.equal(lastTurnWidgetId(entries), "call-3");
});

test("same toolCallId streaming updates update the same entry without duplicating", () => {
  // Pass 1: rawInput streaming
  const pass1 = collectTurnWidgets(
    [
      {
        type: "toolCall",
        toolCallId: "call-live",
        toolName: WIDGET_TOOL_NAME,
        rawInput: '{"title": "Live", "widget_code": "<div',
      },
    ],
    undefined,
    { isStreaming: true },
  );
  assert.equal(pass1.length, 1);
  assert.equal(pass1[0].status, "streaming");
  assert.equal(pass1[0].order, 1);

  // Pass 2: parsedInput arrives
  const pass2 = collectTurnWidgets(
    [
      {
        type: "toolCall",
        toolCallId: "call-live",
        toolName: WIDGET_TOOL_NAME,
        input: { title: "Live", widget_code: "<div>finished code</div>" },
      },
    ],
    undefined,
    { isStreaming: true },
  );
  assert.equal(pass2.length, 1);
  assert.equal(pass2[0].status, "running");
  assert.equal(pass2[0].view.code, "<div>finished code</div>");

  // Pass 3: toolResult arrives
  const toolResults = new Map([
    ["call-live", { role: "toolResult", toolCallId: "call-live", content: [{ type: "text", text: "done" }] }],
  ]);
  const pass3 = collectTurnWidgets(
    [
      {
        type: "toolCall",
        toolCallId: "call-live",
        toolName: WIDGET_TOOL_NAME,
        input: { title: "Live", widget_code: "<div>finished code</div>" },
      },
    ],
    toolResults,
    { isStreaming: false },
  );
  assert.equal(pass3.length, 1);
  assert.equal(pass3[0].status, "complete");
});

test("history and streaming copies deduplicate while preserving source and original order", () => {
  const first = { type: "toolCall", toolCallId: "first", toolName: WIDGET_TOOL_NAME, input: { widget_code: "<div>first</div>" } };
  const second = { ...first, toolCallId: "second" };
  const updated = { ...first, input: { widget_code: "<div>updated</div>" } };
  const entries = collectTurnWidgets([
    { role: "assistant", content: [first, second] },
  ], { entryIds: ["source-entry"], isStreaming: true, streamingMessage: { role: "assistant", content: [updated] } });
  assert.deepEqual(entries.map((entry) => entry.toolCallId), ["first", "second"]);
  assert.equal(entries[0].view.code, "<div>updated</div>");
  assert.equal(entries[0].entryId, "source-entry");
  assert.equal(entries[0].messageIndex, 0);
});

test("malformed show_widget and non-widget tools do not enter turn widgets", () => {
  const blocks = [
    { type: "toolCall", toolCallId: "bash-1", toolName: "bash", input: { command: "ls" } },
    { type: "toolCall", toolCallId: "bad-widget", toolName: WIDGET_TOOL_NAME, input: {} },
    { type: "toolCall", toolCallId: "good-widget", toolName: WIDGET_TOOL_NAME, input: { widget_code: "<div/>" } },
  ];
  assert.equal(isTurnWidgetBlock(blocks[0]), false);
  assert.equal(isTurnWidgetBlock(blocks[1]), false);
  assert.equal(isTurnWidgetBlock(blocks[2]), true);

  const entries = collectTurnWidgets(blocks);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].toolCallId, "good-widget");
});

test("error and cancelled widgets are preserved in sequence", () => {
  const blocks = [
    { type: "toolCall", toolCallId: "c1", toolName: WIDGET_TOOL_NAME, input: { widget_code: "<div>1</div>" } },
    { type: "toolCall", toolCallId: "c2", toolName: WIDGET_TOOL_NAME, input: { widget_code: "<div>2</div>" } },
    { type: "toolCall", toolCallId: "c3", toolName: WIDGET_TOOL_NAME, input: { widget_code: "<div>3</div>" } },
  ];
  const toolResults = new Map([
    ["c1", { role: "toolResult", toolCallId: "c1", isError: true, content: [{ type: "text", text: "syntax error" }] }],
    ["c2", { role: "toolResult", toolCallId: "c2", content: [{ type: "text", text: "ok" }] }],
    // c3 has no result in history => cancelled
  ]);

  const entries = collectTurnWidgets(blocks, toolResults, { isStreaming: false });
  assert.equal(entries.length, 3);
  assert.equal(entries[0].status, "error");
  assert.equal(entries[1].status, "complete");
  assert.equal(entries[2].status, "cancelled");
});
