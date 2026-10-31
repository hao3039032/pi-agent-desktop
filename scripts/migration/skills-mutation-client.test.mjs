import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { IpcClient, MockTransport } = await jiti.import("../../static-frontend/src/ipc/client.ts");
const { bindSkillsClient, mutateSkill } = await jiti.import("../../static-frontend/src/data/skills-client.ts");

test("skills task forwards progress and cancels the same handle", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const transport = new MockTransport()
    .on("skills.update.start", ({ package: pkg }) => { assert.equal(pkg, "repo@skill"); return { handle: "task-skill" }; })
    .on("skills.mutation.status", ({ handle }) => { assert.equal(handle, "task-skill"); return cancelled ? { status: "unknown", error: "outcome unknown" } : { status: "running", progress: { phase: "running" } }; })
    .on("skills.mutation.cancel", ({ handle }) => { assert.equal(handle, "task-skill"); cancelled = true; return {}; });
  bindSkillsClient(new IpcClient(transport));
  await assert.rejects(mutateSkill("/cwd", "update", "repo@skill", "global", controller.signal, () => controller.abort()), /outcome unknown/);
  assert.equal(cancelled, true);
});
