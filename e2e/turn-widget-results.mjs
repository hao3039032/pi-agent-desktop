import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

// Run: node --test e2e/turn-widget-results.mjs (Playwright Chromium required).
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH optionally selects an already-installed browser.
// No Next server or build is started.
// Exercise the actual ChatWindow render block, not a hand-written approximation of
// its React parent/key structure. Unrelated session transport/composer hooks are omitted.
const chat = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const grouping = chat.slice(chat.indexOf("let lastUserIdx = -1;"), chat.indexOf("            })()}"));
const helpers = chat.slice(chat.indexOf("function hasFinalAssistantAnswer"), chat.indexOf("export function ChatWindow"));
const searchSelection = chat.slice(chat.indexOf("  const searchMessage = messages["), chat.indexOf("  const searchHistoryRef ="));
const bundle = await build({
  stdin: {
    contents: `import React, {useState,useRef,useLayoutEffect} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {TurnWidgetResults} from './components/TurnWidgetResults';
      import {MessageView as RealMessageView} from './components/MessageView';
      import {I18nProvider} from './hooks/useI18n';
      import {collectTurnWidgets,isTurnWidgetBlock} from './lib/widget-tool';
      import {countToolCallBlocks,getAssistantErrorMessage,getDisplayableAssistantBlocks,hasAssistantAnswer,isAssistantTruncated,isMessageGroupAnchor,splitFinalAssistantBlocks} from './lib/message-display';
      import {extractTurnWrittenFiles} from './lib/turn-written-files';
      ${helpers}
      function MessageView({message,suppressWidgets}) {
        return <div>{message.role==='user'?'user':null}{(Array.isArray(message.content)?message.content:[]).map((b,i)=>b.type==='text'?<span key={i}>{b.text}</span>:b.type==='toolCall'&&!suppressWidgets?<b key={i}>DUPLICATE WIDGET</b>:null)}</div>;
      }
      const t=(s)=>s;
      function TurnHarness({messages,streamingMessage=null,running=false,results=[],reveal,revealBlockIndex}) {
        const streamState={isStreaming:!!streamingMessage,streamingMessage};
        const hasStreamingContent=!!streamingMessage,agentRunning=running,sessionBusy=running,bashRunning=false,isNew=false;
        const toolResultsMap=new Map(results),entryIds=messages.map((m)=>m.id),messageKeys=entryIds;
        const modelNames={},messageCwd='/tmp',onOpenFile=undefined,onOpenSession=undefined,session={id:'s'};
        const sessionIdRef=useRef('s'),messageRefs=useRef({}),lastUserMsgRef=useRef(null),sentinelRef=useRef(null);
        const pendingSearchScroll=reveal?{entryId:reveal,blockIndex:revealBlockIndex}:null;
        ${searchSelection}
        const forkingEntryId=null,editEntryId=null,isCompacting=false,compactError=null,visibleCount=999,hasEarlierMessages=false;
        const handleFork=undefined,handleEditContent=undefined,cancelEdit=undefined,handleCompact=undefined;
        const getVisibleRenderWindow=()=>({startIndex:0});
        return (()=>{${grouping}})();
      }
      const root=createRoot(document.getElementById('root'));
      window.update=(props,mode='turn')=>flushSync(()=>root.render(<I18nProvider>{mode==='turn'?<TurnHarness {...props}/>:mode==='memo'?<RealMessageView {...props}/>:<TurnWidgetResults {...props}/>}</I18nProvider>));
      window.entries=(blocks,results=[],options={})=>collectTurnWidgets(blocks,new Map(results),options);
      window.memoMessage={role:'assistant',content:[{type:'toolCall',toolCallId:'memo',toolName:'show_widget',input:{title:'memo',widget_code:'<div>memo</div>'}}]};
      window.updateMemo=(suppressWidgets)=>window.update({message:window.memoMessage,suppressWidgets},'memo');`,
    resolveDir: process.cwd(), sourcefile: "widget-browser-harness.tsx", loader: "tsx",
  },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"test"', "process.env.NODE_TEST_CONTEXT": '"test"', "process.env": '{}' },
});
const call = (id, code = `<div>${id}</div>`) => ({ type: "toolCall", toolCallId: id, toolName: "show_widget", input: { title: id, widget_code: code } });
const result = (id, extra = {}) => [id, { role: "toolResult", toolCallId: id, content: [], ...extra }];
const user = { id: "u", role: "user", content: "make widgets" };
const assistant = (id, content) => ({ id, role: "assistant", content });

