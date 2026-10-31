import type { SkillsResponse, SkillToggleResult } from "../../../lib/api-types";
import { IpcClient } from "../ipc/client.ts";

let client: IpcClient | null = null;
export function bindSkillsClient(bound: IpcClient): void { client = bound; }
function ipc(): IpcClient {
  if (!client) throw new Error("skills IPC bridge is not configured");
  return client;
}
export function listSkills(cwd: string): Promise<SkillsResponse> {
  return ipc().request("skills.list", { cwd }, { timeoutMs: 60_000 });
}
export function setSkillsDisabled(cwd: string, filePaths: string[], disableModelInvocation: boolean): Promise<SkillToggleResult[]> {
  return ipc().request("skills.setDisabled", { cwd, filePaths, disableModelInvocation }, { timeoutMs: 60_000 });
}
