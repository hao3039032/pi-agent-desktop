import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { patchExportHtml } from "./session-export-html.ts";
import { exportFromFile } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/index.js";

test("pi export retains a 5000-entry deep session and replaces all recursive browser helpers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-export-fixture-"));
  try {
    const file = join(dir, "session.jsonl");
    const lines = [{ type: "session", version: 3, id: "export-fixture", cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" }];
    for (let i = 0; i < 5000; i++) lines.push({ type: "message", id: `id${i}`, parentId: i ? `id${i - 1}` : null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: `message ${i}` } });
    await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const output = join(dir, "session.html");
    await exportFromFile(file, output);
    const patched = patchExportHtml(await readFile(output, "utf8"));
    assert.doesNotMatch(patched, /node\.children\.forEach\(sortChildren\)|node\.children\.forEach\(mapNodes\)|if \(markActive\(child\)\)/);
    const payload = patched.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
    const data = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    assert.equal(data.entries.length, 5000);
    assert.equal(data.entries.at(-1).id, "id4999");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
