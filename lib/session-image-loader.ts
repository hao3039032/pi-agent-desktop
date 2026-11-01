import type { ImageContent } from "./types";

type SessionImageSource = Extract<ImageContent["source"], { type: "session" }>;
export type SessionImageResource = { url: string; release: () => void; save?: (name: string) => Promise<boolean> };

/** One mounted image owns its grant; a result arriving after cleanup is revoked. */
export function attachSessionImage(
  source: SessionImageSource,
  open: (sessionId: string, entryId: string, blockIndex: number) => Promise<SessionImageResource>,
  onReady: (resource: SessionImageResource) => void,
  onError: () => void,
): () => void {
  let active = true;
  let release: (() => void) | undefined;
  void open(source.sessionId, source.entryId, source.blockIndex).then((resource) => {
    if (!active) { resource.release(); return; }
    release = resource.release;
    onReady(resource);
  }, () => { if (active) onError(); });
  return () => { active = false; release?.(); release = undefined; };
}
