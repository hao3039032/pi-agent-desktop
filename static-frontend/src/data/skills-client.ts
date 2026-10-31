import type { SkillsResponse, SkillToggleResult, SkillSearchResult, SkillUpdateResult, SkillInstallScope } from "../../../lib/api-types";
import { IpcClient } from "../ipc/client.ts";

let client: IpcClient | null = null;
export function bindSkillsClient(bound: IpcClient): void { client = bound; }
function ipc(): IpcClient {
  if (!client) throw new Error("skills IPC bridge is not configured");
  return client;
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
