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

export interface ReconcileInput {
  entries: PackageEntry[];
  seed: Array<SeedPackage & { relativePath: string }>;
  previous: ManagedState | null;
}

export interface ReconcileResult {
  entries: PackageEntry[];
  managed: ManagedState;
  changed: boolean;
}
/**
 * For each seed package:
 * - an existing entry for the same package (npm/git source, an older bundle
 *   path, or a previous install location) is rewritten in place, keeping the
 *   user's per-package filters; duplicates are dropped;
 * - a package the user removed after we added it stays removed;
 * - otherwise the bundled path is appended.
 *
 * Entries we manage for packages that left the seed (dropped from the bundle)
 * are removed — after an app update the bundled copy no longer exists, and pi
 * would fail to load the dangling path. Their state entries are dropped too,
 * so re-bundling the package later re-adds it instead of remembering a removal
 * the user never made.
 */
export function reconcilePackages({ entries, seed, previous }: ReconcileInput): ReconcileResult {
  let result = [...entries];
  const managed: ManagedState = { packages: {} };

  for (const pkg of seed) {
    const key = packageKey(pkg.source);
    const previousPath = previous?.packages[pkg.source];
    const matches = (entry: PackageEntry) => {
      const source = entrySource(entry);
      if (source === pkg.path || source === pkg.source) return true;
      if (previousPath && normalizePath(source) === normalizePath(previousPath)) return true;
      if (isSeedCopy(source, pkg.relativePath)) return true;
      return key !== null && packageKey(source) === key;
    };

    const firstIndex = result.findIndex(matches);
    if (firstIndex === -1) {
      if (previousPath !== undefined) continue; // removed by the user — respect it
      result.push(pkg.path);
      managed.packages[pkg.source] = pkg.path;
      continue;
    }

    result = result.filter((entry, index) => index === firstIndex || !matches(entry));
    const index = result.findIndex(matches);
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
  return { entries: result, managed, changed };
}
