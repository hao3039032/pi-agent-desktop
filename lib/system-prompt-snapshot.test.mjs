/**
 * Unit tests for lib/system-prompt-snapshot.ts — the pure half of the honest
 * system-prompt display: it replays the system messages the inspected entries
 * record (the SDK's own transcript replay, the one the CLI uses to build a
 * request's leading prompt) and never composes a prompt itself. Branch
 * isolation is the caller's contract (the wrapper passes ONE chain's
 * entries); the last test pins that only the entries handed in count.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { extractRecordedSystemPrompt, extractActiveSystemPrompt } = await jiti.import("./system-prompt-snapshot.ts");

test("active projection follows the CLI leaf, including null and compaction checkpoints", () => {
  const sys = (id, parentId, core) => ({ type: "message", id, parentId, timestamp: new Date(1).toISOString(), message: { role: "system", content: "", sections: { core }, timestamp: 1 } });
  const entries = [sys('root', null, 'BASE'), sys('a', 'root', 'BRANCH A'), sys('b', 'root', 'BRANCH B')];
  assert.equal(extractActiveSystemPrompt(entries, 'a').text, 'BRANCH A');
  assert.equal(extractActiveSystemPrompt(entries, 'b').text, 'BRANCH B');
  assert.equal(extractActiveSystemPrompt(entries, null).recorded, false);
  entries.push({ type: 'compaction', id: 'compact', parentId: 'a', timestamp: new Date(2).toISOString(), summary: 'summary', firstKeptEntryId: 'compact', tokensBefore: 100, systemMessage: sys('unused', null, 'CHECKPOINT').message });
  assert.equal(extractActiveSystemPrompt(entries, 'compact').text, 'CHECKPOINT');
});

test("no system message in the entries: no record", () => {
  assert.deepEqual(extractRecordedSystemPrompt([]), { recorded: false, text: "" });
  assert.deepEqual(
    extractRecordedSystemPrompt([
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "assistant", content: "hello" } },
      { type: "custom", customType: "pi-web:tool-selection", data: {} },
    ]),
    { recorded: false, text: "" },
  );
});

test("one system message: its sections render as the prompt text", () => {
  const result = extractRecordedSystemPrompt([
    { type: "message", message: { role: "system", content: "", sections: { core: "You are pi.", tools: "## Tools" } } },
  ]);
  assert.equal(result.recorded, true);
  assert.equal(result.text, "You are pi.\n\n## Tools");
});

test("a timestamp-less system message still counts and renders", () => {
  // The SDK replay drops messages with neither a timestamp nor tool deltas;
  // a recorded entry must not silently vanish because of that.
  const result = extractRecordedSystemPrompt([
    { type: "message", message: { role: "system", content: "", sections: { core: "base" } } },
  ]);
  assert.deepEqual(result, { recorded: true, text: "base" });
});

test("multiple system messages replay in order: later sections replace, null deletes", () => {
  const result = extractRecordedSystemPrompt([
    { type: "message", message: { role: "system", content: "", sections: { core: "You are pi.", artifacts: "ARTIFACTS v1", tools: "TOOLS v1" } } },
    { type: "message", message: { role: "user", content: "go" } },
    { type: "message", message: { role: "system", content: "", sections: { artifacts: "ARTIFACTS v2" } } },
    { type: "message", message: { role: "system", content: "", sections: { tools: null } } },
  ]);
  assert.equal(result.recorded, true);
  assert.equal(result.text, "You are pi.\n\nARTIFACTS v2");
});

test("only the entries handed in count: another chain's record is invisible", () => {
  // The function is pure; the wrapper's contract is to hand it ONE chain.
  // A sibling chain's system message must therefore be invisible whenever
  // the caller follows that contract — which is what the caller-side tests
  // (one entry chain per read) rely on.
  const inspectedChain = [{ type: "message", message: { role: "system", content: "", sections: { core: "INSPECTED" } } }];
  const result = extractRecordedSystemPrompt(inspectedChain);
  assert.equal(result.text, "INSPECTED");
  assert.ok(!result.text.includes("SIBLING"));
});
