import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { buildTitleTranscript } = await createJiti(import.meta.url).import("./session-title.ts");

test("SDK title can remain in an unflushed custom-message session until a real user turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "title-unflushed-"));
  try {
    const cwd = join(root, "project"); const sessions = join(root, "sessions");
    await mkdir(cwd); await mkdir(sessions);
    const manager = SessionManager.create(cwd, sessions);
    manager.appendCustomMessageEntry("fixture", "Name this work", true);
    const file = manager.getSessionFile();
    assert.ok(file);
    await assert.rejects(stat(file), { code: "ENOENT" });
    assert.match(buildTitleTranscript(manager.buildSessionProjection().messages), /Name this work/);
    manager.appendSessionInfo("Unflushed title");
    assert.equal(manager.getSessionName(), "Unflushed title");
    await assert.rejects(stat(file), { code: "ENOENT" });
    manager.appendMessage({ role: "user", content: "Actual user turn", timestamp: Date.now() });
    assert.match(await readFile(file, "utf8"), /Unflushed title/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
