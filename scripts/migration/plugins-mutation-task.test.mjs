import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("plugin mutation worker uses SDK against an isolated local package", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugin-mutation-"));
  const saved = { ...process.env };
  try {
    const cwd = join(root, "project"), agentDir = join(root, "agent"), source = join(root, "fixture");
    await Promise.all([cwd, agentDir, source].map((p) => mkdir(p, { recursive: true })));
    await writeFile(join(source, "package.json"), JSON.stringify({ name: "plugin-fixture", version: "1.0.0" }));
    Object.assign(process.env, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir });
    const { runPluginMutationTask } = await createJiti(import.meta.url, { interopDefault: true, alias: { "@": join(import.meta.dirname, "../..") } }).import("../../lib/plugins-mutation-task.server.ts");
    const controller = new AbortController();
    const phases = [];
    const context = { signal: controller.signal, progress: (value) => phases.push(value.phase) };
    await runPluginMutationTask({ cwd, source, scope: "global", action: "install" }, context);
    assert.deepEqual(phases, ["running", "complete"]);
    assert.equal(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).packages.length, 1);
    await runPluginMutationTask({ cwd, source, scope: "global", action: "remove" }, context);
    assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).packages, []);
    controller.abort();
    await assert.rejects(runPluginMutationTask({ cwd, source, scope: "global", action: "install" }, context), /cancelled before/);
    assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).packages, []);
  } finally {
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  }
});
