"use client";

/**
 * The file-tree service seam (migration M3): the data calls FileExplorer
 * makes — listing a directory, allowing a linked directory's target — live
 * here so the static build can swap them for the typed IPC bridge through a
 * vite alias, exactly like lib/agent-client.ts. The Next app keeps HTTP
 * until M5; the static build aliases this module to
 * static-frontend/src/data/file-service.ts.
 *
 * Everything else FileExplorer touches (git status, the file-index search,
 * uploads/downloads) migrates with their own domains and gets its own seam
 * then — this file grows one domain at a time.
 */

import { encodeFilePathForApi, joinFilePath } from "./file-paths";
import type { FileIndexEntry } from "./file-fuzzy";

export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified?: string;
  outsideLinkTarget?: string;
  outsideLinkEncloses?: boolean;
}

export interface FileNodeEntry {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children: FileNodeEntry[] | undefined;
  loaded: boolean;
  outsideLinkTarget?: string;
  outsideLinkEncloses?: boolean;
}

async function responseError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(body?.error ?? fallback);
}

/** List one directory inside the allowed roots (dirs first, alphabetical). */
export async function fetchFileEntries(dirPath: string): Promise<FileNodeEntry[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) throw await responseError(res, "Failed to load files");
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
    outsideLinkTarget: e.outsideLinkTarget,
    outsideLinkEncloses: e.outsideLinkEncloses,
  }));
}

/**
 * Send the target the operator was shown, so a link pointed elsewhere since
 * the listing is refused instead of granting a directory nobody looked at.
 */
export async function allowOutsideLink(linkPath: string, target: string): Promise<void> {
  const res = await fetch(`/api/files/${encodeFilePathForApi(linkPath)}?type=allow-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (!res.ok) throw await responseError(res, "Failed to allow the linked folder");
}

/** Search files in cwd using server fuzzy search (?q=). */
export async function searchFileIndex(
  cwd: string,
  query: string,
  signal?: AbortSignal,
): Promise<FileIndexEntry[]> {
  const res = await fetch(
    `/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`,
    { signal },
  );
  if (!res.ok) throw await responseError(res, "Failed to search file index");
  const data = (await res.json()) as { matches?: FileIndexEntry[] };
  return data.matches ?? [];
}

/** Fetch full file index for cwd. */
export async function fetchFileIndex(
  cwd: string,
): Promise<{ files: string[]; truncated: boolean }> {
  const res = await fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) throw await responseError(res, "Failed to fetch file index");
  const data = (await res.json()) as { files?: string[]; truncated?: boolean };
  return { files: data.files ?? [], truncated: Boolean(data.truncated) };
}

/** Read full file content (raw bytes encoded as base64). */
export async function readFileContent(filePath: string): Promise<{ mime: string; data: string }> {
  const encoded = encodeFilePathForApi(filePath);
  const res = await fetch(`/api/files/${encoded}?type=read`);
  if (!res.ok) throw await responseError(res, "Failed to read file");
  const mime = res.headers.get("content-type") ?? "application/octet-stream";
  const buffer = await res.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return { mime, data: btoa(binary) };
}

/** Grant a preview resource handle for an allowed file. */
export async function grantFileResource(filePath: string): Promise<string> {
  return filePath;
}

/** Read resource by handle. */
export async function readFileResource(
  handle: string,
): Promise<{ mime: string; data: string }> {
  return readFileContent(handle);
}

/** Revoke preview resource handle. */
export async function revokeFileResource(handle?: string): Promise<boolean> {
  void handle;
  return true;
}
