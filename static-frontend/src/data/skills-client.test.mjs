import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");
const { bindSkillsClient, listSkills, setSkillsDisabled } = await jiti.import("./skills-client.ts");

test("skills IPC client sends a scoped batch and preserves per-file failures", async () => {
  const calls = [];
  const transport = new MockTransport()
    .on("skills.list", (args) => { calls.push(args); return { skills: [], diagnostics: [], projectResourcesLoaded: false }; })
    .on("skills.setDisabled", (args) => { calls.push(args); return [{ filePath: "/a" }, { filePath: "/b", error: "denied" }]; });
  bindSkillsClient(new IpcClient(transport));
  assert.equal((await listSkills("/project")).projectResourcesLoaded, false);
  const results = await setSkillsDisabled("/project", ["/a", "/b"], true);
  assert.equal(results[1].error, "denied");
  assert.deepEqual(calls, [{ cwd: "/project" }, { cwd: "/project", filePaths: ["/a", "/b"], disableModelInvocation: true }]);
});
