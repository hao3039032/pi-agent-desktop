/**
 * The IPC-backed file-tree service (the static build's alias target for
 * lib/file-service.ts): listing and the linked-directory grant travel the
 * typed IPC bridge (files.list / files.allowLink over pi_ipc) instead of
 * /api/files. Same exported surface, same error text contract.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import { joinFilePath } from "../../../lib/file-paths";
import type { FileEntry, FileNodeEntry } from "../../../lib/file-service";

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
