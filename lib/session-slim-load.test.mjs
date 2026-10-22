import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { loadSlimSessionEntries, openSlimSessionManager } = await jiti.import("./session-slim-load.ts");
const { projectToolResultDetails, slimToolResultMessage } = await jiti.import("./tool-result-details.ts");
const { generatedImageIndices } = await jiti.import("./turn-result-images.ts");
const { computeSessionStats } = await jiti.import("./session-stats.ts");

const BIG = "x".repeat(400 * 1024);

function header(cwd = "/tmp/proj") {
  return { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd };
}
function user(id, parentId, text) {
  return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: text, timestamp: 1 } };
}
function toolResult(id, parentId, details, extra = {}) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:02.000Z",
    message: {
      role: "toolResult",
      toolCallId: "t-" + id,
      toolName: "evaluate_browser",
      content: [{ type: "text", text: "ok — 页面 ✓" }],
      details,
      isError: false,
      timestamp: 2,
      ...extra,
    },
  };
}
function generatedImageResult(id, parentId) {
  return toolResult(id, parentId, {
    modelImages: { version: 1, outputs: [{ blockIndex: 0, kind: "generated-image", filePath: "/private/image.png" }] },
  }, { content: [{ type: "image", data: BIG, mimeType: "image/png" }] });
}
function meteredResult(id, parentId) {
  const entry = toolResult(id, parentId, { outline: BIG });
  const { isError, timestamp, ...prefix } = entry.message;
  // The SDK writes these siblings after details and before isError/timestamp.
  entry.message = {
    ...prefix,
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
    nestedCalls: [{ toolName: "nested", arguments: {} }],
    isError,
    timestamp,
  };
  return entry;
}
const toBuffer = (entries) => Buffer.from(entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

test("oversized dead details are never parsed; everything else is unchanged", () => {
  const entries = [
    header(),
    user("a", null, "hi"),
    toolResult("b", "a", { outline: BIG, url: "https://x" }),
    toolResult("c", "b", { outline: BIG }, { isError: true }),
  ];
  const slim = loadSlimSessionEntries(toBuffer(entries));
  assert.equal(slim.length, 4);
  for (const index of [2, 3]) {
    const message = slim[index].message;
    assert.equal("details" in message, false);
    assert.deepEqual(message.content, entries[index].message.content);
    assert.equal(message.isError, entries[index].message.isError);
    assert.equal(message.timestamp, 2);
    assert.equal(message.toolCallId, entries[index].message.toolCallId);
  }
  assert.deepEqual(slim[1], entries[1]);
});

test("details the UI renders are kept, via the normal path", () => {
  const withDiff = toolResult("b", "a", { diff: BIG, extra: 1 });
  const withSubagent = toolResult("c", "b", { kind: "pi-web-subagent", transcript: BIG });
  const withImage = generatedImageResult("d", "c");
  const slim = loadSlimSessionEntries(toBuffer([header(), user("a", null, "hi"), withDiff, withSubagent, withImage]));
  assert.deepEqual(slim[2], withDiff);
  assert.deepEqual(slim[3], withSubagent);
  assert.deepEqual(slim[4], withImage);
  const projected = slimToolResultMessage(slim[4].message);
  assert.deepEqual([...generatedImageIndices(projected)], [0]);
  assert.deepEqual(projected.details, { modelImages: {
    version: 1, outputs: [{ blockIndex: 0, kind: "generated-image" }],
  } });
});

test("the shortcut agrees with projectToolResultDetails on every line", () => {
  const entries = [
    header(),
    user("a", null, "hi"),
    toolResult("b", "a", { outline: BIG, "nested": { isError: 1, timestamp: 2 } }),
    toolResult("c", "b", { outline: BIG, result: { appliedFiles: ["a"] } }),
    generatedImageResult("d", "c"),
    toolResult("e", "d", { outline: BIG, modelImages: {
      version: 1, outputs: [{ blockIndex: 0, kind: "generated-image" }],
    } }),
  ];
  const slim = loadSlimSessionEntries(toBuffer(entries));
  entries.forEach((entry, index) => {
    if (entry.message?.role !== "toolResult") return;
    // Lines kept whole still get projected later, by the cache's slimCachedEntries.
    const expected = projectToolResultDetails(entry.message.details);
    assert.deepEqual(projectToolResultDetails(slim[index].message.details), expected);
  });
});

test("usage and nested calls between details and the tail survive unchanged", () => {
  const entries = [header(), meteredResult("a", null)];
  const slim = loadSlimSessionEntries(toBuffer(entries));
  assert.deepEqual(slim, entries);
  assert.deepEqual(computeSessionStats(slim), computeSessionStats(entries));
  assert.equal(computeSessionStats(slim).tokens.total, 110);
  assert.equal(computeSessionStats(slim).cost, 2);
});

test("unknown siblings between details and either tail anchor force a full parse", () => {
  for (const withIsError of [true, false]) {
    const entry = toolResult("a", null, { outline: BIG });
    const { isError, timestamp, ...prefix } = entry.message;
    entry.message = { ...prefix, futureField: { keep: true }, ...(withIsError ? { isError } : {}), timestamp };
    assert.deepEqual(loadSlimSessionEntries(toBuffer([entry])), [entry]);
  }
});

test("nested containers and escaped quotes in dead details still take the shortcut", () => {
  const entry = toolResult("a", null, { outline: BIG, nested: [{
    text: 'quote \\" and braces } ] {',
    trailingBackslash: "ends with \\",
  }] });
  const [slim] = loadSlimSessionEntries(toBuffer([entry]));
  assert.equal("details" in slim.message, false);
  assert.deepEqual(slim.message.content, entry.message.content);
});

test("unrecognised shapes fall back to a full parse", () => {
  // No isError/timestamp after details, an unknown message key, and a nested
  // details object inside content: none may lose data.
  const noTail = { type: "message", id: "b", parentId: "a", message: { role: "toolResult", toolCallId: "t", content: [], details: { outline: BIG } } };
  const extraKey = toolResult("c", "b", { outline: BIG }, { custom: BIG.slice(0, 10) });
  const nested = toolResult("d", "c", { outline: BIG });
  nested.message.content = [{ type: "text", text: "t", details: { keep: "me" } }];
  const slim = loadSlimSessionEntries(toBuffer([header(), user("a", null, "hi"), noTail, extraKey, nested]));
  assert.equal(slim.length, 5);
  assert.equal(slim[3].message.custom, "xxxxxxxxxx");
  assert.deepEqual(slim[4].message.content, nested.message.content);
});

test("malformed and blank lines are skipped like the SDK loader", () => {
  const text = [JSON.stringify(header()), "", "{not json", JSON.stringify(user("a", null, "hi"))].join("\n");
  assert.equal(loadSlimSessionEntries(Buffer.from(text)).length, 2);
});

test("openSlimSessionManager matches SessionManager.open and never persists", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-load-"));
  try {
    const entries = [header(dir), user("a", null, "hi")];
    let parent = "a";
    for (let i = 0; i < 45; i++) {
      const id = `r${i}`;
      entries.push(toolResult(id, parent, { outline: BIG, n: i }));
      parent = id;
    }
    entries.push(generatedImageResult("image", parent), meteredResult("metered", "image"));
    entries.push({ type: "session_info", id: "n1", parentId: "metered", timestamp: "2026-01-01T00:00:03.000Z", name: "named" });
    const file = join(dir, "2026-01-01T00-00-00-000Z_s1.jsonl");
    writeFileSync(file, toBuffer(entries));
    const before = Buffer.from(toBuffer(entries));

    const slim = openSlimSessionManager(file);
    assert.ok(slim, "files over the threshold take the slim path");
    const reference = SessionManager.open(file, undefined);

    assert.equal(slim.getSessionFile(), reference.getSessionFile());
    assert.equal(slim.getSessionId(), reference.getSessionId());
    assert.equal(slim.getCwd(), reference.getCwd());
    assert.equal(slim.getLeafId(), reference.getLeafId());
    assert.equal(slim.getSessionName(), reference.getSessionName());
    assert.deepEqual(
      slim.getEntries().map((e) => e.id),
      reference.getEntries().map((e) => e.id),
    );
    assert.equal(slim.getBranch().length, reference.getBranch().length);
    assert.equal("details" in slim.getEntries()[5].message, false);
    const image = slim.getEntries().find((entry) => entry.id === "image").message;
    assert.deepEqual([...generatedImageIndices(slimToolResultMessage(image))], [0]);
    assert.deepEqual(
      slim.getEntries().find((entry) => entry.id === "metered"),
      reference.getEntries().find((entry) => entry.id === "metered"),
    );
    assert.deepEqual(computeSessionStats(slim.getEntries()), computeSessionStats(reference.getEntries()));
    assert.equal(computeSessionStats(slim.getEntries()).cost, 2);

    // A mutation on the slim view must not touch the file on disk.
    slim.appendMessage({ role: "user", content: "later", timestamp: 3 });
    const after = SessionManager.open(file, undefined);
    assert.equal(after.getEntries().length, reference.getEntries().length);
    assert.ok(before.length > 16 * 1024 * 1024);
    assert.deepEqual(readFileSync(file), before, "the slim view must never change persisted bytes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("small files are left to the SDK", () => {
  const dir = mkdtempSync(join(tmpdir(), "slim-load-small-"));
  try {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, toBuffer([header(dir), user("a", null, "hi")]));
    assert.equal(openSlimSessionManager(file), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
