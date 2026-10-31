"use client";

import { useEffect, useState } from "react";
import { openFileResourceUrl } from "@/lib/file-resource-url";

/** Acquire and revoke a resource even when acquisition finishes after unmount. */
export function useFileResourceUrl(path?: string | null, sessionId?: string | null, revision?: number): string | undefined {
  const [resource, setResource] = useState<{ path: string; sessionId?: string | null; revision?: number; url: string }>();
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    void openFileResourceUrl(path, sessionId, revision).then((opened) => {
      if (cancelled) { opened.release(); return; }
      release = opened.release;
      setResource({ path, sessionId, revision, url: opened.url });
    }).catch(() => { if (!cancelled) setResource(undefined); });
    return () => { cancelled = true; release?.(); };
  }, [path, sessionId, revision]);
  return resource && resource.path === path && resource.sessionId === sessionId && resource.revision === revision ? resource.url : undefined;
}
