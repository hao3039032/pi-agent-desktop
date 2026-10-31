"use client";

import { encodeFilePathForApi } from "./file-paths";

/** Next retains its file route until the static-host cutover. */
export function initialFileResourceUrl(path: string, sessionId?: string | null, revision?: number, preview = false): string {
  const params = new URLSearchParams({ type: preview ? "serve" : "read" });
  if (sessionId) params.set("sessionId", sessionId);
  if (revision) params.set("v", String(revision));
  return `/api/files/${encodeFilePathForApi(path)}?${params}`;
}

export async function openFileResourceUrl(path: string, sessionId?: string | null, revision?: number): Promise<{ url: string; release: () => void }> {
  return { url: initialFileResourceUrl(path, sessionId, revision), release: () => {} };
}

export async function openFilePreviewUrl(path: string, sessionId?: string | null, revision?: number): Promise<{ url: string; release: () => void }> {
  return { url: initialFileResourceUrl(path, sessionId, revision, true), release: () => {} };
}
