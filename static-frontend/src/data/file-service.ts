/**
 * The IPC-backed file-tree service (the static build's alias target for
 * lib/file-service.ts): listing and the linked-directory grant travel the
 * typed IPC bridge (files.list / files.allowLink over pi_ipc) instead of
 * /api/files. Same exported surface, same error text contract.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import { joinFilePath } from "../../../lib/file-paths";
import type { FileEntry, FileNodeEntry } from "../../../lib/file-service";
import type { FileIndexEntry } from "../../../lib/file-fuzzy";

let client: IpcClient | null = null;

export function bindFileService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) throw new Error("the file service IPC bridge is not configured (bindFileService)");
  return client;
}

function toError(failure: IpcFailure, fallback: string): Error {
  return new Error(failure.error.message || fallback);
}

export async function fetchFileEntries(dirPath: string): Promise<FileNodeEntry[]> {
  try {
    const data = await ensureClient().request<{ entries?: FileEntry[] }>(
      "files.list",
      { path: dirPath },
      { timeoutMs: 15_000 },
    );
    return (data.entries ?? []).map((entry) => ({
      name: entry.name,
      fullPath: joinFilePath(dirPath, entry.name),
      isDir: entry.isDir,
      size: entry.size,
      children: entry.isDir ? [] : undefined,
      loaded: !entry.isDir,
      outsideLinkTarget: entry.outsideLinkTarget,
      outsideLinkEncloses: entry.outsideLinkEncloses,
    }));
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Failed to load files");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/**
 * The operator confirmed browsing the linked directory's target. The host
 * re-validates the shown target (a re-aimed link is refused); this side
 * never widens roots itself.
 */
export async function allowOutsideLink(linkPath: string, target: string): Promise<void> {
  try {
    await ensureClient().request(
      "files.allowLink",
      { link: linkPath, target },
      { timeoutMs: 15_000 },
    );
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Failed to allow the linked folder");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Search files in cwd using server fuzzy search (?q=) over files.index IPC. */
export async function searchFileIndex(
  cwd: string,
  query: string,
  _signal?: AbortSignal,
): Promise<FileIndexEntry[]> {
  try {
    const data = await ensureClient().request<{ matches?: FileIndexEntry[] }>(
      "files.index",
      { cwd, q: query },
      { timeoutMs: 15_000 },
    );
    return data.matches ?? [];
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Failed to search file index");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Fetch full file index for cwd over files.index IPC. */
export async function fetchFileIndex(
  cwd: string,
): Promise<{ files: string[]; truncated: boolean }> {
  try {
    const data = await ensureClient().request<{ files?: string[]; truncated?: boolean }>(
      "files.index",
      { cwd },
      { timeoutMs: 15_000 },
    );
    return { files: data.files ?? [], truncated: Boolean(data.truncated) };
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Failed to fetch file index");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Read full file content over files.read IPC. */
export async function readFileContent(filePath: string): Promise<{ mime: string; data: string }> {
  try {
    return await ensureClient().request<{ mime: string; data: string }>(
      "files.read",
      { path: filePath },
      { timeoutMs: 15_000 },
    );
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Failed to read file");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Grant a preview resource handle for an allowed file. */
export async function grantFileResource(filePath: string): Promise<string> {
  try {
    const data = await ensureClient().request<{ handle: string }>(
      "resources.grantFile",
      { path: filePath },
      { timeoutMs: 15_000 },
    );
    return data.handle;
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Failed to grant resource");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Read resource by handle over resources.read IPC. */
export async function readFileResource(
  handle: string,
  subpath?: string,
  range?: { start: number; end: number },
): Promise<{ mime: string; data: string; totalLen?: number; rangeApplied?: boolean }> {
  try {
    return await ensureClient().request<{
      mime: string;
      data: string;
      totalLen?: number;
      rangeApplied?: boolean;
    }>(
      "resources.read",
      { handle, subpath: subpath ?? "", start: range?.start, end: range?.end },
      { timeoutMs: 15_000 },
    );
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Failed to read resource");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Revoke preview resource handle over resources.revoke IPC. */
export async function revokeFileResource(handle: string): Promise<boolean> {
  try {
    const data = await ensureClient().request<{ revoked: boolean }>(
      "resources.revoke",
      { handle },
      { timeoutMs: 15_000 },
    );
    return data.revoked;
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Failed to revoke resource");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}
