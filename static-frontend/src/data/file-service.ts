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
import { getFileLanguage } from "../../../lib/file-language";
import { TEXT_PREVIEW_MAX_BYTES } from "../../../lib/file-types";
import { textPreviewChunk } from "../../../lib/text-preview-bytes";

export function usesStaticFileHost(): boolean { return true; }

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

export async function renderDocxPreview(filePath: string, sessionId?: string | null): Promise<string> {
  const handle = await grantFileResource(filePath, sessionId);
  try {
    const result = await ensureClient().request<{ html: string }>("files.docxPreview", { handle }, { timeoutMs: 120_000 });
    return result.html;
  } finally {
    await revokeFileResource(handle).catch(() => {});
  }
}

export async function fetchResourceMetadata(filePath: string, sessionId?: string | null): Promise<{ size: number; revision: string }> {
  const handle = await grantFileResource(filePath, sessionId);
  try {
    return await ensureClient().request("resources.metadata", { handle }, { timeoutMs: 15_000 });
  } finally {
    await revokeFileResource(handle).catch(() => {});
  }
}

export async function checkProjectUploadTargets(directory: string, fileNames: string[]): Promise<{ conflicts: string[]; nonReplaceable: string[] }> {
  return ensureClient().request("files.uploadCheck", { directory, fileNames }, { timeoutMs: 15_000 });
}

export async function uploadProjectFile(directory: string, name: string, data: string, conflict: string): Promise<{ outcome: "uploaded" | "skipped" | "conflict" }> {
  return ensureClient().request("files.uploadFile", { directory, name, data, conflict }, { timeoutMs: 120_000 });
}

export async function fetchRevealSupport(): Promise<{ supported: boolean; reason: string | null; platform: string }> {
  return ensureClient().request("files.revealSupport", {}, { timeoutMs: 15_000 });
}

export async function revealDirectory(cwd: string): Promise<void> {
  await ensureClient().request("files.reveal", { cwd }, { timeoutMs: 15_000 });
}

export async function fileExists(filePath: string, sessionId?: string | null): Promise<boolean> {
  try {
    const handle = await grantFileResource(filePath, sessionId);
    await revokeFileResource(handle);
    return true;
  } catch { return false; }
}

export async function downloadFile(filePath: string, sessionId?: string | null): Promise<void> {
  const handle = await grantFileResource(filePath, sessionId);
  try {
    const { saveResourceAsNative } = await import("../../../lib/desktop-native");
    await saveResourceAsNative(handle, filePath.split(/[\\/]/).pop() ?? "download");
  } finally {
    await revokeFileResource(handle).catch(() => {});
  }
}

export async function fetchTextFileChunk(filePath: string, sessionId?: string | null, offset = 0): Promise<{ content: string; language: string; size: number; nextOffset: number; truncated: boolean }> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid text preview offset");
  const handle = await grantFileResource(filePath, sessionId);
  try {
    const result = await readFileResource(handle, "", { start: offset, end: offset + TEXT_PREVIEW_MAX_BYTES });
    const size = result.totalLen ?? 0;
    if (offset > size) throw new Error("Invalid text preview offset");
    const binary = atob(result.data);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return { ...textPreviewChunk(bytes, size, offset), language: getFileLanguage(filePath), size };
  } finally {
    await revokeFileResource(handle).catch(() => {});
  }
}

/** Grant a preview resource handle for an allowed file. */
export async function grantFileResource(filePath: string, sessionId?: string | null): Promise<string> {
  try {
    const data = await ensureClient().request<{ handle: string }>(
      "resources.grantFile",
      { path: filePath, ...(sessionId ? { sessionId } : {}) },
      { timeoutMs: 15_000 },
    );
    return data.handle;
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Failed to grant resource");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

export async function grantFilePreview(filePath: string): Promise<{ handle: string; name: string }> {
  try {
    return await ensureClient().request<{ handle: string; name: string }>("resources.grantPreview", { path: filePath }, { timeoutMs: 15_000 });
  } catch (caught) {
    if (caught instanceof IpcFailure) throw toError(caught, "Failed to grant preview");
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
