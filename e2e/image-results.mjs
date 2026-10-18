// Isolated component-browser regression: no Next server, model calls or real session files.
// Run: node e2e/image-results.mjs (PLAYWRIGHT_CHANNEL=msedge if bundled Chromium is absent).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "./hooks/useI18n";
import { TurnImageOwner } from "./components/TurnResultImages";
import { MessageView } from "./components/MessageView";
import { collectTurnResultImages } from "./lib/turn-result-images";
const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
const image = { type: "image", source: { type: "base64", media_type: "image/png", data } };
const message = { role: "assistant", content: [{ type: "toolCall", toolCallId: "g", toolName: "bash", input: { command: "imagegen" } }] };
const result = { role: "toolResult", toolCallId: "g", content: [image], details: { modelImages: { version: 1, outputs: [{ kind: "generated-image", blockIndex: 0 }] } } };
function Trace({ done, results }) {
  const [open, setOpen] = useState(!done);
  return <div className="process-details"><button id="trace-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>Process details</button>{open && <MessageView message={message} toolResults={results} />}</div>;
}
function App() {
  const [done, setDone] = useState(false);
  const [count, setCount] = useState(1);
  const [deferred, setDeferred] = useState(false);
  const results = new Map([["g", deferred ? { ...result, content: [{ type: "image", source: { type: "url", media_type: "image/png", url: "/image.png" } }] } : result]]);
  const base = collectTurnResultImages([message, result], results);
  const images = Array.from({ length: count }, (_, index) => ({ ...base[0], key: "image:" + index }));
  return <I18nProvider><button id="finish" onClick={() => setDone(true)}>Finish</button><button id="many" onClick={() => setCount(6)}>Six images</button><button id="defer" onClick={() => setDeferred(true)}>History URL</button><TurnImageOwner id="gallery" images={images}><Trace key={done ? "answered" : "unanswered"} done={done} results={results} /></TurnImageOwner>{done && <p>Final answer</p>}</I18nProvider>;
}
createRoot(document.getElementById("root")).render(<App />);
`;
const bundle = await build({
  stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: "image-results-fixture.tsx", loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"', "process.env.NODE_TEST_CONTEXT": '"1"', "process.env": "{}" },
  logLevel: "silent",
});
const css = await readFile(new URL("../app/native-theme.css", import.meta.url), "utf8");
const baseCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const server = createServer((req, res) => {
  if (req.url === "/image.png") { res.statusCode = 503; res.end("temporarily unavailable"); return; }
  if (req.url === "/app.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
  if (req.url === "/app.css") { res.setHeader("Content-Type", "text/css"); res.end(baseCss + "\n" + css); return; }
  res.setHeader("Content-Type", "text/html");
  res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><main style="max-width:720px;margin:24px auto"><div id="root"></div></main><script src="/app.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  try {
    await page.locator("#gallery img").waitFor({ timeout: 10000 });
  } catch (error) {
    console.error({ errors, body: await page.locator("body").innerText() });
    throw error;
  }
  assert.equal(await page.locator("img").count(), 1, "no duplicate inside trace");
  await page.locator("#gallery img").evaluate((element) => { window.originalImage = element; });
  await page.locator("#finish").click();
  assert.equal(await page.locator("#trace-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator("#gallery img").isVisible(), true);
  assert.equal(await page.locator("#gallery img").evaluate((element) => element === window.originalImage), true, "completion does not remount image");
  await page.locator("#trace-toggle").click();
  assert.equal(await page.locator("img").count(), 1);
  await page.locator("#gallery .result-image-preview").click();
  assert.equal(await page.locator("dialog").evaluate((element) => element.open), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("dialog").count(), 0);
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#gallery .result-image-save").click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), "image-1.png");
  await download.cancel();
  await page.locator("#many").click();
  assert.equal(await page.locator("#gallery img").count(), 4);
  await page.locator("#gallery > button").click();
  assert.equal(await page.locator("#gallery img").count(), 6);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator("#gallery").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await page.locator("#defer").click();
  await page.getByText("Image could not be loaded.", { exact: false }).first().waitFor();
  await page.route("**/image.png", (route) => route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64") }));
  await page.getByRole("button", { name: "Retry", exact: true }).first().click();
  await page.locator("#gallery img").first().waitFor();
  assert.equal(await page.locator("#gallery img").first().evaluate((element) => element.complete && element.naturalWidth > 0), true);
  assert.deepEqual(errors, []);
  console.log("PASS: completion retains image DOM, trace has no duplicate, preview/Escape, save, bounded gallery, mobile layout, deferred URL and load retry");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
