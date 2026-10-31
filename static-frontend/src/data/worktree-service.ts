import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type { WorktreeList } from "../../../lib/worktree-service";

let client: IpcClient | null = null;
export function bindWorktreeService(value: IpcClient): void { client = value; }
function request<T>(op: string, args: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  if (!client) throw new Error("worktree IPC bridge is not configured");
  return client.request<T>(op, args, { timeoutMs });
}
export function listWorktrees(cwd: string, branches = false): Promise<WorktreeList> { return request("worktrees.list", { cwd, branches }); }
export function createWorktree(cwd: string, branch: string): Promise<{ path: string; branch: string }> { return request("worktrees.create", { cwd, branch }, 310_000); }
export function switchWorktreeBranch(cwd: string, branch: string): Promise<{ branch: string }> { return request("worktrees.switch", { cwd, branch }, 15_000); }
export async function deleteWorktree(cwd: string, path: string, force: boolean): Promise<void> {
  try { await request("worktrees.delete", { cwd, path, force }); }
  catch (error) {
    if (error instanceof IpcFailure && error.error.details?.dirty === true) {
      const dirty = new Error(error.error.message) as Error & { dirty: boolean }; dirty.dirty = true; throw dirty;
    }
    throw error;
  }
}
export function fetchWorktreeBranches(cwd: string): Promise<{ branches: string[]; remoteBranches: string[] }> { return request("worktrees.fetch", { cwd }, 100_000); }
