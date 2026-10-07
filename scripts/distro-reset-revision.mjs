#!/usr/bin/env node
/**
 * Fork: reset the distro revision when an upstream merge changes the version.
 *
 *   node scripts/distro-reset-revision.mjs [base-ref]
 *
 * distro/distro.json's `revision` counts distro rebuilds *per upstream
 * version* (upstream X.Y.Z + revision R → X.Y.(Z*100+R), see
 * scripts/distro-build-config.mjs). distro-sync.yml runs this right after
 * merging an upstream release: when the upstream version carried by
 * src-tauri/pi-agent-desktop-package.json differs from base-ref's (default
 * HEAD^1, the pre-merge main), the revision resets to 1, so the first distro
 * release on a new base starts at X.Y.(Z*100+1) — 0.4.805 → 0.5.201, not
 * 0.5.209.
 *
 * Prints "reset" when distro/distro.json was rewritten, "unchanged"
 * otherwise; the caller folds the change into the merge commit. Also usable
 * after a manual `git merge <upstream-tag>` (see docs/distro.md).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

export function upstreamVersionOf(pkg) {
  const version = pkg.upstreamVersion ?? pkg.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Unexpected upstream version: ${JSON.stringify(version)}`);
  }
  return version;
}

/**
 * An unchanged upstream version (or an already-reset counter) leaves the
 * distro untouched; a changed version restarts the counter at 1.
 */
export function resetRevision(distro, previousVersion, currentVersion) {
  if (previousVersion === currentVersion || distro.revision === 1) {
    return { distro, reset: false };
  }
  return { distro: { ...distro, revision: 1 }, reset: true };
}

function readPackageAt(ref) {
  try {
    return JSON.parse(
      execFileSync("git", ["show", `${ref}:src-tauri/pi-agent-desktop-package.json`], {
        cwd: rootDir,
        encoding: "utf8",
        stderr: "pipe",
      }),
    );
  } catch (error) {
    throw new Error(
      `Cannot read src-tauri/pi-agent-desktop-package.json at ${ref}: ${error.message}. ` +
        "Run this right after a merge (HEAD^1 is the pre-merge main), or pass the pre-merge ref as an argument.",
    );
  }
}

function main() {
  const baseRef = process.argv[2] ?? "HEAD^1";
  const previous = upstreamVersionOf(readPackageAt(baseRef));
  const current = upstreamVersionOf(
    JSON.parse(readFileSync(join(rootDir, "src-tauri", "pi-agent-desktop-package.json"), "utf8")),
  );
  const distroPath = join(rootDir, "distro", "distro.json");
  const distro = JSON.parse(readFileSync(distroPath, "utf8"));
  const { distro: next, reset } = resetRevision(distro, previous, current);
  if (reset) {
    writeFileSync(distroPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  console.log(reset ? "reset" : "unchanged");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
