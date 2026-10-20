import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SubagentFleetPanel.tsx", import.meta.url), "utf8");

test("polls the restricted subagents API of one session for as long as it is mounted", () => {
  assert.match(source, /\/api\/agent\/\$\{encodeURIComponent\(sessionId\)\}\/subagents/);
  assert.match(source, /const POLL_INTERVAL_MS = 2_500/);
  // Collapsing the tag unmounts the panel; the poll chain must stop on unmount
  // instead of keeping a timer alive.
  assert.match(source, /cancelled = true; clearTimeout\(timer\)/);
  assert.doesNotMatch(source, /if \(!active\) return;/);
});

test("only rows the server marked inspectable get an Output control", () => {
  // The button's presence and its expanded state both come from server-computed
  // values, so a row without a run id cannot claim an open panel.
  assert.match(source, /\{row\.operations\.inspect && \(/);
  assert.match(source, /const inspecting = inspect !== null && inspect\.runId === row\.runId/);
  assert.match(source, /aria-expanded=\{inspecting\}/);
  assert.match(source, /const detail = inspecting \? inspect : null/);
  assert.doesNotMatch(source, /disabled=\{busy !== null \|\| !row\.runId\}/);
  assert.doesNotMatch(source, /inspect\?\.runId === row\.runId/);
});

test("sends only the API's four actions with server-known identifiers", () => {
  assert.match(source, /action: "inspect", runId/);
  assert.match(source, /action: "stop",\s*runId:/);
  assert.match(source, /action: "steer",\s*runId:/);
  assert.match(source, /action: "interrupt", runId/);
  // A child stop carries the package-reported childId; steer sends no index.
  assert.match(source, /childId: row\.childId/);
  assert.doesNotMatch(source, /index: row/);
});

test("operations follow the server-computed flags, never client-side guesses", () => {
  assert.match(source, /row\.operations\.steer/);
  assert.match(source, /row\.operations\.stop/);
  assert.match(source, /row\.operations\.interrupt/);
  assert.doesNotMatch(source, /row\.status === "running" &&/);
});

test("a stop of a child row asks before targeting only that child", () => {
  assert.match(source, /row\.childId !== undefined && row\.parentRunId !== undefined/);
  assert.match(source, /subagentFleet\.stopChildConfirm/);
});

test("fleet summary rows are display-only (no actions rendered for them)", () => {
  const foreground = source.slice(source.indexOf("subagent-fleet-foreground"));
  assert.ok(foreground.length > 0);
  assert.doesNotMatch(foreground.slice(0, foreground.indexOf("subagent-fleet-omitted")), /subagent-fleet-action/);
});

test("renders its frame before any fetch resolves (static render, no effects)", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { SubagentFleetPanel } = await jiti.import("./SubagentFleetPanel.tsx");
  const { I18nProvider } = await jiti.import("@/hooks/useI18n");

  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(SubagentFleetPanel, { sessionId: "s1" })));

  // Effects never run in a static render: the panel frame shows without any
  // snapshot and without claiming an unavailable reason it has not been told.
  assert.ok(html.includes("subagent-fleet-panel"));
  assert.match(html, /Loading sub-agent status/);
  assert.doesNotMatch(html, /Loading output/);
  assert.doesNotMatch(html, /subagent-fleet-unavailable/);
  assert.doesNotMatch(html, /subagent-fleet-row/);
});
