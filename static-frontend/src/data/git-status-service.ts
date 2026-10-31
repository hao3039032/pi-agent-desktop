import { IpcClient } from "../ipc/client.ts";
import type { GitFileDiffResponse, GitStatusResponse } from "../../../lib/git-types";
let client: IpcClient | null = null;
export function bindGitStatusService(value: IpcClient): void { client = value; }
function bound(): IpcClient { if (!client) throw new Error("Git IPC bridge is not configured"); return client; }
export async function fetchGitStatus(cwd: string, signal?: AbortSignal): Promise<GitStatusResponse> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const result = await bound().request<GitStatusResponse>("git.status", { cwd }, { timeoutMs: 15_000 });
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return result;
}
export function fetchGitDiff(cwd: string, path: string): Promise<GitFileDiffResponse> {
  return bound().request("git.diff", { cwd, path }, { timeoutMs: 15_000 });
}
