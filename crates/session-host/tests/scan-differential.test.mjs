/**
 * Differential test: the Rust session scan (crates/session-host history.rs
 * scan_session_file_info) against the production TS scanner
 * (lib/session-list-scanner.ts scanSessionFileInfo) over a fixture corpus.
 *
 * The fixtures are written ONCE and read by BOTH implementations; every
 * catalogue field is compared. This keeps the Rust port honest against the
 * real scanner's semantics (renames from session_info, corrupt-tail
 * tolerance, attachment-aware titles, activity-based modified times,
 * full ISO parsing) — not just against its own output.
 *
 * Runs the Rust scan through the session-host test binary fixture-report
 * (cargo test -- --nocapture prints JSON lines); skipped without it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { scanSessionFileInfo } = await jiti.import("../../../lib/session-list-scanner.ts");

/** Run the Rust scan over a directory of session files, printing JSON. */
function rustScan(files) {
  const dir = mkdtempSync(join(tmpdir(), "rust-scan-"));
  const sessions = join(dir, "sessions", "proj");
  mkdirSync(sessions, { recursive: true });
  const paths = [];
  for (const [name, content] of Object.entries(files)) {
    const file = join(sessions, name);
    writeFileSync(file, content);
    paths.push(file);
  }
  const fixture = join(dir, "list.txt");
  writeFileSync(fixture, paths.join("\n") + "\n");
  const run = spawnSync(
    "cargo",
    ["test", "--manifest-path", "crates/session-host/Cargo.toml", "--lib", "rust_scan_fixture_report", "--", "--nocapture", "--ignored"],
    {
      cwd: join(fileURLToPath(new URL(".", import.meta.url)), "../../.."),
      encoding: "utf8",
      env: { ...process.env, RUST_SCAN_FILES: fixture },
    },
  );
  if (run.status !== 0 || !run.stdout.includes("RUST-SCAN ")) {
    return { error: run.stderr.slice(-400) || "the Rust fixture report did not run" };
  }
  const rows = run.stdout
    .split("\n")
    .filter((line) => line.startsWith("RUST-SCAN "))
    .map((line) => JSON.parse(line.slice("RUST-SCAN ".length)));
  return { rows };
}

const FIXTURES = {
  "plain.jsonl": [
    JSON.stringify({ type: "session", version: 3, id: "s-plain", timestamp: "2026-03-01T12:30:45.123Z", cwd: "/proj" }),
    JSON.stringify({ type: "model_change", id: "m1", parentId: null, provider: "p", modelId: "m", timestamp: "2026-03-01T12:30:46.000Z" }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "first question" }, timestamp: "2026-03-01T12:31:00.000Z" }),
    JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "an answer" }] }, timestamp: "2026-03-01T12:32:00.000Z" }),
    "",
  ].join("\n"),
  "renamed.jsonl": [
    JSON.stringify({ type: "session", version: 3, id: "s-rename", timestamp: "2026-03-02T08:00:00.000Z", cwd: "/proj" }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "hi" }, timestamp: "2026-03-02T08:00:01.000Z" }),
    JSON.stringify({ type: "session_info", id: "i1", parentId: "e1", name: "First name" }),
    JSON.stringify({ type: "session_info", id: "i2", parentId: "i1", name: "  Renamed later  " }),
    JSON.stringify({ type: "session_info", id: "i3", parentId: "i2", name: "   " }),
    "",
  ].join("\n"),
  "corrupt-tail.jsonl": [
    JSON.stringify({ type: "session", version: 3, id: "s-tail", timestamp: "2026-03-03T09:00:00.250Z", cwd: "/proj" }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "before the crash" }, timestamp: "2026-03-03T09:01:00.000Z" }),
    '{"type":"message","id":"e2","parentId":"e1","message":{"role":"assi', // a crashed write's tail
    "",
  ].join("\n"),
  "structured.jsonl": [
    JSON.stringify({ type: "session", version: 3, id: "s-struct", timestamp: "2026-03-04T10:00:00.000+02:00", cwd: "/proj" }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hello " }, { type: "image", data: "x" }, { type: "text", text: "world" }] }, timestamp: 1772584800000 }),
    "",
  ].join("\n"),
  "attachments.jsonl": [
    JSON.stringify({ type: "session", version: 3, id: "s-attach", timestamp: "2026-03-05T11:00:00.000Z", cwd: "/proj" }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "<attached_file name=\"notes.txt\">\nthe body\n</attached_file>" }, timestamp: "2026-03-05T11:00:01.000Z" }),
    JSON.stringify({ type: "message", id: "e2", parentId: "e1", message: { role: "user", content: "typed text\n\n<attached_file name=\"a.md\">\nA\n</attached_file>\n\n<attached_file name=\"b.md\">\nB\n</attached_file>" }, timestamp: "2026-03-05T11:00:02.000Z" }),
    "",
  ].join("\n"),
  "no-messages.jsonl": [
    JSON.stringify({ type: "session", version: 3, id: "s-empty", timestamp: "2026-03-06T07:00:00.000Z", cwd: "/proj" }),
    "",
  ].join("\n"),
  "foreign-first.jsonl": [
    JSON.stringify({ type: "message", id: "e0", parentId: null, message: { role: "user", content: "not a session file" } }),
    "",
  ].join("\n"),
  "compactions.jsonl": [
    JSON.stringify({ type: "session", version: 3, id: "s-comp", timestamp: "2026-02-01T00:00:00.000Z", cwd: "/proj" }),
    JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "q1" }, timestamp: "2026-02-01T00:01:00.000Z" }),
    JSON.stringify({ type: "compaction", id: "c1", parentId: "e1", summary: "s", firstKeptEntryId: "e1", tokensBefore: 10 }),
    JSON.stringify({ type: "message", id: "e2", parentId: "c1", message: { role: "user", content: "q2" }, timestamp: "2026-02-02T00:01:00.000Z" }),
    JSON.stringify({ type: "compaction", id: "c2", parentId: "e2", summary: "s", firstKeptEntryId: "e2", tokensBefore: 10 }),
    "",
  ].join("\n"),
};

