/**
 * The transition-version state mirror — server side (plan §七.1–3): atomic
 * writes with private permissions, strictly increasing revisions (a stale
 * retry never rolls the mirror back) and corruption-safe reads. Runs in a
 * temp agent dir; the real ~/.pi/agent is never touched.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { buildStateMirrorPayload } = await jiti.import("./state-mirror.ts");
const { readStateMirror, stateMirrorPath, writeStateMirror } = await jiti.import("./state-mirror-store.ts");

async function tempAgentDir() {
  return mkdtemp(join(tmpdir(), "pi-state-mirror-"));
}

test("write then read roundtrips, and the file is private and valid JSON", async (t) => {
  const agentDir = await tempAgentDir();
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const payload = buildStateMirrorPayload({ "pi-theme": "dark", "pi-chat-drafts-v1": "{}" }, 3);
  const result = writeStateMirror(payload, agentDir);
  assert.deepEqual(result, { ok: true, revision: 3, bytes: result.ok ? result.bytes : 0 });

  const read = readStateMirror(agentDir);
  assert.equal(read.ok, true);
  assert.deepEqual(read.payload.entries, payload.entries);
  assert.equal(read.payload.revision, 3);

  // The file sits DIRECTLY under the agent dir — agentDir is already
  // `~/.pi/agent` (the old spelling nested a phantom `.pi/agent` under it).
  assert.equal(stateMirrorPath(agentDir), join(agentDir, "desktop-state-mirror.json"));

  const raw = await readFile(stateMirrorPath(agentDir), "utf8");
  JSON.parse(raw); // the file on disk is whole JSON, not a partial write
  if (process.platform !== "win32") {
    const { statSync } = await import("node:fs");
    assert.equal(statSync(stateMirrorPath(agentDir)).mode & 0o777, 0o600, "private mode");
  }
});

test("each accepted write keeps a one-deep backup of the previous good payload", async (t) => {
  const agentDir = await tempAgentDir();
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  writeStateMirror(buildStateMirrorPayload({ "a": "1" }, 1), agentDir);
  writeStateMirror(buildStateMirrorPayload({ "a": "2" }, 2), agentDir);

  const { readFileSync, existsSync } = await import("node:fs");
  const backup = join(agentDir, "desktop-state-mirror.json.bak");
  assert.equal(existsSync(backup), true, "the previous payload is backed up");
  const parsed = JSON.parse(readFileSync(backup, "utf8"));
  assert.equal(parsed.revision, 1, "the backup holds the PREVIOUS revision");
  assert.deepEqual(parsed.entries, { "a": "1" });

  // A rejected (stale) write never disturbs the backup.
  const stale = writeStateMirror(buildStateMirrorPayload({ "a": "3" }, 2), agentDir);
  assert.equal(stale.ok, false);
  assert.equal(JSON.parse(readFileSync(backup, "utf8")).revision, 1);
});

test("revisions must strictly increase: stale retries are rejected", async (t) => {
  const agentDir = await tempAgentDir();
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  assert.equal(writeStateMirror(buildStateMirrorPayload({ a: "1" }, 5), agentDir).ok, true);
  const stale = writeStateMirror(buildStateMirrorPayload({ a: "1" }, 5), agentDir);
  assert.deepEqual(stale, { ok: false, reason: "stale" });
  const older = writeStateMirror(buildStateMirrorPayload({ a: "1" }, 4), agentDir);
  assert.deepEqual(older, { ok: false, reason: "stale" });
  assert.equal(writeStateMirror(buildStateMirrorPayload({ a: "2" }, 6), agentDir).ok, true);
  const read = readStateMirror(agentDir);
  assert.equal(read.payload?.entries.a, "2", "the mirror never rolled back");
});

test("invalid payloads are refused without creating a file", async (t) => {
  const agentDir = await tempAgentDir();
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  for (const bad of [null, {}, { schemaVersion: 1 }, "text", { ...buildStateMirrorPayload({}, 1), checksum: "fnv1a64-0000" }]) {
    const result = writeStateMirror(bad, agentDir);
    assert.equal(result.ok, false, `refused ${JSON.stringify(bad).slice(0, 40)}`);
  }
  const read = readStateMirror(agentDir);
  assert.deepEqual(read, { ok: false, reason: "missing" });
});

test("a corrupt mirror file reads as corrupt, never as empty success", async (t) => {
  const agentDir = await tempAgentDir();
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const file = stateMirrorPath(agentDir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "{ this is not json", "utf8");
  const read = readStateMirror(agentDir);
  assert.deepEqual(read, { ok: false, reason: "corrupt" });
  // The next good write replaces it (the client keeps retrying forward).
  assert.equal(writeStateMirror(buildStateMirrorPayload({ a: "1" }, 1), agentDir).ok, true);
  assert.equal(readStateMirror(agentDir).ok, true);
});

test("entries whose values are not strings fail verification", async (t) => {
  const agentDir = await tempAgentDir();
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const payload = buildStateMirrorPayload({}, 1);
  const bad = { ...payload, entries: { k: 1 } };
  const result = writeStateMirror(bad, agentDir);
  assert.equal(result.ok, false);
});
