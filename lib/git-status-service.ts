import type { GitFileDiffResponse, GitStatusResponse } from "./git-types";

/** Read Git status through the Next route; the static frontend can replace this service. */
export async function fetchGitStatus(cwd: string, signal?: AbortSignal): Promise<GitStatusResponse> {
  const response = await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`, { signal });
  const data = await response.json() as GitStatusResponse & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export async function fetchGitDiff(cwd: string, path: string): Promise<GitFileDiffResponse> {
  const params = new URLSearchParams({ cwd, path });
  const response = await fetch(`/api/git/diff?${params.toString()}`);
  const data = await response.json() as GitFileDiffResponse & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
