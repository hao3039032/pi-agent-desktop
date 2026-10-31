import { checkPluginUpdates } from "@/lib/plugin-updates";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { checkSkillUpdates } from "@/lib/skill-updates";
import type { PluginScope, SkillInstallScope } from "@/lib/api-types";

export async function checkManagedPluginUpdates(cwd: string, source?: string, scope?: PluginScope) {
  if (Boolean(source) !== Boolean(scope)) throw new Error("source and scope must be provided together");
  const updates = await checkPluginUpdates(cwd, source && scope ? { source, scope } : undefined);
  if (source && updates.length === 0) throw new Error("Configured package not found");
  return { updates };
}

export async function checkManagedSkillUpdates(cwd: string, pkg?: string, scope?: SkillInstallScope) {
  if (Boolean(pkg) !== Boolean(scope)) throw new Error("package and scope must be provided together");
  const { skills } = await loadSkillsWithInstallInfo(cwd);
  const installs = skills.map((skill) => skill.install)
    .filter((install): install is NonNullable<typeof install> => Boolean(install))
    .filter((install) => !pkg || (install.package === pkg && install.scope === scope));
  if (pkg && installs.length === 0) throw new Error("Installed skill not found");
  return { updates: await checkSkillUpdates(installs, { githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN }) };
}
