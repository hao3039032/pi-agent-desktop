import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const display = await jiti.import("../lib/message-display.ts");
const { buildSessionContext } = await jiti.import("../lib/session-reader.ts");
const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
// Execute the component's ACTUAL rendering loop, not a copy of its ordering
// algorithm. Leaf components are inert descriptors so no browser, model or
// the application's installed SDK state is needed.
const helpers = source.slice(source.indexOf("function hasFinalAssistantAnswer("), source.indexOf("function getUserInputText("));
const loopStart = source.indexOf("const rendered: ReactNode[] = [];");
const loopEnd = source.indexOf("const { startIndex } = getVisibleRenderWindow(", loopStart);
assert.ok(loopStart >= 0 && loopEnd > loopStart, "render loop boundaries must exist");
const loop = source.slice(loopStart, loopEnd);
assert.ok(loop.includes("idx = endIdx"));
const compiled = ts.transpile(helpers + loop + "\nreturn rendered;", {
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
});
const text = (value) => ({ role: "assistant", content: [{ type: "text", text: value }] });
const tool = (name) => ({ role: "assistant", content: [{ type: "text", text: "working" }, { type: "toolCall", toolCallId: name, toolName: name, input: {} }] });
const result = (name) => ({ role: "toolResult", toolCallId: name, content: [] });
const user = { role: "user", content: "request" };
const notice = (customType = "subagent-notify") => ({ role: "custom", customType, display: false, content: "worker completed" });
const live = tool("NEW-live-tool");

function render(messages) {
  const keys = messages.map((_, i) => `entry-${i}`);
  const R = { createElement: (type, props, ...children) => type === "MessageView"
    ? { kind: "live", key: props.key, message: props.message }
    : { type, key: props?.key, children } };
  const env = {
    React: R, messages, messageKeys: keys, entryIds: keys,
    streamState: { isStreaming: true, streamingMessage: live }, agentRunning: true,
    lastAnchorIdx: messages.findLastIndex(display.isMessageGroupAnchor),
    ...display,
    getFinalSplit: (message) => {
      const split = display.splitFinalAssistantBlocks(message);
      return { ...split, answerMessage: split.answerBlocks.length ? { ...message, content: split.answerBlocks } : null,
        processMessage: { ...message, content: split.processBlocks } };
    },
    renderMessage: (idx, options = {}) => ({ kind: "history", idx, key: keys[idx], message: options.messageOverride ?? messages[idx] }),
    messageKeySessionId: "test-session", collectTurnResultImages: () => [], toolResultsMap: new Map(),
    customGeneratedImage: () => false, pendingSearchScroll: null, searchBlock: null,
    visibleRefIndexByMessage: new Map(), messageRefs: { current: [] },
    TurnImageOwner: "TurnImageOwner", ProcessDetailsGroup: "ProcessDetailsGroup",
    TurnImageTargetContext: { Provider: "ImageContext" }, MessageView: "MessageView",
    getTurnWrittenFiles: () => [], messageCwd: "/sandbox", t: (s) => s,
    hasStreamingContent: true, modelNames: {}, openFile: () => {}, onOpenSession: () => {},
  };
  return new Function(...Object.keys(env), compiled)(...Object.values(env));
}
function flatten(nodes) {
  return nodes.flatMap((node) => node?.kind ? [node] : flatten(node?.children?.flat(Infinity).filter(Boolean) ?? []));
}

for (const customType of ["subagent-notify", "pi-web:subagent-notification", "extension_debug"]) {
  test(`stream stays after completed history (${customType})`, () => {
    const messages = [user, text("OLD-final"), notice(customType), tool("read"), result("read"), tool("codemode"), result("codemode")];
    const nodes = flatten(render(messages));
    assert.equal(nodes.at(-1).kind, "live", "a live tool cannot appear above earlier notifications or tools");
    assert.equal(nodes.filter((n) => n.kind === "live").length, 1);
    assert.ok(nodes.find((n) => n.idx === 2), "hidden custom notice is not dropped from history");
    assert.ok(nodes.find((n) => n.idx === 5), "completed codemode message remains before the live tool");
    const indices = nodes.filter((n) => n.kind === "history").map((n) => n.idx);
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  });
}
test("multiple package wakes form separate turns; stable history keys survive deltas", () => {
  const messages = [user, text("first"), notice(), tool("read"), result("read"), notice(), tool("codemode"), result("codemode")];
  assert.equal(display.isMessageGroupAnchor(notice()), true);
  assert.equal(display.isMessageGroupAnchor(notice("extension_debug")), false);
  const first = flatten(render(messages));
  const second = flatten(render(messages));
  assert.deepEqual(first.filter((n) => n.kind === "history").map((n) => n.key), second.filter((n) => n.kind === "history").map((n) => n.key));
  assert.equal(second.at(-1).kind, "live");
});
for (const customType of ["subagent-notify", "pi-web:subagent-notification"]) {
  test(`whole-turn pagination stops at ${customType}, including display:false`, () => {
    const entries = [
      { type: "message", message: user },
      { type: "message", message: text("earlier answer") },
      { type: "custom_message", customType, display: false, content: "completed" },
      { type: "message", message: tool("read") },
      { type: "message", message: result("read") },
      { type: "message", message: tool("codemode") },
    ].map((e, i) => ({ ...e, id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: "2026-01-01T00:00:00Z" }));
    const page = buildSessionContext(entries, "e5", { tail: 2, wholeTurns: true });
    assert.deepEqual(page.entryIds, ["e2", "e3", "e4", "e5"]);
    const previous = buildSessionContext(entries, "e2", { tail: 2, wholeTurns: true, excludeLeaf: true });
    assert.deepEqual(previous.entryIds, ["e0", "e1"]);
  });
}
