/**
 * Pure helpers that rewrite the user's `packages` list so the distro's
 * packages point at the copies pre-installed in the app bundle. Kept free of
 * I/O for tests (lib/distro/packages.test.mjs).
 */

export type PackageEntry = string | { source: string; [key: string]: unknown };

export interface SeedPackage {
  /** Source as written in distro.json, e.g. `npm:pi-subagents`, `git:github.com/o/r`. */
  source: string;
  /** Absolute path of the pre-installed copy inside the app bundle. */
  path: string;
}

export interface ManagedState {
  /** distro source → absolute path last written for it. */
  packages: Record<string, string>;
}

/** A distro package the bundle no longer ships, with the pi-seed-relative
 * install path every earlier revision placed it at (`seedRelativePath` in
 * scripts/distro-seed.mjs). */
export interface RetiredSeedPackage {
  /** The distro source the bundle used to ship. */
  source: string;
  /** Path relative to `pi-seed/` where old bundles installed it. */
  relativePath: string;
}

/**
 * Packages the bundle retired in distro revision 16. Machines that upgraded
 * may still carry registrations pointing at a bundled copy; those entries are
 * pruned by path identity alone in `reconcilePackages`, so a lost or corrupt
 * state file and a moved install directory are covered too. Nothing is ever
 * deleted from disk, and an install the user made themselves — an npm:/git:
 * source, a versioned spec, or their own local path — is never touched.
 *
 * - `pi-plan-vanguard`: the extension-based Plan mode (its `/plan` command,
 *   tool policy and settings UI), replaced by the `npm:@codella/pi-prompt-plan`
 *   prompt template. A user's own copy keeps working; while it is installed
 *   its extension command shadows the template, so the template is not seeded
 *   either (`PROMPT_TEMPLATE_SHADOWS`).
 * - `@anthropic-ai/sandbox-runtime`: the sandbox runtime that extension
 *   launched. Only ever a bundled dependency, never a Pi package — removing
 *   leftover registrations is the same fix v0.8.205 applied to v0.8.203/204.
 */
export const RETIRED_SEED_PACKAGES: ReadonlyArray<RetiredSeedPackage> = [
  {
    source: "git:github.com/hao3039032/pi-plan-vanguard",
    relativePath: "git/github.com/hao3039032/pi-plan-vanguard",
  },
  {
    source: "npm:@anthropic-ai/sandbox-runtime",
    relativePath: "npm/node_modules/@anthropic-ai/sandbox-runtime",
  },
];

/**
 * Prompt-template packages (keyed by `packageKey`) whose command a still
 * installed extension package would shadow: pi dispatches extension commands
 * before it expands prompt templates, so seeding the template next to the old
 * extension would leave a `/command` that never reaches the template. The
 * template is appended only once the shadowing package is gone; the shadow is
 * matched on package identity (any source form of the same repository), never
 * on tool or command names. An independent local checkout of the old
 * extension cannot be recognized without executing untrusted code — that
 * limitation is documented in docs/distro.md and left to the user.
 */
export const PROMPT_TEMPLATE_SHADOWS: Readonly<Record<string, string>> = {
  "npm:@codella/pi-prompt-plan": "git:github.com/hao3039032/pi-plan-vanguard",
};

export function entrySource(entry: PackageEntry): string {
  return typeof entry === "string" ? entry : entry.source;
}

function withSource(entry: PackageEntry, source: string): PackageEntry {
  return typeof entry === "string" ? source : { ...entry, source };
}

