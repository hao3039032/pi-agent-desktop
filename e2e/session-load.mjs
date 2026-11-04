import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

// Real component + app styles, no session files, model calls or Next build.
const out = 'test-results/session-load';
await mkdir(out, { recursive: true });
await build({ entryPoints: ['e2e/session-load.fixture.tsx'], bundle: true, platform: 'browser', jsx: 'automatic',
  outfile: `${out}/fixture.js`, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning' });
const script = await readFile(`${out}/fixture.js`);
const css = (await Promise.all(['app/globals.css', 'app/settings.css', 'app/native-theme.css'].map(p => readFile(p, 'utf8'))))
  .map(s => s.replace(/^@import[^;]*;/gm, '')).join('\n');
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(script); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><script src="/fixture.js"></script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const theme of ['light', 'dark']) for (const width of [1280, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 720 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('pi-locale', 'zh-CN'));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await page.getByRole('button', { name: 'slow', exact: true }).click();
    assert.match(await page.getByRole('status').innerText(), /打开时间比平时稍长/);
    await page.getByRole('button', { name: 'retrying', exact: true }).click();
    assert.match(await page.getByRole('status').innerText(), /自动重试/);
    await page.getByRole('button', { name: 'failed', exact: true }).click();
    assert.match(await page.getByRole('status').innerText(), /暂时无法打开/);
    assert.equal(await page.locator('.session-load-diagnostics pre').isVisible(), false);
    await page.locator('.session-load-diagnostics summary').click();
    assert.equal(await page.locator('.session-load-diagnostics pre').isVisible(), true);
    await page.getByRole('button', { name: '重新打开会话', exact: true }).click();
    assert.equal(await page.locator('.session-load-diagnostics').count(), 0);
    await page.getByRole('button', { name: 'cache', exact: true }).click();
    await page.getByTestId('history').evaluate(el => { window.savedHistoryNode = el; });
    await page.getByRole('button', { name: 'failed', exact: true }).click();
    assert.equal(await page.getByTestId('history').isVisible(), true);
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid="history"]') === window.savedHistoryNode), true);
    assert.match(await page.getByRole('status').innerText(), /已显示的对话仍然保留/);
    await page.screenshot({ path: `${out}/sync-failure-${theme}-${width}.png` });
    await page.getByRole('button', { name: '重新同步', exact: true }).click();
    assert.equal(await page.getByTestId('history').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS: session load progress/recovery, cached history retention, collapsed diagnostics, light/dark at 1280/390/320px');
} finally { await browser?.close(); await new Promise(r => server.close(r)); }
