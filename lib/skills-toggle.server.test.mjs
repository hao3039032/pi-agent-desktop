import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";

const { toggleSkillFile } = await createJiti(import.meta.url)("./skills-toggle.server.ts");

test("skill toggle preserves content and enforces authorized real roots", async () => {
  const temp = await mkdtemp(join(tmpdir(), "skills-toggle-"));
  try {
    const root = join(temp, "agent");
    await mkdir(root);
    const skill = join(root, "SKILL.md");
    const outside = join(temp, "outside.md");
    const original = "---\nname: example\n---\nbody\n";
    await writeFile(skill, original);
    await writeFile(outside, original);
    const roots = new Set([root]);
    assert.equal(toggleSkillFile(skill, true, roots), null);
    assert.match(await readFile(skill, "utf8"), /disable-model-invocation: true/);
    assert.equal(toggleSkillFile(skill, false, roots), null);
    assert.equal(await readFile(skill, "utf8"), original);
    assert.equal(toggleSkillFile(outside, true, roots)?.status, 403);
    assert.equal(toggleSkillFile(join(root, "settings.json"), true, roots)?.status, 400);
    assert.equal(toggleSkillFile(join(root, "missing.md"), true, roots)?.status, 404);
    if (process.platform !== "win32") {
      const link = join(root, "link.md");
      await symlink(outside, link);
      assert.equal(toggleSkillFile(link, true, roots)?.status, 403);
    }
    assert.equal(await readFile(outside, "utf8"), original);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