/** Identity of a package independent of version/ref/protocol, or null for local paths. */
export function packageKey(source: string): string | null {
  const trimmed = source.trim();
  if (trimmed.startsWith("npm:")) {
    const spec = trimmed.slice(4).trim();
    const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
    return `npm:${(at > 0 ? spec.slice(0, at) : spec).toLowerCase()}`;
  }
  const git = /^(?:git:|git\+)?(?:https?:\/\/|ssh:\/\/git@|git@)?([^/:\s]+\.[^/:\s]+)[/:]([^/\s]+)\/([^/@#\s]+?)(?:\.git)?(?:[@#].*)?$/i.exec(trimmed);
  if (git && (trimmed.startsWith("git:") || /^(?:https?|ssh):/i.test(trimmed) || trimmed.startsWith("git@"))) {
    return `git:${git[1]}/${git[2]}/${git[3]}`.toLowerCase();
  }
  return null;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when a local-path entry points at *some* install's copy of this seed package. */
function isSeedCopy(source: string, relativeSeedPath: string): boolean {
  return normalizePath(source).endsWith(`/pi-seed/${normalizePath(relativeSeedPath)}`);
}

/**
 * True when an entry is a registration this seeder itself wrote for `pkg`:
 * the current bundle path, a path our state recorded for it (also across a
 * moved install), or any install's copy at the exact pi-seed-relative path.
 * String and object entries, duplicates and Windows separators included.
 */
function isBundleRegistration(
  entry: PackageEntry,
  pkg: { path?: string; relativePath: string },
  previousPath: string | undefined,
): boolean {
  const source = entrySource(entry);
  if (pkg.path !== undefined && normalizePath(source) === normalizePath(pkg.path)) return true;
  if (previousPath !== undefined && normalizePath(source) === normalizePath(previousPath)) return true;
  return isSeedCopy(source, pkg.relativePath);
}

export interface ReconcileInput {
  entries: PackageEntry[];
  seed: Array<SeedPackage & { relativePath: string }>;
  /** Install-only dependencies; old bundled registrations must be removed. */
  runtimePackages?: Array<SeedPackage & { relativePath: string }>;
  previous: ManagedState | null;
}

export interface ReconcileResult {
  entries: PackageEntry[];
  managed: ManagedState;
  changed: boolean;
  /** Seed packages not appended because an installed package's command would
   * shadow their prompt template (`PROMPT_TEMPLATE_SHADOWS`). The caller
   * reports these; seeding resumes once the shadowing package is gone. */
  shadowed: Array<{ source: string; shadow: string }>;
}
/**
 * For each seed package:
 * - an entry we previously wrote (this bundle's path, a prior install's
 *   path recorded in our state, or any install's seed copy) is rewritten in
 *   place to the current bundle path, keeping the user's per-package
 *   filters; duplicates are dropped;
 * - a package the user removed after we added it stays removed;
 * - a package the user installed themselves in any other form (npm:/git:
 *   source, versioned spec, or their own local path) is left untouched —
 *   their install wins and no duplicate is appended;
 * - otherwise the bundled path is appended (fresh machine, no entry at all).
 *
 * Entries we manage for packages that left the seed (dropped from the bundle)
 * are removed — after an app update the bundled copy no longer exists, and pi
 * would fail to load the dangling path. Their state entries are dropped too,
 * so re-bundling the package later re-adds it instead of remembering a removal
 * the user never made.
 */
export function reconcilePackages({ entries, seed, runtimePackages = [], previous }: ReconcileInput): ReconcileResult {
  // v0.8.203/204 registered sandbox-runtime as a Pi package; Pi tried to load
  // the bundled dependency as an extension and exited 1. Revision 16 retired
  // the package from the bundle along with pi-plan-vanguard, so both cleanups
  // now run here as one pass over the packages the seeder owns: only
  // bundle-owned registrations are removed (also after a move or with the
  // state file lost), never the user's npm sources or independent copies.
  const unmanaged = [...runtimePackages, ...RETIRED_SEED_PACKAGES];
  let result = entries.filter((entry) => !unmanaged.some((pkg) =>
    isBundleRegistration(entry, pkg, previous?.packages[pkg.source]),
  ));
  const managed: ManagedState = { packages: {} };
  const shadowed: Array<{ source: string; shadow: string }> = [];

  for (const pkg of seed) {
    const key = packageKey(pkg.source);
    const previousPath = previous?.packages[pkg.source];
    // Ownership: only entries the seeder itself wrote are managed. Canonical
    // npm:/git: sources the user wrote are never adopted — silently pointing
    // the user's config at bundle-local copies forks their install and breaks
    // when the bundle moves or is deleted (e.g. dev trees cleaned mid-release).
    const owned = (entry: PackageEntry) => {
      const source = entrySource(entry);
      if (source === pkg.path) return true;
      if (previousPath && normalizePath(source) === normalizePath(previousPath)) return true;
      return isSeedCopy(source, pkg.relativePath);
    };
    // Presence in any form (versioned npm spec, git URL variant, or an
    // unrelated local checkout) means the user already has this package, so
    // seeding must not append a second copy next to theirs.
    const present = (entry: PackageEntry) => {
      const entryKey = key !== null ? packageKey(entrySource(entry)) : null;
      return entryKey !== null && entryKey === key;
    };

    const firstIndex = result.findIndex(owned);
    if (firstIndex === -1) {
      if (previousPath !== undefined) continue; // removed by the user — respect it
      if (result.some(present)) continue;       // installed by the user — respect it
      // A prompt template whose command the old extension still shadows waits
      // for the user to remove it (pi runs extension commands first); nothing
      // is appended twice and nothing of the user's is removed for them.
      const shadowKey = key !== null ? PROMPT_TEMPLATE_SHADOWS[key] : undefined;
      if (shadowKey !== undefined && result.some((entry) => packageKey(entrySource(entry)) === shadowKey)) {
        shadowed.push({ source: pkg.source, shadow: shadowKey });
        continue;
      }
      result.push(pkg.path);
      managed.packages[pkg.source] = pkg.path;
      continue;
    }

    result = result.filter((entry, index) => index === firstIndex || !owned(entry));
    const index = result.findIndex(owned);
    result[index] = withSource(result[index], pkg.path);
    managed.packages[pkg.source] = pkg.path;
  }

  // Keep "removed by the user" memory for packages we skipped above.
  for (const [source, path] of Object.entries(previous?.packages ?? {})) {
    if (!(source in managed.packages) && seed.some((pkg) => pkg.source === source)) {
      managed.packages[source] = path;
    }
  }

  // Prune packages that left the seed: drop entries pointing at the bundled
  // copy of a source the current bundle no longer ships.
  for (const [source, path] of Object.entries(previous?.packages ?? {})) {
    if (seed.some((pkg) => pkg.source === source)) continue;
    const seedCopy = (entry: PackageEntry) => normalizePath(entrySource(entry)) === normalizePath(path);
    if (result.some(seedCopy)) result = result.filter((entry) => !seedCopy(entry));
  }

  const changed = JSON.stringify(result) !== JSON.stringify(entries);
  return { entries: result, managed, changed, shadowed };
}
