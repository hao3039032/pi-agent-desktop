import { realpathSync } from "node:fs";
import type { SkillToggleResult } from "@/lib/api-types";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { toggleSkillFile } from "@/lib/skills-toggle.server";

/** Only skills visible in this resource scope can be edited through desktop IPC. */
export async function setVisibleSkillsDisabled(cwd: string, filePaths: string[], disabled: boolean): Promise<SkillToggleResult[]> {
  const { skills } = await loadSkillsWithInstallInfo(cwd);
  const visible = new Set(skills.map((skill) => skill.filePath));
  const roots = new Set<string>();
  // Freeze each visible file's resolved target before authorizing edits; never
  // let a retargeted symlink expand the permitted roots.
  for (const skill of skills) {
    try { roots.add(realpathSync(skill.filePath)); } catch { /* removed since loading */ }
  }
  return [...new Set(filePaths)].map((filePath) => {
    if (!visible.has(filePath)) return { filePath, error: "Skill is not visible in this project" };
    try {
      const refused = toggleSkillFile(filePath, disabled, roots);
      return refused ? { filePath, error: refused.error } : { filePath };
    } catch (error) {
      return { filePath, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
