// Test-only browser bridge; not an OS WebView or capability proof.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { build } from "../../static-frontend/node_modules/vite/dist/node/index.js";
import JSZip from "jszip";
import { buildProjectionInto } from "./build-management-modules.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sandbox = await mkdtemp(join(tmpdir(), "resource-static-"));
let harness, browser, page, url, token;
try {
  const project = join(sandbox, "project"), agent = join(sandbox, "agent"), home = join(sandbox, "home"), dist = join(sandbox, "dist"), managed = join(sandbox, "managed", "node_modules");
  await Promise.all([mkdir(project), mkdir(agent), mkdir(home), mkdir(managed, { recursive: true })]);
  for (const name of await readdir(join(root, "node_modules"))) {
    if (name !== ".bin") await symlink(join(root, "node_modules", name), join(managed, name), "dir");
  }
  await buildProjectionInto(managed);
  await writeFile(join(project, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  await writeFile(join(project, "index.html"), '<!doctype html><link rel="stylesheet" href="style.css"><p id="fixture">preview</p><script>parent.__previewScriptRan=true</script>');
  await writeFile(join(project, "style.css"), "#fixture { color: rgb(12, 34, 56) }");
  await writeFile(join(sandbox, "secret.txt"), "not authorized");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX fixture content</w:t></w:r></w:p></w:body></w:document>');
  await writeFile(join(project, "document.docx"), await zip.generateAsync({ type: "nodebuffer" }));
  await build({ configFile: join(root, "static-frontend/vite.config.ts"), logLevel: "error", build: { outDir: dist, emptyOutDir: true, rollupOptions: { input: join(root, "scripts/migration/resource-fixture.html") } } });
  async function findHtml(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { const found = await findHtml(path); if (found) return found; }
      else if (entry.name === "resource-fixture.html") return path;
    }
  }
  const html = await findHtml(dist); assert.ok(html);
  token = randomBytes(32).toString("hex");
  harness = spawn(join(root, "target/debug/static-ui-harness"), ["--static-dir", dist, "--port", "0"], {
    cwd: join(root, "src-tauri"), detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PI_CLI_BIN: "/home/hao/.pi/agent/bin/pi", PI_WEB_MANAGED_MODULES: managed, STATIC_UI_HARNESS_TOKEN: token, STATIC_UI_HARNESS_FIXTURE_ROOT: project, PI_PACKAGE_DIR: undefined, PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: undefined, JITI_ALIAS: undefined },
  });
  let logs = ""; harness.stderr.on("data", chunk => { logs += chunk; });
  url = await Promise.race([new Promise((ready, reject) => {
    let output = "";
    harness.stdout.on("data", chunk => { output += chunk; const line = output.split("\n").find(x => x.includes('"harness":"ready"')); if (line) ready(`http://127.0.0.1:${JSON.parse(line).port}`); });
    harness.once("exit", code => reject(new Error(`harness exited ${code}: ${logs}`)));
  }), delay(20_000).then(() => { throw new Error("harness startup timeout"); })]);
  browser = await chromium.launch({ headless: true, executablePath: join(process.env.HOME || "", ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome") });
  page = await browser.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const polyfill = await readFile(join(root, "scripts/migration/static-ui-harness-polyfill.js"), "utf8");
  await page.addInitScript(`window.__STATIC_UI_HARNESS_TOKEN__ = ${JSON.stringify(token)}; ${polyfill}`);
  await page.goto(`${url}${html.slice(dist.length)}?cwd=${encodeURIComponent(project)}`);
  await page.waitForFunction(() => { const img = document.querySelector(".markdown-image img"); return img instanceof HTMLImageElement && img.complete && img.naturalWidth === 1; }, null, { timeout: 20_000 });
  const frame = page.frameLocator('.file-viewer-content iframe').first();
  await frame.locator("#fixture").waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => { const f = document.querySelector('.file-viewer-content iframe'); return f?.contentDocument?.querySelector('#fixture') && getComputedStyle(f.contentDocument.querySelector('#fixture')).color === 'rgb(12, 34, 56)'; });
  assert.equal(await page.evaluate(() => window.__previewScriptRan), undefined);
  await page.frameLocator('.file-viewer-document-stage iframe').getByText('DOCX fixture content').waitFor({ timeout: 30_000 });
  await writeFile(join(project, "index.html"), '<!doctype html><link rel="stylesheet" href="style.css"><p id="fixture">updated preview</p>');
  await frame.getByText("updated preview").waitFor({ timeout: 10_000 });
  await page.locator('input[type="file"]').setInputFiles({ name: "uploaded.txt", mimeType: "text/plain", buffer: Buffer.from("browser fixture") });
  for (let attempts = 0; attempts < 100; attempts++) {
    try { if ((await readFile(join(project, "uploaded.txt"), "utf8")) === "browser fixture") break; } catch {}
    await delay(50);
  }
  assert.equal(await readFile(join(project, "uploaded.txt"), "utf8"), "browser fixture");
  const checks = await page.evaluate(async ({ project, outside }) => {
    const call = async (id, op, args) => window.__TAURI_INTERNALS__.invoke("pi_ipc", { request: { v: 1, id, op, args } });
    const denied = await call("outside", "resources.grantFile", { path: outside });
    const grant = await call("file", "resources.grantFile", { path: `${project}/style.css` });
    const resource = `/__harness__/resource/${grant.data.handle}`;
    const ranged = await fetch(resource, { headers: { range: "bytes=0-6" } });
    const text = await ranged.text();
    const contentRange = ranged.headers.get("content-range");
    await call("revoke", "resources.revoke", { handle: grant.data.handle });
    const revoked = await fetch(resource);
    return { denied: denied.error.code, status: ranged.status, text, contentRange, revoked: revoked.status };
  }, { project, outside: join(sandbox, "secret.txt") });
  assert.deepEqual(checks, { denied: "unauthorized_scope", status: 206, text: "#fixtur", contentRange: "bytes 0-6/35", revoked: 404 });
  assert.deepEqual(errors, []);
  console.log("resource static UI: Markdown image, live HTML/CSS preview, DOCX via real pi, upload, range/revoke and script blocking passed (browser bridge, not native ACL)");
} catch (error) {
  if (page) console.error("resource fixture:", await page.locator("body").innerHTML().catch(() => "unavailable"), await page.evaluate(() => window.__harnessInvokes).catch(() => []));
  throw error;
} finally {
  if (browser) await browser.close();
  if (harness && harness.exitCode === null) {
    if (url) await fetch(`${url}/__harness__/shutdown`, { method: "POST", headers: { "x-harness-token": token }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
    await Promise.race([new Promise(resolve => harness.once("exit", resolve)), delay(3000)]);
    if (harness.exitCode === null) { try { process.kill(-harness.pid, "SIGTERM"); } catch {} }
  }
  await rm(sandbox, { recursive: true, force: true });
}