test("TurnWidgetResults mounted interactions and ChatWindow settlement retain the selected iframe", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const update = (props, mode = "turn") => page.evaluate(({ props, mode }) => window.update(props, mode), { props, mode });
    const selected = () => page.locator('[role="tab"][aria-selected="true"]').getAttribute("id");
    const a = call("a"), b = call("b"), c = call("c");
    const messages = [user, assistant("a-msg", [a]), assistant("answer", [{ type: "text", text: "Final answer" }]), assistant("b-msg", [b])];
    await update({ messages, running: true, results: [result("a"), result("b")] });
    assert.equal(await selected(), "turn-widget-tab-b");
    assert.equal(await page.locator("iframe").count(), 1);
    assert.equal(await page.getByText("DUPLICATE WIDGET").count(), 0);
    assert.equal(await page.evaluate(() => {
      const text = [...document.querySelectorAll('span')].find(el => el.textContent === 'Final answer');
      return !!(text.compareDocumentPosition(document.querySelector('.turn-widget-results')) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), true, "answer precedes results");
    await page.getByRole("tab").first().click();
    await page.evaluate(() => { window.savedFrame = document.querySelector('iframe'); window.savedResults = document.querySelector('.turn-widget-results'); });
    await update({ messages, running: true, streamingMessage: assistant("stream", [{ type: "text", text: "finishing" }]), results: [result("a"), result("b")] });
    await update({ messages: [...messages, assistant("finished", [{ type: "text", text: "Final final answer" }])], results: [result("a"), result("b")] });
    assert.equal(await selected(), "turn-widget-tab-a");
    assert.equal(await page.evaluate(() => window.savedFrame === document.querySelector('iframe') && window.savedResults === document.querySelector('.turn-widget-results')), true);
    const withC = [...messages, assistant("c-msg", [c])];
    await update({ messages: withC, results: [result("a"), result("b"), result("c")] });
    assert.equal(await selected(), "turn-widget-tab-a", "manual selection survives arrivals");
    await update({ messages: [user, assistant("bc", [b, c])], results: [result("b"), result("c")] });
    assert.equal(await selected(), "turn-widget-tab-c", "removed selection falls back");
    await page.getByRole("tab").last().focus();
    await page.keyboard.press("Home");
    assert.equal(await selected(), "turn-widget-tab-b");
    await page.keyboard.press("ArrowRight");
    assert.equal(await selected(), "turn-widget-tab-c");
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('[role=tab]')].every(tab => !!document.getElementById(tab.getAttribute('aria-controls')))), true);
    await update({ messages: withC, results: [result("a"), result("b"), result("c")], reveal: "a-msg" });
    assert.equal(await selected(), "turn-widget-tab-a", "source location selects non-default result");
    assert.equal(await page.locator('[data-entry-id="a-msg"] [data-search-target]').count(), 1);

    // Fresh mount follows arrivals without waiting for an effect or briefly running the old frame.
    await update({ entries: [] }, "results");
    const entries = await page.evaluate(({ a, b, c }) => window.entries([a, b, c], [a,b,c].map(x=>[x.toolCallId,{role:'toolResult',content:[]}])) , { a,b,c });
    await update({ entries: entries.slice(0, 1) }, "results");
    await update({ entries: entries.slice(0, 2) }, "results");
    assert.equal(await selected(), "turn-widget-tab-b");
    for (const status of ["streaming", "running", "error", "cancelled"]) {
      await update({ entries: [entries[0], { ...entries[1], status }] }, "results");
      assert.equal(await page.locator("iframe").count(), 0, `${status} cannot mount iframe`);
    }
    await page.evaluate(() => window.updateMemo(false));
    assert.equal(await page.locator("iframe").count(), 1);
    await page.evaluate(() => window.updateMemo(true));
    assert.equal(await page.locator("iframe").count(), 0, "memo observes suppressWidgets with same message object");
  } finally { await browser.close(); }
});

