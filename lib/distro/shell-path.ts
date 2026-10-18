import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getGlobalSettingsPath, readGlobalSettings, updateGlobalSettings } from "../global-settings-file";
import { hasSystemGitBash } from "./runtime-env";
import { distroStatePath } from "./seed";
import { isRecord, readJsonObject, writeJsonObject } from "./json-file";

/**
 * Pin pi's `shellPath` setting to the bundled Git Bash.
 *
 * The bundle already puts `resources/git/bin` first on PATH
 * (configureDistroPath), but pi resolves PATH entries through
 * `where.exe`, which walks every PATH directory — it does not stop at the
 * first hit — so a single unreachable company network share in PATH can burn
 * its whole 5s spawnSync budget and pi reports "No bash shell found" with the
 * bundled bash sitting right there. `shellPath` in settings.json is pi's
 * top-priority resolution and a plain existsSync: no PATH, no `where`.
 *
 * Ownership is recorded in desktop-distro.json (`managedShellPath`) so a path
 * this app wrote is recognized across installs: when the app moves (or the
 * bundle stops shipping git) the pin is repointed or dropped, while a
 * shellPath the user chose themselves is never touched. Only written when the
 * machine has no Git for Windows of its own — pi checks Program Files before
 * everything else, so a system install needs no pin.
 */
export type ShellPathDecision =
  | { action: "pin" | "repoint"; path: string; managed: string }
  | { action: "remove"; managed: null }
  | { action: "keep"; managed: string | null };

export function planBundledShellPath(input: {
  platform?: string;
  /** settings.json's current `shellPath`; null when unset or not a string. */
  current: string | null;
  /** desktop-distro.json's `managedShellPath`; null when this app never wrote one. */
  managed: string | null;
  bundledBash: string;
  bundledBashExists: boolean;
  systemGitBash: boolean;
}): ShellPathDecision {
  const { current, managed, bundledBash, bundledBashExists, systemGitBash } = input;
  if ((input.platform ?? process.platform) !== "win32") return { action: "keep", managed };

  // A path the user chose (never written by us, not the current bundle) is theirs.
  if (current && current !== managed && current !== bundledBash) {
    return { action: "keep", managed };
  }

  // Already pinned at the current bundle path — claim it (so a later move
  // self-heals) but write nothing.
  if (current === bundledBash) return { action: "keep", managed: bundledBash };

  // Our pin on a stale path: the app was reinstalled elsewhere.
  if (current && current === managed) {
    if (bundledBashExists) return { action: "repoint", path: bundledBash, managed: bundledBash };
    return { action: "remove", managed: null };
  }

  // Unpinned: only the bundle can supply a shell, and only when the machine
  // has no Git for Windows of its own.
  if (!bundledBashExists || systemGitBash) return { action: "keep", managed };
  return { action: "pin", path: bundledBash, managed: bundledBash };
}

function readManagedShellPath(agentDir: string): string | null {
  const state = readJsonObject(distroStatePath(agentDir));
  if (!isRecord(state)) return null;
  const value = state.managedShellPath;
  return typeof value === "string" ? value : null;
}

function writeManagedShellPath(agentDir: string, managed: string | null): void {
  // An unparsable state file is rebuilt here: seedAgentDir overwrites it too,
  // and losing the marker only costs us a redundant pin decision.
  const state = readJsonObject(distroStatePath(agentDir)) ?? {};
  if (managed === null) delete state.managedShellPath;
  else state.managedShellPath = managed;
  writeJsonObject(distroStatePath(agentDir), state);
}

/** Apply the bundled-bash pin. Idempotent; never throws. */
export async function ensureBundledBashShellPath(
  resourcesDir: string,
  agentDir = getAgentDir(),
  options: { platform?: string; systemGitBash?: boolean } = {},
): Promise<void> {
  const bundledBash = join(resourcesDir, "git", "bin", "bash.exe");
  const managed = readManagedShellPath(agentDir);
  const current = await readGlobalSettings(getGlobalSettingsPath(agentDir), (settings) =>
    typeof settings.shellPath === "string" ? settings.shellPath : null,
  );
  const decision = planBundledShellPath({
    platform: options.platform,
    current,
    managed,
    bundledBash,
    bundledBashExists: existsSync(bundledBash),
    systemGitBash: options.systemGitBash ?? hasSystemGitBash(),
  });
  if (decision.action === "keep" && decision.managed === managed) return;

  try {
    if (decision.action === "pin" || decision.action === "repoint") {
      await updateGlobalSettings(getGlobalSettingsPath(agentDir), (settings) => {
        settings.shellPath = decision.path;
      });
      console.log(`[distro] shellPath ${decision.action === "pin" ? "pinned to" : "repointed at"} the bundled Git Bash (${decision.path})`);
    } else if (decision.action === "remove") {
      await updateGlobalSettings(getGlobalSettingsPath(agentDir), (settings) => {
        delete settings.shellPath;
      });
      console.log("[distro] removed the stale managed shellPath");
    }
    if (decision.managed !== managed) writeManagedShellPath(agentDir, decision.managed);
  } catch (error) {
    console.warn("[distro] could not manage shellPath for the bundled Git Bash:", error);
  }
}
