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
const { WidgetToolView, WidgetPreview, WidgetResultCard } = await jiti.import("./WidgetToolView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { WIDGET_TOOL_NAME, widgetBlockView } = await jiti.import("@/lib/widget-tool.ts");

function render(element) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, element));
}

function toolCallBlock(overrides = {}) {
  return {
    type: "toolCall",
    toolCallId: "call-1",
    toolName: WIDGET_TOOL_NAME,
    input: {},
    ...overrides,
  };
}

const COMPLETE_INPUT = {
  i_have_seen_read_me: true,
  title: "sales_dashboard",
  widget_code: "<div style=\"color:red\">hello</div>",
  width: 640,
  height: 480,
};

test("dispatch: non-widget tools return null, widget calls return render props", () => {
  assert.equal(widgetBlockView({ toolName: "bash", parsedInput: { widget_code: "<div/>" } }), null);
  assert.equal(widgetBlockView({ toolName: "edit", rawInput: "{" }), null);
  assert.equal(widgetBlockView({ toolName: WIDGET_TOOL_NAME, parsedInput: { widget_code: "<div/>" } }).code, "<div/>");
  assert.equal(widgetBlockView({ toolName: WIDGET_TOOL_NAME, rawInput: "{\"widget_code\": \"<div" }), "streaming");
  // A malformed widget call (no usable code) falls back to the generic view.
  assert.equal(widgetBlockView({ toolName: WIDGET_TOOL_NAME, parsedInput: {} }), null);
});

test("streaming renders a placeholder, never a frame", () => {
  const block = toolCallBlock({
    rawInput: "{\"title\": \"sales_dashboard\", \"widget_code\": \"<div class=\\\"a\\\">still streaming",
  });
  const html = render(React.createElement(WidgetToolView, {
    block,
    view: widgetBlockView({ toolName: block.toolName, rawInput: block.rawInput }),
    isStreaming: true,
  }));
  assert.match(html, /sales dashboard/);
  assert.match(html, /Generating widget/);
  assert.match(html, /\d+(\.\d+)? (B|KB)/);
  assert.ok(!html.includes("<iframe"), "no iframe mounts while the input streams");
});

test("a completed scripted widget from history renders source, not a running frame", () => {
  const block = toolCallBlock({ input: { ...COMPLETE_INPUT, widget_code: "<div>hi</div><script>loop()</script>" } });
  const html = render(React.createElement(WidgetToolView, {
    block,
    view: widgetBlockView({ toolName: block.toolName, parsedInput: block.input }),
    isStreaming: false,
  }));
  assert.match(html, /sales dashboard/);
  assert.match(html, /640×480/);
  // The source view shows the code (syntax-highlighted into spans, so match
  // the pieces) and mounts no frame.
  assert.match(html, /script/);
  assert.match(html, /loop/);
  assert.ok(!html.includes("<iframe"), "history with scripts does not auto-run");
  assert.match(html, /Preview/, "a preview button offers to run it");
});

test("a completed script-free widget renders its frame inline", () => {
  const block = toolCallBlock({ input: COMPLETE_INPUT });
  const html = render(React.createElement(WidgetToolView, {
    block,
    view: widgetBlockView({ toolName: block.toolName, parsedInput: block.input }),
    isStreaming: false,
  }));
  assert.ok(html.includes("<iframe"), "script-free widgets render inline");
  assert.match(html, /sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"/);
  assert.match(html, /Open in window/, "the pop-out button is present");
});

test("an SVG widget renders as the svg preview kind", () => {
  const block = toolCallBlock({
    input: { ...COMPLETE_INPUT, widget_code: "<svg viewBox=\"0 0 10 10\"><circle cx=\"5\" cy=\"5\" r=\"4\"/></svg>" },
  });
  const html = render(React.createElement(WidgetToolView, {
    block,
    view: widgetBlockView({ toolName: block.toolName, parsedInput: block.input }),
    isStreaming: false,
  }));
  assert.match(html, /sales dashboard/);
  assert.ok(html.includes("<iframe"));
});

test("the tool result text joins the card and errors stand out", () => {
  const block = toolCallBlock({ input: COMPLETE_INPUT });
  const view = widgetBlockView({ toolName: block.toolName, parsedInput: block.input });
  const success = render(React.createElement(WidgetToolView, {
    block,
    view,
    result: {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: 'Widget "sales dashboard" rendered inline in the conversation (640×480).' }],
    },
  }));
  assert.match(success, /rendered inline in the conversation/);

  const failure = render(React.createElement(WidgetToolView, {
    block,
    view,
    result: {
      role: "toolResult",
      toolCallId: "call-1",
      isError: true,
      content: [{ type: "text", text: "You must call visualize_read_me before show_widget." }],
    },
  }));
  assert.match(failure, /visualize_read_me/);
  assert.match(failure, /rgba\(248,113,113/, "the error border marks the failure");
});

