/**
 * Server side of the transition-version state mirror: one JSON file under
 * the pi agent dir (`~/.pi/agent/desktop-state-mirror.json`), written with
 * the same atomic replace + private-permission discipline as the other
 * host-owned state files. The NEXT app (static frontend) imports this file
 * before React mounts; this version only ever writes it.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { userHome } from "./user-home";
import { type StateMirrorPayload, verifyStateMirrorPayload } from "./state-mirror";

export function stateMirrorPath(agentDir?: string): string {
  return `${agentDir ?? userHome()}/.pi/agent/desktop-state-mirror.json`;
}

export interface ReadResult {
  ok: boolean;
  payload?: StateMirrorPayload;
  reason?: "missing" | "corrupt";
}

export function readStateMirror(agentDir?: string): ReadResult {
  const file = stateMirrorPath(agentDir);
  if (!existsSync(file)) return { ok: false, reason: "missing" };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!verifyStateMirrorPayload(parsed)) return { ok: false, reason: "corrupt" };
    return { ok: true, payload: parsed };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

export type WriteResult =
  | { ok: true; revision: number; bytes: number }
  | { ok: false; reason: "invalid" | "stale" | "io"; error?: string };

/**
 * Persist one mirror payload. Revisions must strictly increase (the client
 * advances its counter only after an ACK, so a stale retry is rejected
 * rather than rolling the mirror back). Write is atomic (tmp + rename) and
 * keeps the file private (0600) — it contains the user's drafts.
 */
export function writeStateMirror(payload: unknown, agentDir?: string): WriteResult {
  if (!verifyStateMirrorPayload(payload)) return { ok: false, reason: "invalid" };
  const incoming = payload as StateMirrorPayload;
  const existing = readStateMirror(agentDir);
  if (existing.ok && incoming.revision <= existing.payload!.revision) {
    return { ok: false, reason: "stale" };
  }
  const file = stateMirrorPath(agentDir);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const serialized = JSON.stringify(incoming, null, 2) + "\n";
    writeFileSync(tmp, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    // Some filesystems honor mode only on create: re-assert it if it drifted.
    try {
      if ((statSync(file).mode & 0o777) !== 0o600) {
        chmodSync(file, 0o600);
      }
    } catch {
      // Windows: no POSIX modes; the user-profile ACL already restricts it.
    }
    return { ok: true, revision: incoming.revision, bytes: serialized.length };
  } catch (error) {
    return { ok: false, reason: "io", error: String(error) };
  }
}

