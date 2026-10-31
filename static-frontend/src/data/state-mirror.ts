/**
 * The static app's state-mirror import + write path (plan §七.4–5).
 *
 * IMPORT runs BEFORE React mounts (app-main.tsx): the payload the
 * transition version mirrored host-side is read over IPC
 * (`desktop.stateMirror`), verified, and each whitelisted entry lands in
 * localStorage ONLY when that key is absent — a newer local value is never
 * overwritten, and after a successful import the mirrored revision is
 * recorded so the mirror is never rolled back onto the imported state.
 *
 * WRITE is the same contract `hooks/useStateMirror.ts` had against
 * /api/state-mirror, over the typed IPC bridge instead: revision advances
 * only after the host ACKed, a stale (409-shaped) rejection adopts the
 * host's revision. The static build aliases the hook to this module.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import {
  STATE_MIRROR_REVISION_KEY,
  buildStateMirrorPayload,
  collectStateMirrorEntries,
  stateMirrorChecksum,
  verifyStateMirrorPayload,
  type StateMirrorPayload,
} from "../../../lib/state-mirror";

function readRevision(): number {
  try {
    const raw = window.localStorage.getItem(STATE_MIRROR_REVISION_KEY);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeRevision(revision: number): void {
  try {
    window.localStorage.setItem(STATE_MIRROR_REVISION_KEY, String(revision));
  } catch {
    // private mode: mirroring degrades to best-effort
  }
}

export interface ImportReport {
  imported: number;
  skippedExisting: number;
  revision: number;
}

/**
 * Import the host-side mirror into localStorage before React mounts.
 * Returns null when there is no mirror (a fresh install — plan §七.5: no
 * invented snapshot, no platform-private WebView database parsing).
 */
export async function importStateMirrorBeforeMount(client: IpcClient): Promise<ImportReport | null> {
  let payload: unknown;
  try {
    payload = await client.request<StateMirrorPayload | { missing: boolean }>(
      "desktop.stateMirror",
      undefined,
      { timeoutMs: 5_000 },
    );
  } catch {
    // The host bridge hiccupped at boot: keep local state as-is (the app
    // still runs; a later write re-establishes the mirror).
    return null;
  }
  if (payload === null || typeof payload !== "object") return null;
  if ((payload as { missing?: boolean }).missing === true) return null;
  if (!verifyStateMirrorPayload(payload)) return null;
  const mirror = payload as StateMirrorPayload;

  let imported = 0;
  let skippedExisting = 0;
  try {
    for (const [key, value] of Object.entries(mirror.entries)) {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, value);
        imported += 1;
      } else {
        // The new version already owns a value for this key: never roll the
        // user's newer edits back onto the exported snapshot.
        skippedExisting += 1;
      }
    }
    // Only when nothing was skipped can the imported revision stand; with
    // skips the local state is NOT the mirrored state, so start at the
    // mirrored revision anyway — the next write ships revision+1 and the
    // host's strictly-increasing rule keeps the export authoritative.
    writeRevision(Math.max(readRevision(), mirror.revision));
  } catch {
    // private mode / storage full: partial import stands, no revision
  }
  return { imported, skippedExisting, revision: mirror.revision };
}

// --- the write side (the static build's useStateMirror alias target) -------

let boundClient: IpcClient | null = null;
const DEBOUNCE_MS = 2_000;
const MIRROR_INTERVAL_MS = 30_000;

export function bindStateMirrorClient(client: IpcClient): void {
  boundClient = client;
}

/**
 * The IPC-backed mirror writer. Kept as a named export the static build's
 * hook alias points at; the Next app keeps its HTTP hook until M5.
 */
export function useStateMirror(): void {
  if (typeof window === "undefined") return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let lastChecksum: string | null = null;

  const flush = async (): Promise<void> => {
    if (flushing || boundClient === null) return;
    const entries = collectStateMirrorEntries(window.localStorage);
    if (entries === null) return;
    const payload = buildStateMirrorPayload(entries, readRevision() + 1);
    if (payload.checksum === lastChecksum) return;
    flushing = true;
    try {
      const ack = await boundClient.request<{ revision: number }>(
        "desktop.writeStateMirror",
        { payload },
        { timeoutMs: 10_000 },
      );
      writeRevision(ack.revision);
      lastChecksum = payload.checksum;
    } catch (error) {
      if (error instanceof IpcFailure && error.error.code === "invalid_args") {
        // The host is ahead (a stale-revision rejection, the 409 shape):
        // adopt the host's revision; the next flush ships ahead of it.
        try {
          const current = await boundClient.request<{ revision?: number }>(
            "desktop.stateMirror",
            undefined,
            { timeoutMs: 5_000 },
          );
          if (typeof current.revision === "number") writeRevision(current.revision);
          lastChecksum = null;
        } catch {
          // retry on the next tick
        }
      }
      // Anything else (host busy, bridge hiccup): the periodic tick retries.
    } finally {
      flushing = false;
    }
  };

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, DEBOUNCE_MS);
  };

  const initial = setTimeout(() => void flush(), 1_500);
  const interval = setInterval(() => void flush(), MIRROR_INTERVAL_MS);
  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea === window.localStorage) schedule();
  };
  const onPageHide = (): void => void flush();
  window.addEventListener("storage", onStorage);
  window.addEventListener("pagehide", onPageHide);
  // The hook stays mounted for the app's whole life (AppShell); the cleanup
  // this implies is deliberately not registered — see the React hook's
  // contract in the Next app (identical lifecycle).
  void initial;
}

export { stateMirrorChecksum };
