export interface WorktreeEntry { path: string; branch: string | null; isMain: boolean }
export interface WorktreeList { projectRoot: string; projectKey?: string; isGit: boolean; isTopLevel: boolean; currentWorktreePath: string | null; worktrees: WorktreeEntry[]; branches?: string[]; remoteBranches?: string[]; error?: string }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error ?? `HTTP ${response.status}`) as Error & { dirty?: boolean };
    error.dirty = data.dirty === true;
    throw error;
  }
  return data as T;
}
export function listWorktrees(cwd: string, branches = false): Promise<WorktreeList> {
  return request(`/api/worktrees?cwd=${encodeURIComponent(cwd)}${branches ? "&branches=1" : ""}`);
}
function mutation<T>(method: string, body: object, url = "/api/worktrees"): Promise<T> {
  return request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
export function createWorktree(cwd: string, branch: string): Promise<{ path: string; branch: string }> { return mutation("POST", { cwd, branch }); }
export function switchWorktreeBranch(cwd: string, branch: string): Promise<{ branch: string }> { return mutation("PUT", { cwd, branch }); }
export function deleteWorktree(cwd: string, path: string, force: boolean): Promise<void> { return mutation("DELETE", { cwd, path, force }); }
export function fetchWorktreeBranches(cwd: string): Promise<{ branches: string[]; remoteBranches: string[] }> { return mutation("POST", { cwd }, "/api/worktrees/fetch"); }
