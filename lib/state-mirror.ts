/**
 * The transition-version state mirror (migration plan §七.1–3).
 *
 * The CURRENT (Next.js) app mirrors a whitelisted set of WebView
 * persistence to a host-owned file, so the future static-frontend version
 * can import it before React mounts. Rules frozen by the plan:
 *
 * - explicit whitelist only (APP_PREF_KEYS plus the independent upstream
 *   hooks' keys below) — never a blind dump of localStorage;
 * - NO OAuth tokens, NO cookies (neither lives in these keys; the whitelist
 *   would have to name them explicitly to export them);
 * - drafts keep exactly what is persisted today (`pi-chat-drafts-v1` —
 *   in-memory-only attachments were never in storage and are not invented
 *   here);
 * - the payload carries schemaVersion, a monotonically increasing revision
 *   (advanced only after the server ACKed the previous write), the source
 *   label and a checksum over the canonical entries;
 * - mirroring happens on real changes (debounced), periodically and as a
 *   best-effort keepalive flush on pagehide — never ONLY pagehide.
 */

import { APP_PREF_KEYS } from "./app-prefs";

/** Schema of the mirror payload; bump on breaking entry changes. */
export const STATE_MIRROR_SCHEMA_VERSION = 1;

/** localStorage key holding the client's last ACKed revision. */
export const STATE_MIRROR_REVISION_KEY = "pi-web:state-mirror-revision";

/**
 * Independent keys the upstream hooks own directly (not via app-prefs).
 * `pi-web:provider-usage:*` is a bounded family (one per provider id,
 * cleared from the same panel); the collector caps the family and skips a
 * full store rather than mirroring unbounded growth.
 */
export const STATE_MIRROR_EXTRA_KEYS = [
  "pi-web:settings-navigation",
  "pi-web:file-explorer:open",
  "pi-web:last-open-by-workspace",
  "pi-tool-preset",
  "pi-web:tab-open-session",
  "pi-thinking-expanded",
  "pi-enter-send-mode",
  "pi-chat-content-width",
  "pi-chat-content-font-size",
] as const;

export const STATE_MIRROR_PREFIX_FAMILIES = ["pi-web:provider-usage:"] as const;

/** Cap on entries mirrored from a prefix family (provider usage rows). */
export const STATE_MIRROR_FAMILY_CAP = 32;

/** Hard cap on one entry's value (4 MiB): drafts share the store budget. */
export const STATE_MIRROR_VALUE_CAP = 4 * 1024 * 1024;

/** Hard cap on the whole entries map, a sanity bound above the whitelist. */
export const STATE_MIRROR_TOTAL_CAP = 16 * 1024 * 1024;

export interface StateMirrorPayload {
  schemaVersion: number;
  revision: number;
  exportedAt: string;
  source: string;
  checksum: string;
  entries: Record<string, string>;
}

/** Minimal storage surface the collector needs (window.localStorage). */
export interface MirrorStorage {
  getItem(key: string): string | null;
}

export function stateMirrorWhitelist(): string[] {
  return [...Object.values(APP_PREF_KEYS), ...STATE_MIRROR_EXTRA_KEYS];
}

/**
 * Collect the mirrorable entries from a storage. Pure: no writes, no
 * network. Oversized values and an over-cap family are skipped (the rest of
 * the mirror still ships); a total overflow aborts with `null`.
 */
export function collectStateMirrorEntries(storage: MirrorStorage): Record<string, string> | null {
  const entries: Record<string, string> = {};
  let total = 0;
  for (const key of stateMirrorWhitelist()) {
    const value = storage.getItem(key);
    if (value === null) continue;
    if (value.length > STATE_MIRROR_VALUE_CAP) continue;
    total += key.length + value.length;
    entries[key] = value;
  }
  for (const prefix of STATE_MIRROR_PREFIX_FAMILIES) {
    let familyCount = 0;
    // Prefix families are enumerated through the injected index (tests pass
    // a stub); the browser path supplies localStorage.key(i).
    const index = (storage as { key?: (index: number) => string | null }).key?.bind(storage);
    if (!index) continue;
    for (let i = 0; ; i += 1) {
      const key = index(i);
      if (key === null) break;
      if (!key.startsWith(prefix)) continue;
      if (familyCount >= STATE_MIRROR_FAMILY_CAP) break;
      const value = storage.getItem(key);
      if (value === null) continue;
      if (value.length > STATE_MIRROR_VALUE_CAP) continue;
      familyCount += 1;
      total += key.length + value.length;
      entries[key] = value;
    }
  }
  if (total > STATE_MIRROR_TOTAL_CAP) return null;
  return entries;
}

/** FNV-1a 64-bit (as two 32-bit halves) over the canonical entries JSON. */
export function stateMirrorChecksum(entries: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.keys(entries)
      .sort()
      .map((key) => [key, entries[key]]),
  );
  // A stable, dependency-free digest: two FNV-1a 32-bit lanes with different
  // offsets. Not cryptographic — it guards against truncation/corruption of
  // the mirror file, which is its only job (the file is host-local).
  let hashA = 0x811c9dc5;
  let hashB = 0x01000193;
  for (let i = 0; i < canonical.length; i += 1) {
    const code = canonical.charCodeAt(i);
    hashA ^= code;
    hashA = Math.imul(hashA, 0x01000193) >>> 0;
    hashB ^= (code + i) & 0xffff;
    hashB = Math.imul(hashB, 0x85ebca6b) >>> 0;
  }
  return `fnv1a64-${hashA.toString(16).padStart(8, "0")}${hashB.toString(16).padStart(8, "0")}`;
}

/** Build a payload from collected entries at a given revision. */
export function buildStateMirrorPayload(
  entries: Record<string, string>,
  revision: number,
): StateMirrorPayload {
  return {
    schemaVersion: STATE_MIRROR_SCHEMA_VERSION,
    revision,
    exportedAt: new Date().toISOString(),
    source: "pi-agent-desktop-webview-localStorage",
    checksum: stateMirrorChecksum(entries),
    entries,
  };
}

/** Verify a payload's internal consistency (the importer's first gate). */
export function verifyStateMirrorPayload(payload: unknown): payload is StateMirrorPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const candidate = payload as Partial<StateMirrorPayload>;
  if (candidate.schemaVersion !== STATE_MIRROR_SCHEMA_VERSION) return false;
  if (!Number.isInteger(candidate.revision) || (candidate.revision as number) < 0) return false;
  if (typeof candidate.exportedAt !== "string" || !candidate.exportedAt) return false;
  if (typeof candidate.source !== "string" || !candidate.source) return false;
  if (typeof candidate.checksum !== "string" || !candidate.checksum) return false;
  if (typeof candidate.entries !== "object" || candidate.entries === null) return false;
  for (const value of Object.values(candidate.entries as Record<string, unknown>)) {
    if (typeof value !== "string") return false;
  }
  return (
    candidate.checksum === stateMirrorChecksum(candidate.entries as Record<string, string>)
  );
}
