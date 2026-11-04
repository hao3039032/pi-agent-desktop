import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { titleMessagesFromEntries } = await jiti.import("./rpc-manager.ts");

/**
 * The CLI engine keeps every model call in the child, so the title request
 * reads the session file instead of the live Agent. These entries are the
 * shapes a title has to understand: messages pass through untouched, the two
 * summary entry types become the summary messages the title prompt expects,
 * and anything else (labels, model changes) is not part of the transcript.
 */
test("title entries map compaction and branch summaries and drop labels", () => {
  const userMessage = { role: "user", content: "first turn" };
  const assistantMessage = { role: "assistant", content: [{ type: "text", text: "done" }] };
  const entries = [
    { type: "message", message: userMessage },
    { type: "compaction", summary: "earlier summary text" },
    { type: "branch_summary", summary: "branch summary text" },
    { type: "message", message: assistantMessage },
    { type: "label", id: "x", parentId: null, timestamp: "t", label: "ignored" },
  ];

  const messages = titleMessagesFromEntries(entries);

  assert.deepEqual(
    messages.map((message) => ({ role: message.role, summary: message.summary })),
    [
      { role: "user", summary: undefined },
      { role: "compactionSummary", summary: "earlier summary text" },
      { role: "branchSummary", summary: "branch summary text" },
      { role: "assistant", summary: undefined },
    ],
  );
  // The messages themselves are the recorded ones, not copies of them.
  assert.equal(messages[0], userMessage);
  assert.equal(messages[3], assistantMessage);
  // Summary messages carry no content of their own.
  assert.deepEqual(messages[1].content, []);
  assert.deepEqual(messages[2].content, []);
});

test("entries without a summary are not turned into empty summary messages", () => {
  const messages = titleMessagesFromEntries([
    { type: "compaction" },
    { type: "branch_summary", summary: 42 },
    { type: "message" },
  ]);

  assert.deepEqual(messages, []);
});
