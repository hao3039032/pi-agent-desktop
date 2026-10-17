import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { collectTurnResultImages, generatedImageIndices, customGeneratedImage, projectModelImages } = await jiti.import("./turn-result-images.ts");
const { toClientAgentEvent } = await jiti.import("./agent-event-wire.ts");
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const image = { type: "image", data: "QUJD", mimeType: "image/png" };
const call = (id, name = "bash") => ({ role: "assistant", content: [{ type: "toolCall", toolCallId: id, toolName: name, input: {} }] });
const metadata = (...indices) => ({ modelImages: { version: 1, outputs: indices.map((blockIndex) => ({ blockIndex, kind: "generated-image", filePath: "not-a-file-to-read" })) } });
const result = (id, details) => ({ role: "toolResult", toolName: "bash", toolCallId: id, content: [{ type: "text", text: "PI_IMAGEGEN_FILE /fake.png" }, image], details });

test("read, screenshots and legacy marker text never promote untagged images", () => {
  for (const name of ["read", "bash", "codemode", "screenshot"]) {
    const output = { ...result("a"), toolName: name };
    assert.deepEqual(collectTurnResultImages([call("a", name), output], new Map([["a", output]])), []);
  }
});

test("collects tagged blocks in call order once, scoped to the supplied turn", () => {
  const a = result("a", metadata(1));
  const b = { ...result("b", metadata(1)), isError: true };
  const unrelated = result("other", metadata(1));
  const map = new Map([["a", a], ["b", b], ["other", unrelated]]);
  const collected = collectTurnResultImages([call("a"), call("b"), b, a], map);
  assert.deepEqual(collected.map((item) => item.key), ["tool:a:1", "tool:b:1"]);
  assert.equal(collected[0].image, image);
  assert.equal(collected[1].isError, true);
  assert.deepEqual(collectTurnResultImages([a], map).map((item) => item.key), ["tool:a:1"], "mid-turn page without call");
  assert.deepEqual(collectTurnResultImages([call("a")], map).map((item) => item.key), ["tool:a:1"], "live result without final prose");
});

test("validates version, kind, bounds, actual block type and duplicate indices", () => {
  const details = metadata(1, 1, -1, 0.5, 999, 0);
  details.modelImages.outputs.push({ blockIndex: 1, kind: "reference-image" });
  assert.deepEqual([...generatedImageIndices(result("a", details))], [1]);
  assert.equal(projectModelImages({ version: 2, outputs: [] }), undefined);
  assert.equal(projectModelImages({ version: 1, outputs: "bad" }), undefined);
  assert.equal(projectModelImages({ version: 1, outputs: [{ kind: "generated-image", blockIndex: "1" }] }), undefined);
  assert.deepEqual(projectModelImages(metadata(1).modelImages), { version: 1, outputs: [{ kind: "generated-image", blockIndex: 1 }] });
});

test("tail-aligned promotion survives SDK text-hint insertion after resized images", () => {
  // The producer tagged indices 1 and 2; the SDK then inserted a resize hint after img1,
  // so img2 drifted to index 3 and strict index checking dropped it.
  const drifted = { ...result("a", metadata(1, 2)), content: [
    { type: "text", text: "PI_IMAGEGEN_FILE /fake.png" },
    { ...image, data: "aW1nMQ==" },
    { type: "text", text: "[image auto-resized from 3000x2000 to 2000x1333]" },
    { ...image, data: "aW1nMg==" },
  ] };
  assert.deepEqual([...generatedImageIndices(drifted)].sort(), [1, 3]);
  const collected = collectTurnResultImages([call("a"), drifted], new Map([["a", drifted]]));
  assert.deepEqual(collected.map((item) => item.key), ["tool:a:1", "tool:a:3"]);
  assert.deepEqual(collected.map((item) => item.image.data), ["aW1nMQ==", "aW1nMg=="], "both deliverables promoted");
});

test("only the appended deliverable is promoted when the result also carries an earlier image", () => {
  const screenshot = { ...image, data: "c2NyZWVuc2hvdA==" };
  const mixed = { ...result("a", metadata(2)), content: [screenshot, { type: "text", text: "ok" }, { ...image, data: "aW1nMQ==" }] };
  assert.deepEqual([...generatedImageIndices(mixed)], [2]);
  const collected = collectTurnResultImages([call("a"), mixed], new Map([["a", mixed]]));
  assert.deepEqual(collected.map((item) => item.key), ["tool:a:2"]);
  assert.equal(collected[0].image.data, "aW1nMQ==", "the pre-existing screenshot is not promoted");
});

test("falls back to strict matching when outputs outnumber the remaining image blocks", () => {
  const fewer = { ...result("a", metadata(1, 2)), content: [{ type: "text", text: "PI_IMAGEGEN_FILE /fake.png" }, image] };
  assert.deepEqual([...generatedImageIndices(fewer)].sort(), [1], "no crash, no false positive");
  const collected = collectTurnResultImages([call("a"), fewer], new Map([["a", fewer]]));
  assert.deepEqual(collected.map((item) => item.key), ["tool:a:1"]);
  const empty = { ...result("b", metadata(1)), content: [{ type: "text", text: "PI_IMAGEGEN_FILE /fake.png" }] };
  assert.deepEqual(collectTurnResultImages([call("b"), empty], new Map([["b", empty]])), []);
});

