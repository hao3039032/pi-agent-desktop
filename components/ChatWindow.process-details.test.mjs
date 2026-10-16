import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("groups the leading segment when the history page starts mid-turn", () => {
  // A turn longer than the initial page loses its anchor, and the old loop
  // flattened every message before the first anchor instead of grouping them.
  assert.match(source, /const hasAnchor = isMessageGroupAnchor\(msg\)/);
  assert.match(source, /if \(!hasAnchor && idx !== 0\)/);
  assert.match(source, /const userIdx = hasAnchor \? idx : -1/);
  assert.match(source, /const groupStartIdx = hasAnchor \? idx : 0/);
  assert.match(source, /if \(hasAnchor\) rendered\.push\(renderMessage\(userIdx\)\)/);
});

test("expands process details when a completed turn has no final answer", () => {
  assert.match(source, /const \[expanded, setExpanded\] = useState\(defaultExpanded\)/);
  assert.match(
    source,
    /<ProcessDetailsGroup[\s\S]*?defaultExpanded=\{!finalAnswerMessage\}/,
  );
});

test("resets process details when the turn gains or loses its final answer", () => {
  // useState only reads defaultExpanded on mount; keying on answer availability
  // makes an answered turn start collapsed even if it first rendered unanswered.
  assert.match(
    source,
    /<ProcessDetailsGroup key=\{finalAnswerMessage \? "answered" : "unanswered"\}[\s\S]*?defaultExpanded=\{!finalAnswerMessage\}/,
  );
});

test("hoists widget cards out of the group so collapsing never hides them", () => {
  // A rendered show_widget card is the reply's centerpiece: it leaves the
  // collapsible process group and stays above the final answer.
  assert.match(source, /function isHoistableWidgetBlock\(block: AssistantContentBlock\): boolean/);
  assert.match(source, /const hoistedWidgets: ReactNode\[\] = \[\]/);
  assert.match(source, /for \(const block of blocks\) \{\s*\n\s*if \(!isHoistableWidgetBlock\(block\)\) continue;/);
  assert.match(source, /<WidgetToolView\s*\n\s*key=\{`hoisted-widget-\$\{toolCall\.toolCallId\}`\}/);
  // The group itself only carries the non-widget remainder.
  assert.match(source, /processToolCount \+= countToolCallBlocks\(rest\)/);
  assert.match(source, /if \(rest\.length === 0\) continue/);
  // Rendered after the group, before the final answer push.
  const hoistIndex = source.indexOf("if (hoistedWidgets.length > 0)");
  const answerIndex = source.indexOf("if (finalAnswerMessage) {");
  assert.ok(hoistIndex > -1 && answerIndex > hoistIndex, "hoisted widgets render above the answer");
});