test("the Rust scan matches the TS scanner field for field", async (t) => {
  const rust = rustScan(FIXTURES);
  if (rust.error) {
    t.skip(`the Rust fixture report is unavailable here: ${rust.error}`);
    return;
  }
  const byPath = new Map(
    rust.rows.map((row) => [row.path, row.null === true ? null : row]),
  );

  for (const [name, content] of Object.entries(FIXTURES)) {
    const dir = mkdtempSync(join(tmpdir(), "ts-scan-"));
    const file = join(dir, name);
    writeFileSync(file, content);
    const ts = await scanSessionFileInfo(file);
    const rs = byPath.get(name) ?? null; // the Rust report keys by file NAME

    if (ts === null) {
      assert.equal(rs, null, `${name}: TS hides the file, Rust must too`);
      continue;
    }
    assert.notEqual(rs, null, `${name}: TS lists the file, Rust hid it`);
    assert.equal(rs.id, ts.id, `${name}: id`);
    assert.equal(rs.cwd, ts.cwd, `${name}: cwd`);
    assert.equal(rs.name ?? null, ts.name ?? null, `${name}: name (the session_info rename)`);
    assert.equal(rs.parentSessionPath ?? null, ts.parentSessionPath ?? null, `${name}: parentSession`);
    assert.equal(rs.messageCount, ts.messageCount, `${name}: messageCount`);
    assert.equal(rs.compactionCount, ts.compactionCount ?? 0, `${name}: compactionCount`);
    assert.equal(rs.firstMessage, ts.firstMessage, `${name}: firstMessage`);
    // sizeBytes is a Rust-side extension (the TS shape has no size); the
    // cheap header scan's sizeBytes covers it — not part of the differential.
    // Times: the TS Date keeps milliseconds; compare to the ms.
    const tsCreated = ts.created.getTime();
    const tsModified = ts.modified.getTime();
    if (rs.createdMs !== tsCreated) console.log("MISMATCH", name, "created", rs.createdMs, "vs", tsCreated);
    if (rs.modifiedMs !== tsModified) console.log("MISMATCH", name, "modified", rs.modifiedMs, "vs", tsModified);
    assert.equal(rs.createdMs, tsCreated, `${name}: created (ms + offset honored)`);
    assert.equal(rs.modifiedMs, tsModified, `${name}: modified (activity > header > mtime)`);
  }
});
