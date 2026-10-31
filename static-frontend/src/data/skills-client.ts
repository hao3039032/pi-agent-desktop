import type { SkillInfo as Skill, SkillsResponse, SkillToggleResult, SkillSearchResult, SkillUpdateResult, SkillInstallScope } from "../../../lib/api-types";
import { IpcClient } from "../ipc/client.ts";

let client: IpcClient | null = null;
export function bindSkillsClient(bound: IpcClient): void { client = bound; }
function ipc(): IpcClient {
  if (!client) throw new Error("skills IPC bridge is not configured");
  return client;
}
export async function mutateSkill(cwd: string, action: "install" | "update", pkg: string, scope: SkillInstallScope, signal: AbortSignal, onProgress: (phase: string) => void): Promise<{ success: boolean; skill?: Skill }> {
  const bound = ipc();
  if (signal.aborted) throw new Error("Operation cancelled before start");
  const { handle } = await bound.request<{ handle: string }>(`skills.${action}.start`, { cwd, package: pkg, scope });
  let cancelled = false;
  for (;;) {
    if (signal.aborted && !cancelled) { cancelled = true; await bound.request("skills.mutation.cancel", { handle }); }
    const task = await bound.request<{ status: string; progress?: { phase?: string }; result?: { success: boolean; skill?: Skill }; error?: string }>("skills.mutation.status", { handle });
    if (task.progress?.phase) onProgress(task.progress.phase);
    if (task.status === "succeeded" && task.result) return task.result;
    if (task.status !== "running") throw new Error(task.error || `Skill operation ${task.status}; outcome may be unknown`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
export async function checkSkills(cwd: string, pkg?: string, scope?: SkillInstallScope): Promise<SkillUpdateResult[]> {
  const result = await ipc().request<{ updates: SkillUpdateResult[] }>("skills.check", { cwd, package: pkg, scope }, { timeoutMs: 65_000 });
  return result.updates;
}
export async function searchSkills(cwd: string, query: string): Promise<SkillSearchResult[]> {
  const data = await ipc().request<{ results: SkillSearchResult[] }>("skills.search", { cwd, query }, { timeoutMs: 65_000 });
  return data.results;
}
export function listSkills(cwd: string): Promise<SkillsResponse> {
  return ipc().request("skills.list", { cwd }, { timeoutMs: 60_000 });
}
export function setSkillsDisabled(cwd: string, filePaths: string[], disableModelInvocation: boolean): Promise<SkillToggleResult[]> {
  return ipc().request("skills.setDisabled", { cwd, filePaths, disableModelInvocation }, { timeoutMs: 60_000 });
}