test("nested model-image messages are explicit deliverables with stable image identity", () => {
  const message = { role: "custom", customType: "model-image", display: true, content: "generated", details: { data: "QUJD", mimeType: "image/png", filePath: "never-read" } };
  assert.equal(customGeneratedImage(message), customGeneratedImage(message));
  assert.equal(customGeneratedImage({ ...message, customType: "other" }), null);
  assert.equal(customGeneratedImage({ ...message, display: false }), null);
  assert.equal(customGeneratedImage({ ...message, details: {} }), null);
  const rows = collectTurnResultImages([message], new Map(), ["stable-message"]);
  assert.equal(rows[0].key, "custom:stable-message");
  assert.equal(rows[0].image.source.data, "QUJD");
});

test("stream-captured custom images are skipped when the answer already inlines the same file", () => {
  const custom = (key, filePath) => ({ role: "custom", customType: "model-image", display: true, content: "generated", details: { data: "QUJD", mimeType: "image/png", filePath } });
  const assistant = { role: "assistant", model: "m", provider: "p", content: [{ type: "text", text: "Here you go:\n\n![image](file:///home/u/.pi/images/a.png)\n" }] };
  assert.deepEqual(collectTurnResultImages([assistant, custom("c1", "/home/u/.pi/images/a.png")], new Map(), ["m", "c1"]), [],
    "the markdown already renders the pixels inline");
  // No matching markdown (nested codemode deliverable): the custom image stays in the gallery.
  const kept = collectTurnResultImages([assistant, custom("c2", "/home/u/.pi/images/b.png")], new Map(), ["m", "c2"]);
  assert.deepEqual(kept.map((item) => item.key), ["custom:c2"]);
  // Assistant text without the file:// form does not suppress the deliverable.
  const plain = { role: "assistant", model: "m", provider: "p", content: [{ type: "text", text: "generated /home/u/.pi/images/a.png just now" }] };
  assert.equal(collectTurnResultImages([plain, custom("c3", "/home/u/.pi/images/a.png")], new Map(), ["m", "c3"]).length, 1);
  // A custom message without filePath cannot be matched and is kept.
  const noPath = { role: "custom", customType: "model-image", display: true, content: "generated", details: { data: "QUJD", mimeType: "image/png" } };
  assert.equal(collectTurnResultImages([assistant, noPath], new Map(), ["m", "c4"]).length, 1);
  // Bare Windows drive path in the markdown (data-URI catcher form) is also matched: the web
  // UI resolves drive-letter hrefs to /api/files, so the pixels are already inline there too.
  const windows = { role: "assistant", model: "m", provider: "p", content: [{ type: "text", text: `saved\n\n![image](C:\\u\\.pi\\images\\w.png)\n` }] };
  assert.deepEqual(collectTurnResultImages([windows, custom("c5", "C:\\u\\.pi\\images\\w.png")], new Map(), ["m", "c5"]), [],
    "bare drive-letter markdown target is treated as inline");
  // A bare file:// autolink (no ![]() image syntax) renders as a link, not inline pixels,
  // so it must not suppress the gallery copy either.
  const autolink = { role: "assistant", model: "m", provider: "p", content: [{ type: "text", text: "see file:///home/u/.pi/images/a.png for the render" }] };
  assert.equal(collectTurnResultImages([autolink, custom("c7", "/home/u/.pi/images/a.png")], new Map(), ["m", "c7"]).length, 1);
});

test("metadata survives SSE projection without paths or arbitrary large fields", () => {
  const output = result("a", { ...metadata(1), outline: "x".repeat(10000) });
  const wire = toClientAgentEvent({ type: "message_end", message: output }).message;
  assert.deepEqual(wire.details, { modelImages: { version: 1, outputs: [{ blockIndex: 1, kind: "generated-image" }] } });
  assert.equal(collectTurnResultImages([wire], new Map()).length, 1);
});

test("new persisted results reload via deferred image URLs, remapping omitted preceding blocks", () => {
  const output = { ...result("a", metadata(2)), content: [{ type: "image", data: "QQ==", mimeType: "image/tiff" }, { type: "text", text: "ok" }, image] };
  const entries = [{ type: "message", id: "r1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: output }];
  const context = buildSessionContext(entries, undefined, { deferToolResultImages: true, sessionId: "s1" });
  const restored = context.messages[0];
  assert.deepEqual([...generatedImageIndices(restored)], [1]);
  assert.equal(restored.content[1].source.url, "/api/sessions/s1/entries/r1/tool-result-image?blockIndex=2");
  const full = collectTurnResultImages([output], new Map());
  const regularOutput = result("a", metadata(1));
  const regularEntries = [{ ...entries[0], message: regularOutput }];
  const regular = buildSessionContext(regularEntries, undefined, { deferToolResultImages: true, sessionId: "s1" }).messages;
  assert.equal(collectTurnResultImages(regular, new Map())[0].key, collectTurnResultImages([regularOutput], new Map())[0].key);
  assert.equal(full.length, 1);
  assert.equal(collectTurnResultImages(buildSessionContext(entries, undefined, { deferToolResultImages: true }).messages, new Map()).length, 0);
});
