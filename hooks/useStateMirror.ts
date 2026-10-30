"use client";

/**
 * Client side of the transition-version state mirror (plan §七.1–3).
 *
 * Mount this once (AppShell). It mirrors the whitelisted WebView state:
 * - shortly after mount (the first snapshot),
 * - after changes (a debounce re-armed by the storage event and a tick),
 * - every MIRROR_INTERVAL as a safety net,
 * - as a best-effort keepalive flush on pagehide.
 *
 * The revision counter advances ONLY after the server ACKed a write
 * (plan: “使用确认过的 revision”), so a lost ACK keeps the client at the
 * last confirmed revision and the next write retries the same revision + 1
 * path — the server rejects going backwards, never rolling the mirror back.
 */

import { useCallback, useEffect, useRef } from "react";
import {
  STATE_MIRROR_REVISION_KEY,
  buildStateMirrorPayload,
  collectStateMirrorEntries,
} from "@/lib/state-mirror";

const DEBOUNCE_MS = 2_000;
const MIRROR_INTERVAL_MS = 30_000;

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

export function useStateMirror(): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushing = useRef(false);
  const lastChecksum = useRef<string | null>(null);

  const flush = useCallback(async (keepalive = false): Promise<void> => {
    if (flushing.current) return;
    if (typeof window === "undefined") return;
    const entries = collectStateMirrorEntries(window.localStorage);
    if (entries === null) return; // over budget: skip rather than truncate
    const payload = buildStateMirrorPayload(entries, readRevision() + 1);
    if (payload.checksum === lastChecksum.current && !keepalive) {
      // Nothing changed since the last accepted snapshot: hold the revision.
      return;
    }
    flushing.current = true;
    try {
      const response = await fetch("/api/state-mirror", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive,
      });
      if (response.ok) {
        const ack = await response.json().catch(() => null);
        if (ack && typeof ack.revision === "number") {
          writeRevision(ack.revision);
          lastChecksum.current = payload.checksum;
        }
      } else if (response.status === 409) {
        // The server is ahead (another tab won): adopt its revision.
        const current = await fetch("/api/state-mirror", { method: "GET" });
        if (current.ok) {
          const state = await current.json().catch(() => null);
          if (state && typeof state.revision === "number") writeRevision(state.revision);
          // The next periodic flush re-ships this tab's state ahead of it.
          lastChecksum.current = null;
        }
      }
    } catch {
      // Offline / server down: the periodic tick retries.
    } finally {
      flushing.current = false;
    }
  }, []);

  const schedule = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush();
    }, DEBOUNCE_MS);
  }, [flush]);

  useEffect(() => {
    // First snapshot soon after mount; then change/periodicity/pagehide.
    const initial = setTimeout(() => void flush(), 1_500);
    const interval = setInterval(() => void flush(), MIRROR_INTERVAL_MS);
    const onStorage = (event: StorageEvent): void => {
      if (event.storageArea === window.localStorage) schedule();
    };
    const onPageHide = (): void => {
      // Best effort only — the plan forbids relying on it alone, and the
      // debounced + periodic writes above are the primary paths.
      void flush(true);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      if (timer.current !== null) clearTimeout(timer.current);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [flush, schedule]);
}
