import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The security extensions this app reuses when they are installed:
 * `@gotgenes/pi-permission-system` (deterministic tool-call gating —
 * catastrophic-operation denial) and, optionally, `@erichll/pi-auto-review`
 * (its model-backed authorizer chain link, named `pi-auto-review` in the
 * permission system's `authorizerChain`).
 *
 * Normal sessions load both through the settings package list like any other
 * package. Child sessions load no ambient extensions by default, which would
 * leave their bash ungated and the authorizer chain unresolvable, so every
 * child creation path loads them explicitly:
 *
 * - Pi Web's built-in subagent controller (`lib/subagent-runtime.ts`) and the
 *   reopen path (`lib/rpc-manager.ts`) pass the package directories as
 *   `additionalExtensionPaths` — the resource loader loads those even under
 *   `noExtensions`, and only those;
 * - the pi-subagents package builds its children with its own loader, so the
 *   host registers the extension entry files through its
 *   `registerRequiredChildExtensions` API (`lib/required-child-extensions.ts`).
 *
 * Ordering note: the auto-review extension registers its `permissions:ready`
 * listener at factory load time, before any `session_start` handler runs, so
 * the registration is robust to load order and the packages array order does
 * not matter here.
 */

interface KnownPackage {
  /** Package name as it appears in npm specs and install paths. */
  name: string;
  /** npm-layout location pi installs the package at, relative to the agent dir. */
  npmLayoutSegments: readonly string[];
}

/** Security packages, in injection order: the gate first, then its reviewer. */
const SECURITY_PACKAGES: readonly KnownPackage[] = [
  {
    name: "@gotgenes/pi-permission-system",
    npmLayoutSegments: ["npm", "node_modules", "@gotgenes", "pi-permission-system"],
  },
  {
    name: "@erichll/pi-auto-review",
    npmLayoutSegments: ["npm", "node_modules", "@erichll", "pi-auto-review"],
  },
];

const PI_SUBAGENTS_PACKAGE: KnownPackage = {
  name: "pi-subagents",
  npmLayoutSegments: ["npm", "node_modules", "pi-subagents"],
};

/** The permission gate package; the reviewer never loads without it. */
export const PERMISSION_SYSTEM_PACKAGE = SECURITY_PACKAGES[0].name;

type PackageEntry = string | { source: string };

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Whether a settings `packages` entry refers to `pkg`: an `npm:` source (with
 * or without a version) or a local path pointing at an installed copy (the
 * `~/.pi/agent/npm` layout or a distro pi-seed copy both end in
 * `node_modules/<name>`). Local paths compare case-insensitively: Windows
 * paths are, and npm names are lowercase by convention.
 *
 * `git:` sources never match: none of these packages has a git distribution,
 * and a guessed install path could point at something else entirely.
 */
function entryMatches(source: string, pkg: KnownPackage): boolean {
  const trimmed = source.trim();
  if (trimmed.startsWith("npm:")) {
    const spec = trimmed.slice(4).trim();
    const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
    return (at > 0 ? spec.slice(0, at) : spec) === pkg.name;
  }
  if (trimmed.startsWith("git:")) return false;
  return normalizePath(trimmed).endsWith(`/${pkg.name.toLowerCase()}`);
}

/**
 * The installed directory of `pkg` from a global settings package list, or
 * `undefined`. Only existing directories with a package manifest count, so a
 * stale entry resolves to nothing and a user who removed the package gets
 * nothing re-added behind their back — the same respect
 * `lib/distro/packages.ts` pays removals.
 *
 * A per-entry resource filter (`{ source, extensions: [...] }`) is not
 * honoured: these are safety controls loaded as a whole, not payload the user
 * curates, so only the package's presence matters.
 */
function findInstalledPackageDir(
  packages: readonly PackageEntry[] | undefined,
  agentDir: string,
  pkg: KnownPackage,
): string | undefined {
  for (const entry of packages ?? []) {
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source !== "string" || !entryMatches(source, pkg)) continue;
    const dir = source.trim().startsWith("npm:")
      ? join(agentDir, ...pkg.npmLayoutSegments)
      : source.trim().replace(/[\\/]+$/, "");
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return undefined;
}

/**
 * Installed directories of every security package, gate first: the
 * permission gate plus the model reviewer when that package is installed.
 * Returns `[]` when the permission system itself is absent — the reviewer is
 * an authorizer inside it and never loads alone.
 *
 * Global scope only, deliberately: a project `.pi/settings.json` package
 * belongs to a trust-gated project, and injecting its code into subagent
 * sessions would bypass that gate. Callers pass
 * `settingsManager.getGlobalSettings().packages`.
 */
export function findSecurityExtensionPaths(
  packages: readonly PackageEntry[] | undefined,
  agentDir: string,
): string[] {
  const dirs = SECURITY_PACKAGES.map((pkg) => findInstalledPackageDir(packages, agentDir, pkg));
  if (!dirs[0]) return [];
  return dirs.filter((dir): dir is string => dir !== undefined);
}

/** The extension entry file a package's `pi` manifest declares first, if it exists. */
export function packageExtensionEntry(packageDir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      pi?: { extensions?: unknown };
    };
    const entries = manifest.pi?.extensions;
    const entry = Array.isArray(entries) ? entries[0] : undefined;
    if (typeof entry !== "string" || !entry.trim()) return undefined;
    const file = resolve(packageDir, entry);
    return existsSync(file) && statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The security packages as `{ id, path }` extension entry files, gate first —
 * the shape pi-subagents' `registerRequiredChildExtensions` takes (it accepts
 * importable files, not package directories). `[]` when the gate is absent or
 * any installed package declares no loadable entry: a partial set would load
 * the reviewer without its gate, or the gate without the chain link its
 * config names.
 */
export function findSecurityExtensionEntries(
  packages: readonly PackageEntry[] | undefined,
  agentDir: string,
): Array<{ id: string; path: string }> {
  const entries: Array<{ id: string; path: string }> = [];
  for (const pkg of SECURITY_PACKAGES) {
    const dir = findInstalledPackageDir(packages, agentDir, pkg);
    if (!dir) {
      if (pkg === SECURITY_PACKAGES[0]) return [];
      continue;
    }
    const path = packageExtensionEntry(dir);
    if (!path) return [];
    entries.push({ id: pkg.name.replace(/^@/, "").replace(/[^A-Za-z0-9._-]/g, "-"), path });
  }
  return entries;
}

/** The installed pi-subagents package directory, when the user has it in their packages. */
export function findPiSubagentsPackageDir(
  packages: readonly PackageEntry[] | undefined,
  agentDir: string,
): string | undefined {
  return findInstalledPackageDir(packages, agentDir, PI_SUBAGENTS_PACKAGE);
}
