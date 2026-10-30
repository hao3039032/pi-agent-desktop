import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";

const out = "test-results/conversation-find";
await mkdir(out, { recursive: true });
await build({ entryPoints: ["e2e/conversation-find.fixture.tsx"], bundle: true, platform: "browser", format: "iife", outfile: `${out}/fixture.js`, define: { "process.env.NODE_ENV": '"production"' }, jsx: "automatic", logLevel: "warning" });
const js = await readFile(`${out}/fixture.js`);
const css = (await Promise.all(["app/globals.css", "app/settings.css", "app/native-theme.css"].map((p) => readFile(p, "utf8")))).map((text) => text.replace(/^@import[^;]*;/gm, "")).join("\n") + "\n*{box-sizing:border-box}body{margin:0}";
const server = createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/fixture.js" ? "text/javascript" : req.url === "/style.css" ? "text/css" : "text/html; charset=utf-8");
  res.end(req.url === "/fixture.js" ? js : req.url === "/style.css" ? css : '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate((theme) => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
    const composer = page.getByRole("textbox", { name: "Composer" });
    await composer.focus(); await page.keyboard.press("Control+f");
    const input = page.getByRole("textbox", { name: "Find in conversation" });
    await input.fill("needle");
    const count = page.locator(".conversation-find-count");
    await count.filter({ hasText: "1 / 3" }).waitFor();
    assert.equal(await page.evaluate(() => CSS.highlights.get("conversation-find").size), 3);
    await input.press("Enter"); await count.filter({ hasText: "2 / 3" }).waitFor();
    await input.press("Shift+Enter"); await count.filter({ hasText: "1 / 3" }).waitFor();
    await input.press("Shift+Enter"); await count.filter({ hasText: "3 / 3" }).waitFor();
    assert.ok(await page.locator(".chat-scroll-container").evaluate((el) => el.scrollTop) > 500);
    await input.fill("in bold text"); await count.filter({ hasText: "1 / 1" }).waitFor();
    await input.fill("[a+b]"); await count.filter({ hasText: "1 / 1" }).waitFor();
    await input.fill("中文"); await count.filter({ hasText: "1 / 1" }).waitFor();
    for (const query of ["not here", "breakstartbreakend", "parentstartparentend", "beforeafter"]) {
      await input.fill(query); await count.filter({ hasText: "0 / 0" }).waitFor();
    }
    await input.fill("nested"); await count.filter({ hasText: "1 / 1" }).waitFor();
    await input.fill("needle");
    await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
    await count.filter({ hasText: "2 / 4" }).waitFor();
    await page.getByRole("button", { name: "Expand details" }).click();
    await count.filter({ hasText: "2 / 5" }).waitFor();
    await input.press("Enter"); await count.filter({ hasText: "3 / 5" }).waitFor();
    const scrollport = page.locator(".chat-scroll-container");
    const beforeStream = await scrollport.evaluate((el) => el.scrollTop);
    await page.getByRole("button", { name: "Stream update" }).evaluate((el) => el.click());
    await count.filter({ hasText: "3 / 6" }).waitFor();
    assert.equal(await scrollport.evaluate((el) => el.scrollTop), beforeStream);
    await page.getByRole("button", { name: "Unrelated update" }).evaluate((el) => el.click());
    await count.filter({ hasText: "3 / 5" }).waitFor();
    assert.equal(await scrollport.evaluate((el) => el.scrollTop), beforeStream);
    await input.focus(); await input.press("Escape");
    await page.getByRole("search").waitFor({ state: "detached" });
    assert.equal(await composer.evaluate((el) => document.activeElement === el), true);
    assert.equal(await page.evaluate(() => CSS.highlights.has("conversation-find")), false);
    await page.keyboard.press("Meta+f"); await input.waitFor();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: `${out}/${theme}-${width}.png` });
    }
    // Real CodeBlock keeps folded text in the DOM; none of it is searchable
    // until explicitly expanded. Folding must refresh results without typing.
    await input.fill("folded-tail-target");
    await count.filter({ hasText: "0 / 0" }).waitFor();
    await page.locator(".markdown-code-fold").click();
    await count.filter({ hasText: "1 / 1" }).waitFor();
    await input.press("Enter");
    await page.locator(".markdown-code-fold").click();
    await count.filter({ hasText: "0 / 0" }).waitFor();
    await page.getByRole("button", { name: "Switch session" }).click();
    await page.getByRole("search").waitFor({ state: "detached" });
    await page.locator("#file-panel").focus(); await page.keyboard.press("Control+f");
    assert.equal(await page.getByRole("search").count(), 0);
    // AppShell keeps ChatWindow mounted behind an inert Scheduled/full-width surface.
    for (const attribute of ["inert", "hidden", "aria-hidden"]) {
      await page.evaluate((attribute) => {
        const chat = document.querySelector(".chat-window");
        const wrapper = document.createElement("div"); wrapper.id = "inactive-chat";
        wrapper.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
        chat.before(wrapper); wrapper.append(chat);
        const outside = document.createElement("button"); outside.id = "overlay"; outside.textContent = "Overlay";
        document.body.append(outside); outside.focus();
      }, attribute);
      const prevented = await page.evaluate(() => {
        const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
        document.querySelector("#overlay").dispatchEvent(event); return event.defaultPrevented;
      });
      assert.equal(prevented, false, `${attribute} conversation must not take find`);
      assert.equal(await page.getByRole("search").count(), 0);
      await page.evaluate(() => { const wrapper = document.querySelector("#inactive-chat"); wrapper.replaceWith(wrapper.firstElementChild); document.querySelector("#overlay").remove(); });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  // Real ChatWindow + real session hook: two messages per turn become three
  // render items (user/process/answer). The local window must use render items,
  // not messages.length, and the reveal must not leak across session switches.
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const messages = Array.from({ length: 30 }, (_, i) => [
      { role: "user", content: `User turn ${i}`, timestamp: i * 2 },
      { role: "assistant", content: [{ type: "thinking", thinking: `Private reasoning ${i}` },
        { type: "text", text: `Answer turn ${i}: history-target-${i}` }],
        api: "anthropic-messages", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: i * 2 + 1 },
    ]).flat();
    const entryIds = messages.map((_, i) => `entry-${i}`);
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const id = path.split("/")[3];
      let data = {};
      if (path.startsWith("/api/sessions/")) data = path.endsWith("/state") ? { running: false } : {
        sessionId: id, tree: [], leafId: entryIds.at(-1), filePath: "", totalActiveMs: 0,
        context: { messages, entryIds, oldestEntryId: entryIds[0], hasMore: false, thinkingLevel: "off", model: null },
      };
      else if (path.startsWith("/api/models")) data = { models: {}, modelList: [] };
      else if (path === "/api/agent/running") data = { sessions: [] };
      else if (path.startsWith("/api/agent/")) data = { running: false, state: { isStreaming: false }, success: true, data: [] };
      await route.fulfill({ json: data });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?history`);
    await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
    await page.getByText("Answer turn 29: history-target-29", { exact: true }).waitFor();
    assert.equal(await page.getByText("Answer turn 0: history-target-0", { exact: true }).count(), 0);
    await page.keyboard.press("Control+f");
    const input = page.getByRole("textbox", { name: "Find in conversation" });
    await input.fill("history-target-");
    await page.locator(".conversation-find-count").filter({ hasText: "1 / 30" }).waitFor();
    await input.fill("history-target-0");
    await page.locator(".conversation-find-count").filter({ hasText: "1 / 1" }).waitFor();
    await input.fill("Private reasoning");
    await page.locator(".conversation-find-count").filter({ hasText: "0 / 0" }).waitFor();
    await page.getByRole("button", { name: "Switch history session" }).click();
    await page.getByRole("search").waitFor({ state: "detached" });
    await page.getByText("Answer turn 29: history-target-29", { exact: true }).waitFor();
    assert.equal(await page.getByText("Answer turn 0: history-target-0", { exact: true }).count(), 0);
    await page.keyboard.press("Control+f");
    await input.fill("history-target-");
    await page.locator(".conversation-find-count").filter({ hasText: "1 / 30" }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log("PASS: conversation find, real ChatWindow split history, folded CodeBlock, light/dark, 320–1280px, shortcuts, navigation, streaming and scope reset");
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