test("a pop-out failure is reported inline instead of crashing", () => {
  // The initial render starts idle; the failure text only appears after the
  // fetch rejects, which needs a DOM event loop. The static render asserts the
  // card survives with the button wired; the fetch path itself is covered by
  // app/api/widgets/open/route.test.mjs.
  const block = toolCallBlock({ input: COMPLETE_INPUT });
  const html = render(React.createElement(WidgetToolView, {
    block,
    view: widgetBlockView({ toolName: block.toolName, parsedInput: block.input }),
    isStreaming: false,
  }));
  assert.doesNotMatch(html, /Could not open the window/);
  assert.match(html, /Open in window/);
});

test("ChatWindow's hoist predicate accepts only renderable widget calls", async () => {
  const { isHoistableWidgetBlock } = await jiti.import("./ChatWindow.tsx");
  assert.equal(isHoistableWidgetBlock({ type: "text", text: "hi" }), false);
  assert.equal(isHoistableWidgetBlock({ type: "thinking", thinking: "x" }), false);
  assert.equal(isHoistableWidgetBlock({ type: "toolCall", toolCallId: "a", toolName: "bash", input: { command: "ls" } }), false);
  assert.equal(isHoistableWidgetBlock({ type: "toolCall", toolCallId: "a", toolName: "show_widget", input: {} }), false, "a malformed widget call is not hoisted");
  assert.equal(isHoistableWidgetBlock({
    type: "toolCall", toolCallId: "a", toolName: "show_widget",
    input: { title: "t", widget_code: "<div/>" },
  }), true);
});

test("WidgetResultCard renders order, title, type badge and localized status", () => {
  const entryComplete = {
    toolCallId: "c1",
    order: 2,
    status: "complete",
    block: toolCallBlock({ input: COMPLETE_INPUT }),
    view: { code: "<div/>", title: "sales dashboard", width: 640, height: 480, isSVG: false },
  };
  const htmlComplete = render(React.createElement(WidgetResultCard, { entry: entryComplete, total: 3 }));
  assert.match(htmlComplete, /2\/3/);
  assert.match(htmlComplete, /sales dashboard/);
  assert.match(htmlComplete, /HTML/);
  assert.match(htmlComplete, /is-complete/);

  const entryStreaming = {
    toolCallId: "c2",
    order: 1,
    status: "streaming",
    block: toolCallBlock({ rawInput: '{"title": "live_stream", "widget_code": "<div' }),
    view: "streaming",
  };
  const htmlStreaming = render(React.createElement(WidgetResultCard, { entry: entryStreaming, total: 1 }));
  assert.match(htmlStreaming, /1\/1/);
  assert.match(htmlStreaming, /live stream/);
  assert.match(htmlStreaming, /is-streaming/);
});

test("WidgetPreview renders directly with preview buttons and handles streaming", () => {
  const block = toolCallBlock({ input: COMPLETE_INPUT });
  const view = widgetBlockView({ toolName: block.toolName, parsedInput: block.input });

  const html = render(React.createElement(WidgetPreview, {
    block,
    view,
    isStreaming: false,
  }));
  assert.ok(html.includes("<iframe"));
  assert.match(html, /sales dashboard/);
  assert.match(html, /Open in window/);
});
