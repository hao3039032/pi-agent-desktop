// Test-only browser bridge: actual TerminalPanel, Rust host and real PTY.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { build } from "../../static-frontend/node_modules/vite/dist/node/index.js";
import { buildProjectionInto } from "./build-management-modules.mjs";

if (process.platform !== "linux") {
  console.log("SKIP: terminal static UI fixture currently exercises Linux only");
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sandbox = await mkdtemp(join(tmpdir(), "terminal-static-"));
let harness, browser, page, harnessUrl, token;
try {
  const project = join(sandbox, "project"), agent = join(sandbox, "agent"), home = join(sandbox, "home");
  const managed = join(sandbox, "managed"), dist = join(sandbox, "dist");
  await Promise.all([mkdir(project), mkdir(agent), mkdir(home)]);
  await buildProjectionInto(managed);
  await build({ configFile: join(root, "static-frontend/vite.config.ts"), logLevel: "error", build: { outDir: dist, emptyOutDir: true, rollupOptions: { input: join(root, "scripts/migration/terminal-fixture.html") } } });
  async function findHtml(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isDirectory()) { const nested = await findHtml(path); if (nested) return nested; }
      else if (ent.name === "terminal-fixture.html") return path;
    }
    return null;
  }
  const html = await findHtml(dist);
  assert.ok(html, "fixture built");
  token = randomBytes(32).toString("hex");
  harness = spawn(join(root, "target/debug/static-ui-harness"), ["--static-dir", dist, "--port", "0"], {
    cwd: join(root, "src-tauri"), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, SHELL: process.env.TERMINAL_TEST_SHELL || "/bin/sh", PI_CODING_AGENT_DIR: agent, PI_CLI_BIN: process.env.PI_CLI_BIN || "/home/hao/.pi/agent/bin/pi", PI_WEB_MANAGED_MODULES: managed, STATIC_UI_HARNESS_TOKEN: token, PI_PACKAGE_DIR: undefined, PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: undefined, JITI_ALIAS: undefined },
  });
  let logs = "";
  harness.stderr.on("data", chunk => { logs += chunk; });
  harnessUrl = await Promise.race([new Promise((resolveReady, reject) => {
    let out = "";
    harness.stdout.on("data", chunk => {
      out += chunk;
      const line = out.split("\n").find(line => line.includes('"harness":"ready"'));
      if (line) resolveReady(`http://127.0.0.1:${JSON.parse(line).port}`);
    });
    harness.once("exit", code => reject(new Error(`harness exited ${code}: ${logs}`)));
  }), delay(20_000).then(() => { throw new Error("harness startup timeout"); })]);
  browser = await chromium.launch({ headless: true, executablePath: process.env.TERMINAL_TEST_CHROMIUM || join(process.env.HOME || "", ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome") });
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const polyfill = await readFile(join(root, "scripts/migration/static-ui-harness-polyfill.js"), "utf8");
  await page.addInitScript(`window.__STATIC_UI_HARNESS_TOKEN__ = ${JSON.stringify(token)}; ${polyfill}
    window.__terminalCalls = [];
    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (cmd, args, options) => {
      if (cmd === 'pi_ipc') window.__terminalCalls.push(args.request);
      return originalInvoke(cmd, args, options);
    };`);
  const relative = html.slice(dist.length).replaceAll("\\", "/");
  await page.goto(`${harnessUrl}${relative}?cwd=${encodeURIComponent(project)}`);
  await page.locator(".terminal-status-dot.is-ready").waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => window.__terminalCalls.some(call => call.op === "terminal.resize"));
  const resizeCount = await page.evaluate(() => window.__terminalCalls.filter(call => call.op === "terminal.resize").length);
  await page.locator(".terminal-panel").evaluate(panel => { panel.parentElement.style.width = "600px"; });
  await page.waitForFunction(count => window.__terminalCalls.filter(call => call.op === "terminal.resize").length > count, resizeCount);
  const picker = page.locator(".settings-terminal-option .app-select-trigger");
  await picker.click();
  const choice = page.getByRole("option").nth(1);
  const selectedLabel = await choice.innerText();
  await choice.click();
  await page.waitForFunction(() => window.__terminalCalls.some(call => call.op === "terminal.settingsSet"));
  await page.waitForFunction(label => document.querySelector(".settings-terminal-option .app-select-trigger")?.textContent.includes(label), selectedLabel);
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("printf 'terminal-test-42\\n'", { delay: 2 });
  await page.keyboard.press("Enter");
  await page.getByText("terminal-test-42", { exact: false }).first().waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Other tab" }).click();
  await page.getByRole("button", { name: "Terminal tab" }).click();
  await page.reload();
  await page.locator(".terminal-status-dot.is-ready").waitFor({ timeout: 20_000 });
  await page.getByText("terminal-test-42", { exact: false }).first().waitFor({ timeout: 10_000 });
  await page.waitForFunction(label => document.querySelector(".settings-terminal-option .app-select-trigger")?.textContent.includes(label), selectedLabel);
  const settings = JSON.parse(await readFile(join(agent, "pi-web/settings.json"), "utf8"));
  assert.notEqual(settings.terminalShell, "auto");
  await page.getByRole("button", { name: "Close fixture terminal" }).click();
  await page.getByText("Fixture terminal closed").waitFor({ timeout: 10_000 });
  assert.deepEqual(errors, []);
  console.log("terminal static UI: input/output, resize, settings persistence, tab switch, reload reconnect and close passed (real Rust/PTy)");
} catch (error) {
  if (page) console.error("terminal fixture state:", await page.locator("body").innerText().catch(() => "unavailable"), "invokes:", await page.evaluate(() => window.__harnessInvokes).catch(() => []));
  throw error;
} finally {
  if (browser) await browser.close();
  if (harness && harness.exitCode === null) {
    if (harnessUrl) await fetch(`${harnessUrl}/__harness__/shutdown`, { method: "POST", headers: { "x-harness-token": token }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
    await Promise.race([new Promise(resolve => harness.once("exit", resolve)), delay(3000)]);
    if (harness.exitCode === null) {
      if (process.platform !== "win32") { try { process.kill(-harness.pid, "SIGTERM"); } catch {} }
      else harness.kill();
      await Promise.race([new Promise(resolve => harness.once("exit", resolve)), delay(3000)]);
    }
  }
  await rm(sandbox, { recursive: true, force: true });
}
