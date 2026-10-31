import { lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendClearedSessionToolSelection } from "./session-tool-selection";
import { appendChatUnlock, readChatUnlocked } from "./chat-unlock";
import type { SessionEntry } from "./types";

/** Caller must validate the chat folder and exclude every live session writer. */
export function setOfflineChatUnlock(file: string, unlocked: boolean): boolean {
  const manager = SessionManager.open(file);
  if (readChatUnlocked(manager.getEntries() as unknown as SessionEntry[]) === unlocked) return false;
  appendChatUnlock(manager, unlocked);
  return true;
}

/** Caller must validate both paths and hold exclusive admission for the source. */
export function copyChatToProject(file: string, cwd: string): { sessionId: string; path: string | null } {
  const manager = SessionManager.forkFrom(file, cwd);
  const copiedFile = manager.getSessionFile();
  if (!copiedFile) throw new Error("The copied session has no file");
  // forkFrom creates its target with exclusive create. Never modify or clean
  // up a source alias, symlink, or a path outside the manager's target dir.
  const sourceStat = statSync(file);
  const targetStat = lstatSync(copiedFile);
  if (!targetStat.isFile() || (sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino)
      || realpathSync(file) === realpathSync(copiedFile)
      || realpathSync(dirname(copiedFile)) !== realpathSync(manager.getSessionDir())) {
    throw new Error("The copied session does not have a safe independent file");
  }
  try {
    appendClearedSessionToolSelection(manager);
    forgetChatSystemPrompt(copiedFile);
  } catch (error) {
    // Recheck identity before cleanup in case the target was replaced.
    try {
      const current = lstatSync(copiedFile);
      if (current.isFile() && current.dev === targetStat.dev && current.ino === targetStat.ino) {
        rmSync(copiedFile, { force: true });
      }
    } catch {
      // The failed copy is already gone or cannot safely be removed.
    }
    throw error;
  }
  return { sessionId: manager.getSessionId(), path: copiedFile };
}

/** Remove the chat's system messages from a copy, reconnecting their children. */
export function forgetChatSystemPrompt(file: string): void {
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  });
  if (entries.some((entry) => entry === null)) {
    throw new Error("This chat's transcript is damaged and cannot be continued in a project");
  }
  const parents = new Map<string, string | null>();
  const kept = (entries as Record<string, unknown>[]).filter((entry) => {
    const message = entry.message as { role?: string } | undefined;
    if (entry.type === "message" && message?.role === "system" && typeof entry.id === "string") {
      parents.set(entry.id, (entry.parentId as string | null | undefined) ?? null);
      return false;
    }
    return true;
  });
  const survivor = (id: string | null | undefined): string | null => {
    let current = id ?? null;
    while (current !== null && parents.has(current)) current = parents.get(current) ?? null;
    return current;
  };
  const rewritten = kept.map((entry) => (
    "parentId" in entry ? { ...entry, parentId: survivor(entry.parentId as string | null | undefined) } : entry
  ));
  writeFileSync(file, `${rewritten.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
