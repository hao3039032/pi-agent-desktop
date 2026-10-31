import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("copyChatToProject keeps the source and clears chat prompt and tool pin", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-continue-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const cwd = join(root, "project");
    mkdirSync(cwd);
    const file = join(root, "source.jsonl");
    const rows = [
      { type: "session", version: 3, id: "chat-source", timestamp: "2026-01-01T00:00:00.000Z", cwd: join(root, "chat") },
      { type: "message", id: "system", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "system", content: "chat prompt" } },
      { type: "message", id: "user", parentId: "system", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "hello" } },
      { type: "custom", id: "pin", parentId: "user", timestamp: "2026-01-01T00:00:03.000Z", customType: "pi-web:tool-selection", data: { version: 1, tools: [] } },
    ];
    const source = rows.map(JSON.stringify).join("\n") + "\n";
    writeFileSync(file, source);
    const { copyChatToProject, setOfflineChatUnlock } = await createJiti(import.meta.url).import("./chat-continue.ts");
    const result = copyChatToProject(file, cwd);
    assert.ok(result.path.startsWith(join(root, "agent", "sessions") + "/"));
    assert.equal(readFileSync(file, "utf8"), source);
    const copied = readFileSync(result.path, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(copied[0].parentSession, file);
    assert.equal(copied[0].cwd, cwd);
    assert.notEqual(result.sessionId, "chat-source");
    assert.equal(copied.some(row => row.message?.role === "system"), false);
    assert.equal(copied.find(row => row.id === "user").parentId, null);
    assert.equal(copied.at(-1).customType, "pi-web:tool-selection");
    assert.equal(copied.at(-1).data.cleared, true);
    assert.equal(setOfflineChatUnlock(file, true), true);
    assert.equal(setOfflineChatUnlock(file, true), false);
    assert.equal(setOfflineChatUnlock(file, false), true);
    const updated = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
    const unlocks = updated.filter(row => row.customType === "pi-web:chat-unlock");
    assert.deepEqual(unlocks.map(row => row.data.unlocked), [true, false]);
    const damaged = join(root, "damaged.jsonl");
    const cyclic = [rows[0],
      { type: "message", id: "s1", parentId: "s2", message: { role: "system", content: "x" } },
      { type: "message", id: "s2", parentId: "s1", message: { role: "system", content: "y" } },
      { type: "message", id: "u2", parentId: "s1", message: { role: "user", content: "hi" } },
    ].map(JSON.stringify).join("\n") + "\n";
    writeFileSync(damaged, cyclic);
    const targetDir = result.path.slice(0, result.path.lastIndexOf("/"));
    const before = readdirSync(targetDir).sort();
    assert.throws(() => copyChatToProject(damaged, cwd), /cycle/);
    assert.equal(readFileSync(damaged, "utf8"), cyclic);
    assert.deepEqual(readdirSync(targetDir).sort(), before);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    rmSync(root, { recursive: true, force: true });
  }
});
