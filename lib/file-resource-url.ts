"use client";

import { encodeFilePathForApi } from "./file-paths";

/** Next retains its file route until the static-host cutover. */
export async function openFileResourceUrl(path: string, sessionId?: string | null, revision?: number): Promise<{ url: string; release: () => void }> {
  const params = new URLSearchParams({ type: "read" });
  if (sessionId) params.set("sessionId", sessionId);
  if (revision) params.set("v", String(revision));
  return { url: `/api/files/${encodeFilePathForApi(path)}?${params}`, release: () => {} };
}
