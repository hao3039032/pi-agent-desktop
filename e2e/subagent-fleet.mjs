// Isolated browser regression; no Next build, real agent or model requests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";

const fixture = `
import React, { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "./hooks/useI18n";
import { ExtensionWidgets } from "./components/ExtensionWidgets";
function App() {
  const [session, setSession] = useState("a");
  // Stand-in for the window-level Escape shortcut that stops the agent.
  useEffect(() => {
    const handler = (event) => {
      if (event.key === "Escape") window.__escapesToWindow = (window.__escapesToWindow ?? 0) + 1;
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  return <I18nProvider>
    <button id="switch" onClick={() => setSession("b")}>Switch session</button>
    <ExtensionWidgets key={session} sessionId={session} widgets={[
      {key:"subagent-fleet-status", lines:["running", "←/→ select"], placement:"belowEditor"},
      {key:"subagent-async", lines:["async status"], placement:"aboveEditor"},
      {key:"other", lines:["ordinary widget"], placement:"belowEditor"}
    ]} />
  </I18nProvider>;
}
createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
`;
const bundle = await build({
  stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: "fleet-fixture.tsx", loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"', "process.env.NODE_TEST_CONTEXT": '"1"', "process.env": "{}" },
});
const css = (await readFile("app/globals.css", "utf8")) + (await readFile("app/native-theme.css", "utf8"));
const server = createServer((req, res) => {
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
  if (req.url === "/app.css") { res.setHeader("Content-Type", "text/css"); res.end(css); return; }
  res.setHeader("Content-Type", "text/html");
  res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><main style="max-width:720px;margin:20px auto"><div id="root"></div></main><script src="/app.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  });
  const page = await browser.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/agent/*/subagents", async (route) => {
    const request = route.request();
    requests.push({ url: request.url(), method: request.method(), body: request.postDataJSON() });
    if (request.method() === "POST") {
      return route.fulfill({ json: { ok: true, view: { text: "Native output tail", truncated: false } } });
    }
    const root = { key: "run-1", runId: "run-1", depth: 0, name: "Reviewer", kind: "workflow", active: true, status: "running", terminal: false, operations: { steer: true, stop: true, interrupt: true, inspect: true } };
    return route.fulfill({ json: { available: true, generatedAt: Date.now(), capabilities: {}, activeCount: 2, omitted: { rows: 0, children: 0, fleetEntries: 0 }, runs: [root, { ...root, key: "lane", runId: undefined, depth: 1, childId: "lane-key", parentRunId: "run-1", name: "Child lane", kind: "step", operations: { stop: true, steer: false, interrupt: false, inspect: false } }], fleetSummary: { totalActive: 1, entries: [{ key: "fleet-1", agent: "Foreground worker" }], omitted: 0 } } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const tag = page.locator("button.extension-widget-trigger").filter({ hasText: "subagent-fleet-status" });
  await tag.waitFor();
  assert.equal(requests.length, 0, "collapsed tags never poll");
  await tag.click();
  await page.getByText("Reviewer", { exact: true }).waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /←\/→/);
  assert.equal(await tag.getAttribute("aria-expanded"), "true");
  // The fork raises the panel height cap; upstream's min(144px, 18dvh) would
  // silently clip the fleet list if the selector or class were renamed.
  const caps = await page.locator(".extension-widget-panels.is-subagent-fleet").evaluate((element) => {
    const viewportUnit = window.innerHeight / 100;
    return {
      actual: Math.round(Number.parseFloat(getComputedStyle(element).maxHeight)),
      fork: Math.round(Math.min(440, 50 * viewportUnit)),
      upstream: Math.round(Math.min(144, 18 * viewportUnit)),
    };
  });
  assert.equal(caps.actual, caps.fork);
  assert.notEqual(caps.actual, caps.upstream);
  const row = page.locator("li.subagent-fleet-row").filter({ hasText: "Reviewer" });
  // Waiting on each action's own round trip replaces fixed sleeps: the receipt
  // below can only be asserted once all three POSTs have completed.
  const actionReply = (action) => (response) => response.request().method() === "POST"
    && response.request().postDataJSON()?.action === action;
  const inspectReply = page.waitForResponse(actionReply("inspect"));
  await row.getByRole("button", { name: "Output", exact: true }).click();
  await inspectReply;
  await page.getByText("Native output tail", { exact: true }).waitFor();
  await row.getByRole("button", { name: "Steer", exact: true }).click();
  await row.locator("textarea").fill("Focus on the diff");
  const steerReply = page.waitForResponse(actionReply("steer"));
  await row.getByRole("button", { name: "Send", exact: true }).click();
  await steerReply;
  // No in-flight action: every action button is enabled again.
  await page.waitForFunction(() => document.querySelectorAll(".subagent-fleet-action:disabled").length === 0);
  const child = page.locator("li.subagent-fleet-row").filter({ hasText: "Child lane" });
  await child.getByRole("button", { name: "Stop", exact: true }).click();
  await child.getByRole("button", { name: "Stop this child", exact: true }).waitFor();
  const stopReply = page.waitForResponse(actionReply("stop"));
  await child.getByRole("button", { name: "Stop this child", exact: true }).click();
  await stopReply;
  await page.waitForFunction(() => document.querySelectorAll(".subagent-fleet-action:disabled").length === 0);
  assert.deepEqual(requests.filter(r => r.method === "POST").map(r => r.body), [
    { action: "inspect", runId: "run-1" },
    { action: "steer", runId: "run-1", message: "Focus on the diff" },
    { action: "stop", runId: "run-1", childId: "lane-key" },
  ]);
  // The picker's value is what reaches the wire: a non-default mode must be sent
  // as an explicit `mode`, while the default `steer` above omits the field.
  await row.getByRole("button", { name: "Steer", exact: true }).click();
  await row.locator("textarea").fill("Wait for the tests");
  await row.getByRole("combobox", { name: "Delivery mode" }).click();
  await page.getByRole("option", { name: "Follow-up", exact: true }).click();
  const followUpReply = page.waitForResponse(actionReply("steer"));
  await row.getByRole("button", { name: "Send", exact: true }).click();
  await followUpReply;
  assert.deepEqual(requests.filter(r => r.method === "POST").at(-1).body, {
    action: "steer", runId: "run-1", message: "Wait for the tests", mode: "follow_up",
  });
  // A poll round trip just finished, and the panel schedules the next GET only
  // after it: no request is in flight when the tag collapses.
  await page.waitForResponse((response) => response.request().method() === "GET"
    && /\/subagents$/.test(response.url()));
  await tag.click();
  const count = requests.length;
  await page.waitForTimeout(3200);
  assert.equal(requests.length, count, "collapse stops polling");
  await page.locator("button.extension-widget-trigger").filter({ hasText: "other" }).click();
  await page.getByText("ordinary widget", { exact: true }).waitFor();
  await page.locator("button.extension-widget-trigger").filter({ hasText: "subagent-async" }).click();
  await page.getByText("Reviewer", { exact: true }).waitFor();
  await page.locator("#switch").click();
  // React commits the new session's tree asynchronously; poll for the old
  // panel's removal instead of demanding it in the same task as the click.
  await page.waitForFunction(() => document.querySelectorAll(".subagent-fleet-panel").length === 0);
  await tag.click();
  await page.getByText("Reviewer", { exact: true }).waitFor();
  assert.ok(requests.at(-1).url.includes("/b/subagents"));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator(".extension-widget-panels").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  // Escape from inside the panel collapses the tag and never reaches the
  // window-level shortcut that stops the running agent.
  await page.locator(".subagent-fleet-action").first().focus();
  const escapesBefore = await page.evaluate(() => window.__escapesToWindow ?? 0);
  await page.keyboard.press("Escape");
  // The panel collapses in its own keydown handler, which React flushes
  // asynchronously: poll the attribute instead of reading it synchronously.
  await page.waitForFunction((element) => element.getAttribute("aria-expanded") === "false", await tag.elementHandle());
  await page.waitForFunction((before) => (window.__escapesToWindow ?? 0) === before, escapesBefore);
  // Same from the still-focused trigger, which is where a plain global Escape
  // handler would abort the running agent.
  await tag.click();
  await page.getByText("Reviewer", { exact: true }).waitFor();
  await tag.focus();
  await page.keyboard.press("Escape");
  await page.waitForFunction((element) => element.getAttribute("aria-expanded") === "false", await tag.elementHandle());
  await page.waitForFunction((before) => (window.__escapesToWindow ?? 0) === before, escapesBefore);
  // Collapsed again, Escape is not swallowed: it is the global shortcut's.
  assert.equal(await page.evaluate(() => document.activeElement?.className), "extension-widget-trigger");
  await page.keyboard.press("Escape");
  await page.waitForFunction((before) => (window.__escapesToWindow ?? 0) === before + 1, escapesBefore);
  assert.deepEqual(errors, []);
  console.log("PASS: composer tag opens native controls; inspect/steer/child-stop, steer-mode wire value, collapse, session isolation, generic widgets, mobile, height cap and Escape");
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
