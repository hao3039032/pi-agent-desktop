/**
 * Where the server's update check gets its mirror list.
 *
 * One human-edited source: `distro/distro.json`'s `updateMirrors`. The desktop
 * shell bakes the same field into its native installer at release time, so the
 * two legs of an update can never drift apart.
 *
 * Resolution order:
 * 1. `PI_UPDATE_MIRRORS` — explicit operator override. A non-empty value
 *    replaces the file's list; an empty value disables mirroring entirely
 *    (an empty string is not the same as "unset").
 * 2. `distro/distro.json` next to the server root (the packaged app stages the
 *    file there) or under `distro/` (a source checkout).
 * 3. No mirrors — a missing or unreadable file degrades to direct-only rather
 *    than to a list nobody configured.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMirrorList } from "./update-mirrors";

/** Candidate locations of the distribution configuration, in read order. */
export function distroConfigCandidates(cwd: string = process.cwd()): string[] {
  return [join(cwd, "distro.json"), join(cwd, "distro", "distro.json")];
}

/** The `updateMirrors` list in the distribution config, or null when absent. */
export function readDistroMirrors(cwd: string = process.cwd()): string[] | null {
  for (const path of distroConfigCandidates(cwd)) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    try {
      const config = JSON.parse(raw) as { updateMirrors?: unknown };
      if (!Array.isArray(config.updateMirrors)) return null;
      return parseMirrorList(config.updateMirrors.filter((entry) => typeof entry === "string").join(","));
    } catch {
      // The file exists but cannot be used. Stop here instead of trying the
      // next path: a corrupt configuration must fail closed (direct-only), not
      // be replaced by whatever another candidate happens to contain.
      return null;
    }
  }
  return null;
}

/**
 * The mirrors this process may use, in try order. `PI_UPDATE_MIRRORS=""` means
 * "direct only" and is honoured, not treated as unset.
 */
export function resolveUpdateMirrors(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string[] {
  const override = env.PI_UPDATE_MIRRORS;
  if (override !== undefined) return parseMirrorList(override);
  return readDistroMirrors(cwd) ?? [];
}
