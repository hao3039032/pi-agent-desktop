import type { SkillsResponse, SkillToggleResult } from "@/lib/api-types";

export async function listSkills(cwd: string): Promise<SkillsResponse> {
  const response = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`);
  const data = await response.json() as SkillsResponse & { error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export async function setSkillsDisabled(cwd: string, filePaths: string[], disableModelInvocation: boolean): Promise<SkillToggleResult[]> {
  void cwd;
  const response = await fetch("/api/skills", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filePaths, disableModelInvocation }),
  });
  const data = await response.json() as { results?: SkillToggleResult[]; error?: string };
  if (!response.ok || data.error || !data.results) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data.results;
}
