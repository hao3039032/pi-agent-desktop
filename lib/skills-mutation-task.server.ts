import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getProjectTrustStatus } from "@/lib/project-trust";
import { runNpx } from "@/lib/npx";
import { buildSkillUpdateArgs } from "@/lib/skill-updates";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import type { SkillInstallScope } from "@/lib/api-types";

export async function runSkillMutationTask(
  input: { cwd: string; action: "install" | "update"; package: string; scope: SkillInstallScope },
  context: { signal: AbortSignal; progress: (value: { phase: string }) => void },
) {
  const pkg = input.package.trim();
  if (!pkg || pkg.startsWith("-")) throw new Error("Invalid package");
  if (input.scope === "project" && !getProjectTrustStatus(input.cwd, getAgentDir()).trusted) throw new Error("Project resources must be trusted");
  if (context.signal.aborted) throw new Error("Operation cancelled before start");
  let args: string[];
  if (input.action === "update") {
    const { skills } = await loadSkillsWithInstallInfo(input.cwd);
    const skill = skills.find((item) => item.install?.package === pkg && item.install.scope === input.scope);
    if (!skill?.install?.canCheckForUpdates) throw new Error("Installed skill cannot be updated");
    args = buildSkillUpdateArgs(skill.install);
  } else {
    args = ["skills", "add", pkg, "-y", "--agent", "pi"];
    if (input.scope === "global") args.push("-g");
  }
  context.progress({ phase: "running" });
  try {
    const { stdout, stderr } = await runNpx(args, {
      cwd: input.scope === "project" ? input.cwd : undefined,
      env: { ...process.env, FORCE_COLOR: "0" },
      signal: context.signal,
    });
    if (context.signal.aborted) throw new Error("Operation aborted");
    if (input.action === "install" && !/Installation complete|Installed \d+ skill/.test((stdout + stderr).replace(/\x1B\[[0-9;]*m/g, ""))) throw new Error("Install failed");
    const refreshed = await loadSkillsWithInstallInfo(input.cwd);
    context.progress({ phase: "complete" });
    return { success: true, skill: refreshed.skills.find((item) => item.install?.package === pkg && item.install.scope === input.scope) };
  } catch (error) {
    throw Object.assign(new Error("Skill operation outcome unknown"), { code: "outcome_unknown", cause: error });
  }
}
