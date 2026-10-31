"use client";

import { useEffect, useState } from "react";
import { initialFileResourceUrl, openFilePreviewUrl, openFileResourceUrl } from "@/lib/file-resource-url";

/** Acquire and revoke a resource even when acquisition finishes after unmount. */
export function useFileResourceUrl(path?: string | null, sessionId?: string | null, revision?: number, preview = false): string | undefined {
  const [resource, setResource] = useState<{ path: string; sessionId?: string | null; revision?: number; preview: boolean; url: string }>();
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    const open = preview ? openFilePreviewUrl : openFileResourceUrl;
    void open(path, sessionId, revision).then((opened) => {
      if (cancelled) { opened.release(); return; }
      release = opened.release;
      setResource({ path, sessionId, revision, preview, url: opened.url });
    }).catch(() => { if (!cancelled) setResource(undefined); });
    return () => { cancelled = true; release?.(); };
  }, [path, sessionId, revision, preview]);
  return resource && resource.path === path && resource.sessionId === sessionId && resource.revision === revision && resource.preview === preview
    ? resource.url
    : path ? initialFileResourceUrl(path, sessionId, revision, preview) : undefined;
}
