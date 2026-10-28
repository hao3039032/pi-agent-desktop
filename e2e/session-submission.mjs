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
window.running = new Set(['A']);
window.held = [];
window.historyById = new Map();
window.release = () => { window.hold = null; window.held.splice(0).forEach(fn => fn()); };
const sources = [];
window.EventSource = class {
  readyState = 1;
  constructor(url) {
    this.sid = url.split('/')[3]; sources.push(this);
    setTimeout(() => this.onmessage?.({data:JSON.stringify({type:'connected', isStreaming:window.running.has(this.sid)})}), 0);
  }
  close() { this.readyState = 2; }
};
window.fetch = async (url, options = {}) => {
  url = String(url); const body = options.body ? JSON.parse(options.body) : null;
  window.calls.push({url, body});
  if (window.hold && url.includes(window.hold)) await new Promise(resolve => window.held.push(resolve));
  const sid = url.split('/')[3]?.split('?')[0];
  let data = {};
  if (url === '/api/agent/new') data = {sessionId:'new-' + (++window.sequence), model:null};
  else if (url.startsWith('/api/models')) data = { models:{}, modelList:[] };
  else if (url.endsWith('/reference')) data = { sessionId:'ref', messages:[], name:'reference' };
  else if (url === '/api/sessions') data = { sessions:[{id:'ref', name:'reference'}] };
  else if (url.startsWith('/api/sessions/')) {
    data = url.endsWith('/state') ? { running:true, state:{isStreaming:window.running.has(sid)} } : {
      sessionId:sid, tree:[], leafId:null, filePath:'', totalActiveMs:0,
      context:{ messages:window.historyById.get(sid) ?? [], entryIds:[], oldestEntryId:null, hasMore:false, thinkingLevel:'off', model:null },
    };
  } else if (body) {
    if (body.type === 'prompt') {
      window.running.add(sid);
      window.historyById.set(sid,[{role:'user',content:body.message}]);
      for (const source of sources) if (source.sid === sid && source.readyState === 1) source.onmessage?.({data:JSON.stringify({type:'agent_start'})});
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
    <ChatInput ref={inputRef} draftKey={session?.id ?? draft} onSend={h.handleSend} onAbort={h.handleAbort}
      isStreaming={h.agentRunning || h.bashRunning} onSteer={h.agentRunning ? h.handleSteer : undefined}
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
  console.log('PASS: running A -> new -> send targets new runtime once; delayed reference never sends or clears another draft (React StrictMode).');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
