import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./ExtensionWidgets.tsx", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  DEFAULT_EXPANDED_WIDGET_LINES,
  ExtensionWidgets,
  isSubagentFleetWidget,
  formatExtensionWidgetContent,
  getNextExpandedWidgetKey,
  getUpdatedExtensionWidgetKeys,
  snapshotExtensionWidgetContents,
} = await jiti.import("./ExtensionWidgets.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderWidgets(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionWidgets, props),
    ),
  );
}

test("renders short extension widgets without a truncation marker", () => {
  const html = renderWidgets({
    widgets: [{ key: "short", lines: ["first", "second"], placement: "aboveEditor" }],
  });

  assert.match(html, /first\nsecond/);
  assert.doesNotMatch(html, /widget truncated/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /data-direction="up"/);
  assert.doesNotMatch(html, /[\u2191\u2193]/);
});

test("collapses long widgets by default", () => {
  const lines = Array.from(
    { length: 12 },
    (_, index) => `line-${index + 1}`,
  );
  const html = renderWidgets({
    widgets: [{ key: "long", lines, placement: "belowEditor" }],
  });

  assert.ok(lines.length > DEFAULT_EXPANDED_WIDGET_LINES);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-direction="down"/);
  assert.doesNotMatch(html, /<pre/);
  assert.doesNotMatch(html, /line-1/);
  assert.doesNotMatch(html, /line-10/);
  assert.doesNotMatch(html, /line-12/);
});

test("keeps all widget lines available for the scrollable expanded panel", () => {
  const lines = Array.from(
    { length: 12 },
    (_, index) => `line-${index + 1}`,
  );
  const content = formatExtensionWidgetContent(lines);

  assert.match(content, /line-10/);
  assert.match(content, /line-12/);
  assert.doesNotMatch(content, /widget truncated/);
});

test("keeps compact widgets expanded by default", () => {
  const lines = Array.from(
    { length: DEFAULT_EXPANDED_WIDGET_LINES },
    (_, index) => `line-${index + 1}`,
  );
  const html = renderWidgets({
    widgets: [{ key: "compact", lines, placement: "aboveEditor" }],
  });

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<pre/);
});

test("expands at most one compact widget", () => {
  const html = renderWidgets({
    widgets: [
      { key: "first", lines: ["one", "two"], placement: "aboveEditor" },
      { key: "second", lines: ["three", "four"], placement: "belowEditor" },
    ],
  });

  assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 1);
  assert.equal((html.match(/<section/g) ?? []).length, 1);
  assert.match(html, /aria-labelledby="[^"]*trigger-0"/);
  assert.doesNotMatch(html, /aria-labelledby="[^"]*trigger-1"/);
});

test("switching widgets closes the previously expanded widget", () => {
  assert.equal(getNextExpandedWidgetKey(null, "first"), "first");
  assert.equal(getNextExpandedWidgetKey("first", "second"), "second");
  assert.equal(getNextExpandedWidgetKey("second", "second"), null);
});

test("detects only existing widgets whose line content changed", () => {
  const previous = snapshotExtensionWidgetContents([
    { key: "changed", lines: ["one"], placement: "aboveEditor" },
    { key: "same", lines: ["ready"], placement: "belowEditor" },
    { key: "removed", lines: ["gone"], placement: "belowEditor" },
  ]);
  const next = snapshotExtensionWidgetContents([
    { key: "same", lines: ["ready"], placement: "aboveEditor" },
    { key: "changed", lines: ["one", "two"], placement: "belowEditor" },
    { key: "added", lines: ["new"], placement: "aboveEditor" },
  ]);

  assert.deepEqual(getUpdatedExtensionWidgetKeys(previous, next), ["changed"]);
  assert.deepEqual(getUpdatedExtensionWidgetKeys(null, next), []);
});

test("compares widget lines without delimiter collisions", () => {
  const previous = new Map([["status", ["one", "two"]]]);
  const next = new Map([["status", ["one\ntwo"]]]);

  assert.deepEqual(getUpdatedExtensionWidgetKeys(previous, next), ["status"]);
});

test("keeps one-line widgets compact but expandable", () => {
  const html = renderWidgets({
    widgets: [{ key: "single-line-widget", lines: ["ready"], placement: "belowEditor" }],
  });

  assert.match(html, /extension-widget-triggers/);
  assert.match(html, /<svg[^>]*extension-widget-placement-icon/);
  assert.match(html, /data-direction="down"/);
  assert.doesNotMatch(html, /[\u2191\u2193]/);
  assert.match(html, /Below editor widget/);
  assert.match(html, /<button[^>]*class="extension-widget-trigger/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /title="single-line-widget - Below editor widget - Expand"/);
  assert.match(html, /extension-widget-key/);
  assert.match(html, /extension-widget-update-pulse/);
  assert.doesNotMatch(html, /extension-widget-preview/);
  assert.doesNotMatch(html, /extension-widget-line-count/);
  assert.doesNotMatch(html, />ready</);
  assert.doesNotMatch(html, /<pre/);
});

test("only the package's exact fleet widget keys get native controls", () => {
  assert.equal(isSubagentFleetWidget("subagent-fleet-status"), true);
  assert.equal(isSubagentFleetWidget("subagent-async"), true);
  assert.equal(isSubagentFleetWidget("subagent-other"), false);
  assert.equal(isSubagentFleetWidget("subagent"), false);
  for (const key of ["subagent-fleet-status", "subagent-async"]) {
    const html = renderWidgets({ sessionId: "s1", widgets: [{ key, lines: ["running", "←/→ select"], placement: "belowEditor" }] });
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /←\/→|subagent-fleet-panel/);
  }
});

test("without a project session the fleet widget keeps its generic text renderer", () => {
  const html = renderWidgets({ widgets: [{ key: "subagent-fleet-status", lines: ["running", "←/→ select"], placement: "belowEditor" }] });
  assert.match(html, /←\/→ select/);
  assert.doesNotMatch(html, /subagent-fleet-panel/);
});

test("keeps empty widgets non-interactive", () => {
  const html = renderWidgets({
    widgets: [{ key: "empty-widget", lines: [], placement: "aboveEditor" }],
  });

  assert.match(html, /<div class="extension-widget-trigger/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /aria-expanded/);
  assert.match(html, /title="empty-widget - Above editor widget"/);
});

test("mounts the fleet panel for the package's fleet widget keys", () => {
  // A static render never reaches the expanded state, so the mount itself is
  // asserted at the source level: the fleet branch must keep rendering the panel.
  assert.match(source, /isSubagentFleetWidget\(widget\.key\) \? \(\s*<SubagentFleetPanel/);
});

test("one Escape handler covers the expanded panel and its trigger row", () => {
  const section = source.slice(source.indexOf("<section"), source.indexOf("</section>"));
  assert.ok(section.length > 0);
  // The handler moved off the panel: Escape from the trigger (a sibling of the
  // panel) used to fall through to the global shortcut that stops the agent.
  assert.doesNotMatch(section, /onKeyDown/);
  assert.match(source, /onKeyDown=\{\(event: KeyboardEvent<HTMLDivElement>\)/);
  const wrapper = source.slice(source.indexOf("onKeyDown={(event: KeyboardEvent"), source.indexOf("extension-widget-triggers\""));
  assert.match(wrapper, /setExpandedWidgetKey\(null\)/);
});
