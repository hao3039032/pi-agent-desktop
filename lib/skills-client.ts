import type { SkillsResponse, SkillToggleResult, SkillSearchResult, SkillUpdateResult, SkillInstallScope } from "@/lib/api-types";

export async function checkSkills(cwd: string, pkg?: string, scope?: SkillInstallScope): Promise<SkillUpdateResult[]> {
  const response = await fetch("/api/skills/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, package: pkg, scope }) });
  const data = await response.json() as { updates?: SkillUpdateResult[]; error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data.updates ?? [];
}

export async function searchSkills(_cwd: string, query: string): Promise<SkillSearchResult[]> {
  const response = await fetch("/api/skills/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
  const data = await response.json() as { results?: SkillSearchResult[]; error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data.results ?? [];
}

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
