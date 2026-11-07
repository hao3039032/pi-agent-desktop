import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright';

const out='test-results/access-settings';
await mkdir(out,{recursive:true});
await build({entryPoints:['e2e/access-settings.fixture.jsx'],bundle:true,platform:'browser',format:'iife',outfile:`${out}/fixture.js`,jsx:'automatic',define:{'process.env':'{"NODE_ENV":"production"}'},plugins:[{
  name:'isolated-desktop',setup(b){
    b.onResolve({filter:/^@\/lib\/desktop-native$/},()=>({path:'desktop',namespace:'mock'}));
    b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:`
      let enabled=true, saved=false;
      export async function getLanAccessNative(){return enabled;}
      export async function setLanAccessNative(value){enabled=value;}
      export async function lanAddressesNative(){return {port:38472,lanListening:true,addresses:[{address:'192.168.1.25',interface:'Wi-Fi'},{address:'172.20.0.1',interface:'vEthernet (Hyper-V)'}]};}
      export async function browserPasswordNative(method){if(method==='PUT')saved=true;return {enabled:saved,managed:false,corrupt:false};}
      export function isBrowserPasswordUsable(s){return !!(s&&(s.managed||(s.enabled&&!s.corrupt)));}
      export function handleExternalLinkClick(event,url){event.preventDefault();window.__opened=url;}
    `}));
  }
}]});
const js=await readFile(`${out}/fixture.js`);
const css=(await Promise.all(['app/globals.css','app/settings.css','app/native-theme.css'].map(p=>readFile(p,'utf8')))).map(s=>s.replace(/^@import[^;]*;/gm,'')).join('\n');
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':req.url==='/style.css'?'text/css':'text/html');res.end(req.url==='/fixture.js'?js:req.url==='/style.css'?css:'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({channel:process.env.E2E_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const theme of ['light','dark']) for(const width of [1280,390,320]) {
    const page=await browser.newPage({viewport:{width,height:720}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
    await page.addInitScript(()=>localStorage.setItem('pi-locale','zh-CN'));
    await page.goto(base+'/?picker');
    await page.evaluate(t=>document.documentElement.classList.toggle('dark',t==='dark'),theme);
    const shell=page.locator('.project-picker-modal-shell');
    await shell.locator('input').fill('project');
    assert.equal(await shell.locator('button[title]').count(),20);
    const box=await shell.boundingBox();
    assert.ok(box.height>200&&box.x>=0&&box.x+box.width<=width&&box.y+box.height<=720,JSON.stringify(box));
    await shell.locator('button[title]').last().click();
    assert.equal(await page.evaluate(()=>window.__selected),'C:/projects/project-19');
    await page.screenshot({path:`${out}/picker-${theme}-${width}.png`});
    // Short viewports must not clip the final action below the scroll area.
    await page.setViewportSize({width,height:320});
    const action=await shell.getByRole('button',{name:'Open Folder…',exact:true}).boundingBox();
    const shortShell=await shell.boundingBox();
    assert.ok(action.y+action.height<=shortShell.y+shortShell.height,JSON.stringify({action,shortShell}));
    await page.setViewportSize({width,height:720});
    await page.goto(base);
    await page.evaluate(t=>document.documentElement.classList.toggle('dark',t==='dark'),theme);
    const url=page.getByRole('link',{name:'http://192.168.1.25:38472',exact:true});
    const inputs=page.locator('input[type=password]');
    await inputs.first().fill('123456');await inputs.last().fill('123456');
    assert.ok(await page.getByRole('button',{name:'设置密码',exact:true}).isDisabled());
    await inputs.first().fill('123456789012');await inputs.last().fill('123456789012');
    assert.ok(await page.getByRole('button',{name:'设置密码',exact:true}).isEnabled());
    const lanSwitch=page.getByRole('switch');
    assert.ok(await lanSwitch.isEnabled(),'an existing network preference can always be turned off');
    await lanSwitch.click();
    await page.waitForFunction(()=>document.querySelector('[role="switch"]')?.hasAttribute('disabled'));
    assert.ok(await lanSwitch.isDisabled(),'without a password it cannot be turned back on');
    await page.getByRole('button',{name:'设置密码',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[role="switch"]')?.hasAttribute('disabled'));
    assert.ok(await lanSwitch.isEnabled(),'saving the password makes the switch usable immediately');
    await lanSwitch.click();
    await page.getByRole('dialog').waitFor();
    await page.screenshot({path:`${out}/confirm-${theme}-${width}.png`});
    await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
    await lanSwitch.click();
    await page.getByRole('dialog').locator('button').last().click();
    await url.waitFor();
    await url.click();assert.equal(await page.evaluate(()=>window.__opened),'http://192.168.1.25:38472');
    assert.ok(await url.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'full URL wraps instead of clipping');
    await page.screenshot({path:`${out}/lan-${theme}-${width}.png`});
    assert.deepEqual(errors,[]);await page.close();
  }
  console.log('PASS: isolated actual LAN/password/picker components, light/dark at 1280/390/320, short viewport, live validation, clickable URLs and in-app confirmation.');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
