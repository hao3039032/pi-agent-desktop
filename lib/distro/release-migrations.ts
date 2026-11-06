import { compare, valid } from "semver";
import { applyDeepSeekMigration } from "./deepseek-migration";

export interface ReleaseMigration {
  /** Immutable release version: append a new entry, never repurpose a shipped one. */
  version: string;
  run: (agentDir: string) => void;
}

/** Only migrations included in this release are listed here. Keep old entries:
 * users may skip any number of releases. Releases with no migration need no entry.
 */
export const RELEASE_MIGRATIONS: readonly ReleaseMigration[] = [
  {
    version: "0.8.210",
    run(agentDir) {
      const report = applyDeepSeekMigration(agentDir);
      if (report.written.length) console.log(`[distro] DeepSeek roles: updated ${report.written.join(", ")}`);
      if (report.kept.length) throw new Error(`Unmigrated configuration: ${report.kept.join("; ")}`);
    },
  },
];

/** Each release has an independent completion receipt, not a highest-version
 * watermark. Retries are safe because migration operations must be idempotent.
 * Stop at the first failure so later migrations never run against missing prerequisites.
 */
export function runReleaseMigrations(
  agentDir: string,
  completed: Record<string, boolean> = {},
  entries: readonly ReleaseMigration[] = RELEASE_MIGRATIONS,
): Record<string, boolean> {
  const next = { ...completed };
  const versions = new Set<string>();
  for (const entry of entries) {
    if (!valid(entry.version) || versions.has(entry.version)) throw new Error(`Invalid/duplicate migration release: ${entry.version}`);
    versions.add(entry.version);
  }
  for (const entry of [...entries].sort((a, b) => compare(a.version, b.version))) {
    if (next[entry.version] === true) continue;
    try {
      entry.run(agentDir);
      next[entry.version] = true;
    } catch (error) {
      console.warn(`[distro] release migration ${entry.version} failed; will retry at next startup:`, error);
      break;
    }
  }
  return next;
}