test("source navigation matches a history widget with a distinct streaming copy without selecting text hits", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const messages = [user, assistant("a-msg", [{ type: "text", text: "Searchable answer" }, call("a")]), assistant("b-msg", [call("b")])];
    const props = { messages, running: true, streamingMessage: assistant("stream", [call("a")]), results: [result("a"), result("b")] };
    const update = (extra = {}) => page.evaluate(value => window.update(value), { ...props, ...extra });
    const selected = () => page.locator('[role="tab"][aria-selected="true"]').getAttribute("id");
    await update();
    assert.equal(await selected(), "turn-widget-tab-b");
    await update({ reveal: "a-msg", revealBlockIndex: 1 });
    assert.equal(await selected(), "turn-widget-tab-a", "toolCallId matches even when the collector replaces the history block object");
    assert.equal(await page.locator('[data-entry-id="a-msg"] [data-search-target]').count(), 1);
    await update();
    await page.getByRole("tab").last().click();
    for (const revealBlockIndex of [0, undefined]) {
      await update({ reveal: "a-msg", revealBlockIndex });
      assert.equal(await selected(), "turn-widget-tab-b", "explicit or default text search does not select a widget from the same entry");
      assert.equal(await page.locator('.turn-widget-results [data-search-target]').count(), 0);
    }
  } finally { await browser.close(); }
});

test("historical scripts stay source-first across busy/settled updates; only witnessed calls auto-run", async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const scripted = call("history", '<div>historical script widget</div><script>window.x=1</script>');
    const messages = [user, assistant("old", [scripted])];
    for (const running of [false, true, false]) {
      await page.evaluate(props => window.update(props), { messages, running, results: [result("history")] });
      assert.equal(await page.locator("iframe").count(), 0);
    }
    const live = call("live", '<div>newly generated script widget</div><script>window.x=2</script>');
    await page.evaluate(props => window.update(props), { messages, running: true, streamingMessage: assistant("stream", [live]), results: [result("history")] });
    assert.equal(await page.locator("iframe").count(), 0, "complete arguments still await result");
    await page.evaluate(props => window.update(props), { messages: [...messages, assistant("live-msg", [live])], results: [result("history"), result("live")] });
    assert.equal(await page.locator("iframe").count(), 1, "witnessed call can run once completed");
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await page.evaluate(props => window.update(props), { messages: [...messages, assistant("live-msg", [live])], running: true, results: [result("history"), result("live")] });
    assert.equal(await page.locator("iframe").count(), 0, "source choice survives busy changes");

    // Leading streaming turns have no persisted anchor yet and share the same key on settlement.
    await page.evaluate(() => window.update({entries:[]}, 'results'));
    const leading = call('leading');
    await page.evaluate(props => window.update(props), { messages: [], streamingMessage: assistant('stream', [leading]), running: true });
    await page.evaluate(() => { window.leadingResults = document.querySelector('.turn-widget-results'); });
    await page.evaluate(props => window.update(props), { messages: [assistant('persisted', [leading])], results: [result('leading')] });
    assert.equal(await page.evaluate(() => window.leadingResults === document.querySelector('.turn-widget-results')), true);
    assert.equal(await page.locator('iframe').count(), 1);

  } finally { await browser.close(); }
});
