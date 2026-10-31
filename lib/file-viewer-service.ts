"use client";
import { encodeFilePathForApi } from "./file-paths";

export interface FileWatcher {
  addEventListener(type: string, listener: (event: Event) => void): void;
  onerror: ((event: Event) => void) | null;
  close(): void;
}
function url(path: string, type: string, sessionId?: string | null): string {
  const params = new URLSearchParams({ type });
  if (sessionId) params.set("sessionId", sessionId);
  return `/api/files/${encodeFilePathForApi(path)}?${params}`;
}
export async function fetchFileMetadata(path: string, sessionId?: string | null): Promise<{ size?: number; error?: string }> {
  const response = await fetch(url(path, "meta", sessionId));
  return response.json();
}
export async function loadDocxPreview(path: string, sessionId?: string | null, revision?: number): Promise<{ url?: string; srcDoc?: string }> {
  const params = new URLSearchParams({ type: "preview" });
  if (sessionId) params.set("sessionId", sessionId);
  if (revision) params.set("v", String(revision));
  return { url: `/api/files/${encodeFilePathForApi(path)}?${params}` };
}
export function watchFile(path: string, sessionId?: string | null): FileWatcher {
  return new EventSource(url(path, "watch", sessionId)) as unknown as FileWatcher;
}
