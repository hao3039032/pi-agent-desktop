// Isolated React integration: real session hook + composer, fake HTTP/SSE, no model or user data.
// node e2e/session-submission.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const fixture = `
import React, { useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './hooks/useI18n';
import { useAgentSession } from './hooks/useAgentSession';
import { ChatInput } from './components/ChatInput';
window.calls = [];
window.running = new Set(new URLSearchParams(location.search).has('cold') || new URLSearchParams(location.search).has('history') ? [] : ['A']);
window.holdStartup = new URLSearchParams(location.search).has('cold');
window.readyStartup = () => { window.holdStartup = false; for (const source of sources) if (source.readyState === 1) source.connect(); };
window.held = [];
window.hold = new URLSearchParams(location.search).has('history') ? '/api/sessions/A?' : null;
window.historyById = new Map();
window.release = () => { window.hold = null; window.holdAdmission = false; window.held.splice(0).forEach(fn => fn()); };
const sources = [];
window.EventSource = class {
  readyState = 1;
  constructor(url) {
    this.sid = url.split('/')[3]; sources.push(this);
    if (!window.holdStartup) setTimeout(() => this.connect(), 0);
  }
  connect() { this.onmessage?.({data:JSON.stringify({type:'connected', isStreaming:window.running.has(this.sid)})}); }
  close() { this.readyState = 2; }
};
window.fetch = async (url, options = {}) => {
  url = String(url); const body = options.body ? JSON.parse(options.body) : null;
  window.calls.push({url, body});
  const savedHistory = [...(window.historyById.get(url.split('/')[3]?.split('?')[0]) ?? [])];
  if ((window.hold && url.includes(window.hold)) || (window.holdAdmission && body?.type === 'prompt')) await new Promise(resolve => window.held.push(resolve));
  const sid = url.split('/')[3]?.split('?')[0];
  let data = {};
  if (url === '/api/agent/new') data = {sessionId:'new-' + (++window.sequence), model:null};
  else if (url.startsWith('/api/models')) data = { models:{}, modelList:[] };
  else if (url.endsWith('/reference')) data = { sessionId:'ref', messages:[], name:'reference' };
  else if (url === '/api/sessions') data = { sessions:[{id:'ref', name:'reference'}] };
  else if (url.startsWith('/api/sessions/')) {
    data = url.endsWith('/state') ? { running:true, state:{isStreaming:window.running.has(sid)} } : {
      sessionId:sid, tree:[], leafId:null, filePath:'', totalActiveMs:0,
      context:{ messages:savedHistory, entryIds:[], oldestEntryId:null, hasMore:false, thinkingLevel:'off', model:null },
    };
  } else if (body) {
    if (body.type === 'prompt') {
      window.running.add(sid);
      window.historyById.set(sid,[{role:'user',content:body.message}]);
      for (const source of sources) if (source.sid === sid && source.readyState === 1) source.onmessage?.({data:JSON.stringify({type:'agent_start'})});
      if (window.holdReply) await new Promise((resolve,reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true});
      });
    }
    data = { success:true, data: body.type === 'get_tools' ? [] : {} };
  } else if (url.startsWith('/api/agent/')) data = {running:true, state:{isStreaming:window.running.has(sid)}};
  return {ok:true, status:200, json:async () => data};
};
window.sequence = 0;
const info = id => ({id,cwd:'/fixture',path:'',created:'',modified:'',messageCount:1,firstMessage:'fixture'});
function Chat({session, draft, onCreated}) {
  const inputRef = useRef(null);
  const h = useAgentSession({session,newSessionCwd:session ? null : '/fixture',newSessionDraftKey:draft,chatInputRef:inputRef,onSessionCreated:onCreated});
  return <><output id="state">{session?.id ?? draft}:{h.agentRunning ? 'running' : 'idle'}</output>
    <output id="preparing">{String(h.promptPreparing)}</output>
    <output id="notices">{h.notices.map(n => n.message).join('|')}</output>
    <button id="background-refresh" onClick={() => h.handleAgentEventRef.current({type:'compaction_end'})}>Background history refresh</button>
    <ChatInput ref={inputRef} draftKey={session?.id ?? draft} onSend={h.handleSend} onAbort={h.handleAbort}
      isStreaming={h.agentRunning || h.bashRunning} promptPreparing={h.promptPreparing} onSteer={h.agentRunning ? h.handleSteer : undefined}
      onFollowUp={h.agentRunning ? h.handleFollowUp : undefined} />
    <output id="messages">{h.messages.map(m => typeof m.content === 'string' ? m.content : '').join('|')}</output></>;
}
function App() {
  const [session,setSession] = useState(info('A'));
  const [key,setKey] = useState(0);
  const [draft,setDraft] = useState(null);
  const activeDraft = useRef(null);
  return <I18nProvider>
    <button id="new" onClick={() => { const d='draft-' + (key+1); activeDraft.current=d; setDraft(d);setSession(null);setKey(key+1); }}>New</button>
    <button id="a" onClick={() => {activeDraft.current=null;setSession(info('A'));}}>A</button>
    <button id="b" onClick={() => {activeDraft.current=null;setSession(info('B'));}}>B</button>
    <Chat key={key} session={session} draft={draft} onCreated={(s,source) => {if(activeDraft.current===source) {activeDraft.current=null;setSession(s);}}} />
  </I18nProvider>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
`;
const bundle = await build({
  stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: 'session-submission-fixture.tsx', loader: 'tsx' },
  bundle:true, write:false, platform:'browser', format:'iife', jsx:'automatic',
  define: { 'process.env.NODE_ENV':'"development"', 'process.env.NODE_TEST_CONTEXT':'"1"', 'process.env':'{}' }, logLevel:'silent',
});
const server = createServer((req,res) => {
  if (req.url === '/app.js') {res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>');
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {}), ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {}) });
  const page = await browser.newPage(); const errors=[];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'A:running');
  await page.locator('#new').click();
  await page.locator('textarea').fill('first message in new chat');
  await page.locator('textarea').press('Enter');
  await page.waitForFunction(() => window.calls.some(c => c.body?.message === 'first message in new chat'));
  const first = await page.evaluate(() => window.calls.filter(c => c.body?.message === 'first message in new chat'));
  assert.equal(first.length,1); assert.equal(first[0].url,'/api/agent/new-1');
  assert.equal(first[0].body.type,'prompt'); assert.equal(first[0].body.streamingBehavior,undefined);
  assert.match(await page.locator('#messages').innerText(), /first message in new chat/);
  assert.equal(await page.evaluate(() => window.running.has('A')),true);
  await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'new-1:running');
  await page.locator('textarea').fill('queued in new chat');
  await page.locator('textarea').press('Enter');
  await page.waitForFunction(() => window.calls.some(c => c.body?.message === 'queued in new chat'));
  const queued = await page.evaluate(() => window.calls.filter(c => c.body?.message === 'queued in new chat'));
  assert.equal(queued.length,1); assert.equal(queued[0].url,'/api/agent/new-1'); assert.equal(queued[0].body.type,'queue_composer');

  // Resolve a reference after switching to another persisted composer: neither
  // the old callback nor its clearInput may submit or erase the new draft.
  await page.locator('#b').click();
  await page.waitForFunction(() => document.querySelector('#state')?.textContent === 'B:idle');
  await page.evaluate(() => { window.hold='/reference'; });
  await page.locator('textarea').fill('review #"reference"');
  await page.locator('textarea').press('Enter');
  await page.waitForFunction(() => window.held.length > 0);
  await page.locator('#a').click();
  await page.locator('textarea').fill('keep A draft');
  const before = await page.evaluate(() => window.calls.filter(c => ['prompt','queue_composer'].includes(c.body?.type)).length);
  await page.evaluate(() => window.release());
  await page.waitForTimeout(100);
  assert.equal(await page.locator('textarea').inputValue(),'keep A draft');
  assert.equal(await page.evaluate(() => window.calls.filter(c => ['prompt','queue_composer'].includes(c.body?.type)).length),before);
  await page.locator('#b').click();
  assert.equal(await page.locator('textarea').inputValue(),'review #"reference"');
  await page.evaluate(() => { window.hold='/reference'; });
  await page.locator('textarea').press('Enter');
  await page.waitForFunction(() => window.held.length > 0);
  await page.locator('#a').click(); await page.locator('#b').click();
  await page.evaluate(() => window.release()); await page.waitForTimeout(100);
  assert.equal(await page.locator('textarea').inputValue(),'review #"reference"');
  assert.equal(await page.evaluate(() => window.calls.filter(c => ['prompt','queue_composer'].includes(c.body?.type)).length),before);
  assert.deepEqual(errors,[]);

  // A cold restored session has loaded history but its child has not finished
  // the SSE handshake. Online reconciliation must not mistake it for idle.
  const cold = await browser.newPage();
  cold.on('pageerror', error => errors.push(error.message));
  await cold.goto(`http://127.0.0.1:${server.address().port}/?cold=1`);
  await cold.waitForFunction(() => document.querySelector('#state')?.textContent === 'A:idle');
  await cold.locator('textarea').fill('cold first'); await cold.locator('textarea').press('Enter');
  await cold.waitForFunction(() => document.querySelector('#preparing')?.textContent === 'true');
  await cold.evaluate(() => window.dispatchEvent(new Event('online')));
  await cold.waitForTimeout(150);
  assert.equal(await cold.locator('#state').innerText(),'A:running');
  assert.equal(await cold.evaluate(() => window.calls.filter(c => c.body?.type === 'prompt').length),0);
  await cold.locator('textarea').fill('next draft'); await cold.locator('textarea').press('Enter');
  assert.equal(await cold.locator('textarea').inputValue(),'next draft');
  assert.equal(await cold.evaluate(() => window.calls.filter(c => c.body?.type === 'queue_composer').length),0);
  await cold.evaluate(() => window.readyStartup());
  await cold.waitForFunction(() => window.calls.some(c => c.body?.message === 'cold first'));
  await cold.waitForFunction(() => document.querySelector('#preparing')?.textContent === 'false');
  assert.equal(await cold.locator('textarea').inputValue(),'next draft');
  await cold.locator('textarea').press('Enter');
  await cold.waitForFunction(() => window.calls.some(c => c.body?.message === 'next draft'));
  const submissions = await cold.evaluate(() => window.calls.filter(c => c.body?.message === 'cold first' || c.body?.message === 'next draft').map(c => ({url:c.url,type:c.body.type,message:c.body.message})));
  assert.deepEqual(submissions,[{url:'/api/agent/A',type:'prompt',message:'cold first'},{url:'/api/agent/A',type:'queue_composer',message:'next draft'}]);
  assert.deepEqual(errors,[]); await cold.close();

  const slowHistory = await browser.newPage();
  slowHistory.on('pageerror', error => errors.push(error.message));
  await slowHistory.goto(`http://127.0.0.1:${server.address().port}/?history=1`);
  await slowHistory.waitForFunction(() => window.held.length > 0);
  await slowHistory.locator('textarea').fill('sent while history loads');
  await slowHistory.locator('textarea').press('Enter');
  await slowHistory.waitForFunction(() => window.calls.some(c => c.body?.message === 'sent while history loads'));
  await slowHistory.evaluate(() => window.release());
  await slowHistory.waitForTimeout(150);
  assert.match(await slowHistory.locator('#messages').innerText(), /sent while history loads/);
  assert.deepEqual(errors,[]); await slowHistory.close();

  const admission = await browser.newPage();
  admission.on('pageerror', error => errors.push(error.message));
  await admission.goto(`http://127.0.0.1:${server.address().port}/?cold=1`);
  await admission.evaluate(() => { window.readyStartup(); window.holdAdmission = true; });
  await admission.locator('textarea').fill('first waiting for admission'); await admission.locator('textarea').press('Enter');
  await admission.waitForFunction(() => window.held.length > 0);
  await admission.evaluate(() => window.dispatchEvent(new Event('online'))); await admission.waitForTimeout(150);
  assert.equal(await admission.locator('#preparing').innerText(),'true');
  assert.equal(await admission.locator('#state').innerText(),'A:running');
  await admission.locator('textarea').fill('later'); await admission.locator('textarea').press('Enter');
  assert.equal(await admission.locator('textarea').inputValue(),'later');
  assert.equal(await admission.evaluate(() => window.calls.filter(c => c.body?.type === 'queue_composer').length),0);
  await admission.evaluate(() => window.release());
  await admission.waitForFunction(() => document.querySelector('#preparing')?.textContent === 'false');
  await admission.locator('textarea').press('Enter');
  await admission.waitForFunction(() => window.calls.some(c => c.body?.message === 'later'));
  assert.deepEqual(errors,[]); await admission.close();
  for (const newSession of [false,true]) {
    const stopped = await browser.newPage(); stopped.on('pageerror',error => errors.push(error.message));
    await stopped.goto(`http://127.0.0.1:${server.address().port}/?cold=1`);
    if (newSession) {
      await stopped.locator('#new').click();
      await stopped.evaluate(() => { window.hold='/api/agent/new'; });
    }
    await stopped.locator('textarea').fill('cancel before dispatch'); await stopped.locator('textarea').press('Enter');
    await stopped.waitForFunction(() => document.querySelector('#preparing')?.textContent === 'true');
    if (newSession) await stopped.waitForFunction(() => window.held.length > 0);
    await stopped.locator('textarea').fill('keep this draft too');
    await stopped.locator('[data-action="stop"]').click();
    await stopped.waitForFunction(() => document.querySelector('#preparing')?.textContent === 'false');
    assert.equal(await stopped.locator('textarea').inputValue(),'cancel before dispatch\n\nkeep this draft too');
    await stopped.evaluate(() => { window.release(); window.readyStartup(); }); await stopped.waitForTimeout(100);
    assert.equal(await stopped.evaluate(() => window.calls.filter(c => ['prompt','abort'].includes(c.body?.type)).length),0);
    assert.equal(await stopped.locator('#messages').innerText(),'');
    assert.deepEqual(errors,[]); await stopped.close();
  }

  const background = await browser.newPage(); background.on('pageerror',error => errors.push(error.message));
  await background.goto(`http://127.0.0.1:${server.address().port}/?cold=1`);
  await background.waitForFunction(() => window.calls.some(c => c.url.endsWith('/state')));
  await background.evaluate(() => { window.readyStartup(); window.hold='/api/sessions/A?'; });
  await background.locator('#background-refresh').click(); await background.waitForFunction(() => window.held.length > 0);
  await background.locator('textarea').fill('sent during background refresh'); await background.locator('textarea').press('Enter');
  await background.waitForFunction(() => window.calls.some(c => c.body?.message === 'sent during background refresh'));
  await background.evaluate(() => window.release()); await background.waitForTimeout(100);
  assert.match(await background.locator('#messages').innerText(),/sent during background refresh/);
  // A new refresh after submission still applies the current server history.
  await background.evaluate(() => window.historyById.set('A',[{role:'user',content:'sent during background refresh'},{role:'assistant',content:'server result'}]));
  await background.locator('#background-refresh').click();
  await background.waitForFunction(() => document.querySelector('#messages')?.textContent.includes('server result'));
  assert.deepEqual(errors,[]); await background.close();

  const lostReply = await browser.newPage(); lostReply.on('pageerror',error => errors.push(error.message));
  await lostReply.addInitScript(() => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = ms => {
      if (ms !== 130000) return nativeTimeout(ms);
      const controller = new AbortController(); window.expireAdmission = () => controller.abort(new DOMException('controlled deadline','TimeoutError'));
      return controller.signal;
    };
  });
  await lostReply.goto(`http://127.0.0.1:${server.address().port}/?cold=1`);
  await lostReply.evaluate(() => { window.readyStartup(); window.holdReply=true; });
  await lostReply.locator('textarea').fill('server accepted, HTTP lost'); await lostReply.locator('textarea').press('Enter');
  await lostReply.waitForFunction(() => window.running.has('A') && typeof window.expireAdmission === 'function');
  await lostReply.locator('textarea').fill('untouched draft');
  await lostReply.evaluate(() => window.expireAdmission());
  await lostReply.waitForFunction(() => document.querySelector('#preparing')?.textContent === 'false');
  assert.match(await lostReply.locator('#notices').innerText(),/Timed out waiting for the server/);
  assert.equal(await lostReply.locator('textarea').inputValue(),'untouched draft');
  assert.equal(await lostReply.evaluate(() => window.calls.filter(c => c.body?.type === 'prompt').length),1);
  await lostReply.evaluate(() => window.dispatchEvent(new Event('online'))); await lostReply.waitForTimeout(100);
  assert.equal(await lostReply.locator('#state').innerText(),'A:running');
  assert.deepEqual(errors,[]); await lostReply.close();
  console.log('PASS: session isolation, cold startup, pre-dispatch Stop, bounded admission and stale background history (React StrictMode).');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
