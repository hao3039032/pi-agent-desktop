import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { userHome } from "@/lib/user-home";
import type { SkillToggleResult } from "@/lib/api-types";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { toggleSkillFile } from "@/lib/skills-toggle.server";

/** Only skills visible in this resource scope can be edited through desktop IPC. */
export async function setVisibleSkillsDisabled(cwd: string, filePaths: string[], disabled: boolean, allowedRoots: string[] = [cwd]): Promise<SkillToggleResult[]> {
  const { skills } = await loadSkillsWithInstallInfo(cwd);
  const visible = new Set(skills.map((skill) => skill.filePath));
  // Match the Next route's edit boundary, including globally installed skills
  // whose symlink targets live outside the agent directory.
  const roots = new Set([...allowedRoots, getAgentDir(), path.join(userHome(), ".agents", "skills")]);
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
