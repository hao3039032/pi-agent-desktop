import { compare, valid } from "semver";
import { applyDeepSeekMigration } from "./deepseek-migration";
import { applyExaFallbackMigration } from "./exa-fallback";
import { applySessionAffinityMigration } from "./session-affinity-migration";
import { applyOpenAICompletionsMigration } from "./openai-completions-migration";
import { applyExaDefaultMigration } from "./exa-default-migration";
import { applyYoloToggleMigration } from "./yolo-toggle-migration";

export interface ReleaseMigrationContext {
  /** Paths actually created by this seed run's write-when-missing agentFiles pass. */
  newlySeededFiles?: ReadonlySet<string>;
}

export interface ReleaseMigration {
  /** Immutable release version: append a new entry, never repurpose a shipped one. */
  version: string;
  run: (agentDir: string, context: ReleaseMigrationContext) => void;
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
  {
    version: "0.8.215",
    run(agentDir) {
      const report = applyExaFallbackMigration(agentDir);
      // A kept pair is the user's own connection, not a failure: the receipt
      // is still recorded so this never re-runs against their choice.
      if (report.written.length) console.log(`[distro] Exa fallback: pre-filled ${report.written.join(", ")}`);
      if (report.kept.length) console.log(`[distro] Exa fallback: ${report.kept.join("; ")}`);
    },
  },
  {
    version: "0.8.402",
    run(agentDir) {
      const report = applySessionAffinityMigration(agentDir);
      // A kept key is the user's explicit setting, not a failure: the receipt
      // is still recorded so this never re-runs against their choice.
      if (report.written.length) console.log(`[distro] session affinity: filled ${report.written.join(", ")}`);
      if (report.kept.length) console.log(`[distro] session affinity: ${report.kept.join("; ")}`);
    },
  },
  {
    version: "0.8.502",
    run(agentDir) {
      const report = applyOpenAICompletionsMigration(agentDir);
      if (report.written.length) console.log(`[distro] OpenAI default protocol: updated ${report.written.join(", ")}`);
    },
  },
  {
    version: "0.8.503",
    run(agentDir) {
      const report = applyExaDefaultMigration(agentDir);
      if (report.written.length) console.log(`[distro] Exa default search: updated ${report.written.join(", ")}`);
      if (report.kept.length) console.log(`[distro] Exa default search: ${report.kept.join("; ")}`);
    },
  },
  {
    version: "0.8.704",
    run(agentDir, context) {
      const report = applyYoloToggleMigration(agentDir, context);
      if (report.written.length) console.log(`[distro] YOLO toggle: wrote ${report.written.join(", ")}`);
      if (report.kept.length) console.log(`[distro] YOLO toggle: ${report.kept.join("; ")}`);
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
  context: ReleaseMigrationContext = {},
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
      entry.run(agentDir, context);
      next[entry.version] = true;
    } catch (error) {
      console.warn(`[distro] release migration ${entry.version} failed; will retry at next startup:`, error);
      break;
    }
  }
  return next;
}
