import { fetchResourceMetadata, renderDocxPreview } from "./file-service";
import { getFileName } from "../../../lib/file-paths";
import { wrapDocxPreviewHtml } from "../../../lib/docx-preview";
import type { FileWatcher } from "../../../lib/file-viewer-service";
export type { FileWatcher } from "../../../lib/file-viewer-service";

export async function fetchFileMetadata(path: string, sessionId?: string | null): Promise<{ size: number }> {
  return fetchResourceMetadata(path, sessionId);
}

export async function loadDocxPreview(path: string, sessionId?: string | null, _revision?: number): Promise<{ url?: string; srcDoc?: string }> {
  const html = await renderDocxPreview(path, sessionId);
  return { srcDoc: wrapDocxPreviewHtml(html, getFileName(path)) };
}

/** Poll the host's authorized file identity. Close prevents future requests. */
export function watchFile(path: string, sessionId?: string | null): FileWatcher {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  let closed = false, connected = false, revision: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher: FileWatcher = {
    onerror: null,
    addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
    close() { closed = true; if (timer) clearTimeout(timer); },
  };
  const emit = (type: string, event: Event) => { for (const listener of listeners.get(type) ?? []) listener(event); };
  const poll = async () => {
    try {
      const metadata = await fetchResourceMetadata(path, sessionId);
      if (closed) return;
      if (!connected) { connected = true; emit("connected", new Event("connected")); }
      if (revision !== undefined && revision !== metadata.revision) {
        emit("change", new MessageEvent("change", { data: JSON.stringify({ size: metadata.size }) }));
      }
      revision = metadata.revision;
    } catch {
      if (closed) return;
      connected = false;
      const event = new Event("error");
      emit("error", event);
      watcher.onerror?.(event);
    }
    if (!closed) timer = setTimeout(poll, 2000);
  };
  queueMicrotask(() => { if (!closed) void poll(); });
  return watcher;
}
