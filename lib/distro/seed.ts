import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DISTRO, distroProviderBaseUrl, distroServiceBaseUrl, imageGenBaseUrl, mergeDistroModels, mergeDistroProviderCompat, rebaseDistroModelUrls } from "./config";
import { fileExists, isRecord, readJsonObject, writeJsonObject } from "./json-file";
import { entrySource, findManagedEntry, reconcilePackages, type ManagedState, type PackageEntry } from "./packages";
import { readModelsConfig, writeModelsConfig } from "../models-config-store";
import { defaultToolEntries, getGlobalSettingsPath, updateGlobalSettings } from "../global-settings-file";
import { runMcpAdapterMigration } from "./mcp-migration";
import { applyLazyToolActivation } from "./lazy-tool-activation";
import { runReleaseMigrations } from "./release-migrations";

export interface SeedManifest {
  distro: string;
  revision: number;
  /** Changes whenever the bundled package set or any of their versions changes. */
  seedVersion: string;
  packages: Array<{ source: string; path: string; version?: string }>;
  /** Installed next to extensions, but never registered in settings.packages. */
  runtimePackages?: Array<{ source: string; path: string; version?: string }>;
}

interface DistroState extends ManagedState {
  distro: string;
  seedVersion?: string;
  defaultsApplied?: boolean;
  /** One-time migrations that already ran (name → true). */
  migrations?: Record<string, boolean>;
  /** One completion receipt per distribution release, independent of seed hashes. */
  releaseMigrations?: Record<string, boolean>;
  /** The shellPath this app pinned to the bundled Git Bash (shell-path.ts). */
  managedShellPath?: string;
  /**
   * The toggle registration a run had to take out of `settings.json` for the
   * 0.8.704 migration, with the user's whole entry. Written before that
   * removal is flushed and cleared once the entry is registered again, so a
   * crash or a later write failure cannot make the next start read the missing
   * entry as a user removal.
   */
  pendingYoloToggle?: PendingYoloToggle;
}

/** distro.json source of the bundled YOLO toggle (PACKAGE_SOURCE_CONFLICTS). */
const YOLO_TOGGLE_SOURCE = "git:github.com/hao3039032/pi-permission-yolo-toggle";

interface PendingYoloToggle {
  /** The user's entry as it was, filters and unknown fields included. */
  entry: PackageEntry;
  /** Its position in `settings.packages` when it was removed. */
  index: number;
  /** The bundled path the seeder had recorded for it, if any. */
  managedPath?: string;
}

/** Put back a registration the previous run had to remove, unless the entry is
 * already there (a flush that never happened, or a user re-add). */
function withRestoredToggle(entries: PackageEntry[], pending: PendingYoloToggle): PackageEntry[] {
  if (entries.some((entry) => entrySource(entry) === entrySource(pending.entry))) return entries;
  const restored = [...entries];
  restored.splice(Math.min(pending.index, restored.length), 0, pending.entry);
  return restored;
}

/** Persist the recovery record before the toggle leaves settings.json. Every
 * field the rest of this file manages is carried over, so a crash right after
 * this write loses nothing else. */
function writePendingToggle(agentDir: string, previous: DistroState | null, pending: PendingYoloToggle): void {
  writeJsonObject(distroStatePath(agentDir), {
    distro: DISTRO.id,
    ...(previous?.seedVersion ? { seedVersion: previous.seedVersion } : {}),
    ...(previous?.defaultsApplied ? { defaultsApplied: previous.defaultsApplied } : {}),
    packages: { ...(previous?.packages ?? {}) },
    ...(previous?.migrations ? { migrations: previous.migrations } : {}),
    ...(previous?.releaseMigrations ? { releaseMigrations: previous.releaseMigrations } : {}),
    ...(previous?.managedShellPath ? { managedShellPath: previous.managedShellPath } : {}),
    pendingYoloToggle: pending,
  });
}

export function distroStatePath(agentDir = getAgentDir()): string {
  return join(agentDir, "desktop-distro.json");
}

export function readSeedManifest(resourcesDir: string): SeedManifest | null {
  const manifest = readJsonObject(join(resourcesDir, "pi-seed", "manifest.json"));
  if (!manifest || !Array.isArray(manifest.packages)) return null;
  return manifest as unknown as SeedManifest;
}

function readState(agentDir: string): DistroState | null {
  const state = readJsonObject(distroStatePath(agentDir));
  if (!state || state.distro !== DISTRO.id || !isRecord(state.packages)) return null;
  return state as unknown as DistroState;
}

/**
 * Keep the distro provider's model list in step with the bundled distro.json
 * after an app update. Only the model catalog and protocol are managed; the
 * user's service address and apiKey are preserved (the provider's OpenAI
 * baseUrl carries `/v1`). The provider compat defaults (session
 * affinity) are re-filled where absent, with the same only-if-missing merge
 * as the service form and release migration 0.8.402.
 */
function refreshProviderModels(): void {
  try {
    const config = readModelsConfig();
    const providers = isRecord(config.providers) ? config.providers : {};
    const existing = providers[DISTRO.provider.id];
    if (!isRecord(existing)) return;
    const storedBaseUrl = typeof existing.baseUrl === "string" ? existing.baseUrl : DISTRO.defaultBaseUrl;
    const serviceBaseUrl = distroServiceBaseUrl(storedBaseUrl);
    const models = mergeDistroModels(
      existing.models,
      rebaseDistroModelUrls(DISTRO.provider.models, serviceBaseUrl),
    );
    const compat = mergeDistroProviderCompat(existing.compat);
    writeModelsConfig({
      ...config,
      providers: {
        ...providers,
        [DISTRO.provider.id]: {
          ...existing,
          name: DISTRO.provider.name,
          baseUrl: distroProviderBaseUrl(serviceBaseUrl),
          api: DISTRO.provider.api,
          ...(compat ? { compat } : {}),
          models,
        },
      },
    });
  } catch (error) {
    console.warn("[distro] could not refresh provider models:", error);
  }
}

/**
 * pi-model-images 0.2 replaced the registered imagegen tool with a CLI
 * reading its own config file. Create it from the configured service so
 * image generation works right after the upgrade, for users who never
 * reopen the service form. Missing file only — a hand-created or hand-edited
 * config is never overwritten (the service form keeps one that exists in
 * step with later address changes). Same write-when-missing semantics as
 * agentFiles above.
 */
function ensureImageGenConfig(agentDir: string): void {
  const configFile = DISTRO.imageGen?.configFile;
  if (!configFile) return;
  const path = join(agentDir, configFile);
  if (fileExists(path)) return;
  try {
    const config = readModelsConfig();
    const providers = isRecord(config.providers) ? config.providers : {};
    const provider = providers[DISTRO.provider.id];
    if (!isRecord(provider)) return;
    const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
    const apiKey = typeof provider.apiKey === "string" ? provider.apiKey : "";
    if (!baseUrl || !apiKey) return;
    writeJsonObject(path, { baseUrl: imageGenBaseUrl(baseUrl), apiKey });
  } catch (error) {
    console.warn("[distro] could not seed the imagegen config:", error);
  }
}

/**
 * Point the user's pi configuration at the packages pre-installed in the app
 * bundle, and apply first-run defaults. Idempotent; cheap when nothing changed.
 */
export async function seedAgentDir(resourcesDir: string, agentDir = getAgentDir()): Promise<void> {
  const manifest = readSeedManifest(resourcesDir);
  if (!manifest) return;

  const previous = readState(agentDir);
  const firstRun = !previous?.defaultsApplied;
  const versionChanged = previous?.seedVersion !== manifest.seedVersion;

  const settingsManager = SettingsManager.create(agentDir, agentDir);
  const bundledPackage = (pkg: SeedManifest["packages"][number]) => ({
    source: pkg.source,
    relativePath: pkg.path,
    path: join(resourcesDir, "pi-seed", ...pkg.path.split("/")),
  });
  const seed = manifest.packages.map(bundledPackage);
  const runtimePackages = (manifest.runtimePackages ?? []).map(bundledPackage);
  const storedPackages = (settingsManager.getGlobalSettings().packages ?? []) as PackageEntry[];
  // The 0.8.704 migration validates the toggle before it may load: an invalid
  // config must not fall back to the fork's defaultEnabled:true. Until that
  // release has a receipt the bundled toggle stays out of the settings flush
  // (`runtimePackages` is pruned). Once it does, nothing is removed or
  // re-added any more — the entry is only re-pointed at the current bundle
  // path, filters intact.
  const yoloToggle = seed.find((pkg) => pkg.source === YOLO_TOGGLE_SOURCE);
  // A previous run recorded the user's entry before it took it out for that
  // migration; put it back before any ownership decision is made.
  const pendingToggle = yoloToggle ? previous?.pendingYoloToggle : undefined;
  const current = pendingToggle
    ? withRestoredToggle(storedPackages, pendingToggle)
    : storedPackages;
  const packagesPrevious: ManagedState = { packages: { ...(previous?.packages ?? {}) } };
  if (pendingToggle?.managedPath) packagesPrevious.packages[YOLO_TOGGLE_SOURCE] = pendingToggle.managedPath;
  const toggleAwaitingMigration = yoloToggle !== undefined
    && previous?.releaseMigrations?.["0.8.704"] !== true;
  const before = toggleAwaitingMigration
    ? reconcilePackages({ entries: current, seed, runtimePackages, previous: packagesPrevious })
    : null;
  const yoloToggleWasRegistered = before?.entries.some((entry) => entrySource(entry) === yoloToggle?.path) === true;
  // A genuine pre-existing user removal, but not the temporary removal below
  // or conflict cleanup for a user's pikujs original: both are remembered by
  // the state and must not be read as an uninstall.
  const yoloToggleRemovalMemory = before && !yoloToggleWasRegistered
    ? before.managed.packages[YOLO_TOGGLE_SOURCE]
    : undefined;

  // Record the user's whole entry (filters and unknown fields included) before
  // the flush that takes it out of settings.json. A crash, a failed later
  // write or a lost final state write then cannot turn it into a user removal.
  // Nothing is written when this record cannot be saved: the write throws
  // before the flush, so the entry stays registered for this run.
  const toggleRemoval = yoloToggleWasRegistered && yoloToggle
    ? findManagedEntry(current, yoloToggle, packagesPrevious.packages[YOLO_TOGGLE_SOURCE])
    : undefined;
  const pendingToggleAfter: PendingYoloToggle | undefined = toggleRemoval
    ? {
        entry: toggleRemoval.entry,
        index: toggleRemoval.index,
        ...(packagesPrevious.packages[YOLO_TOGGLE_SOURCE]
          ? { managedPath: packagesPrevious.packages[YOLO_TOGGLE_SOURCE] }
          : {}),
      }
    : undefined;
  if (pendingToggleAfter) writePendingToggle(agentDir, previous, pendingToggleAfter);

  let reconciled = reconcilePackages({
    entries: current,
    seed: toggleAwaitingMigration && yoloToggle ? seed.filter((pkg) => pkg !== yoloToggle) : seed,
    runtimePackages: toggleAwaitingMigration && yoloToggle
      ? [...runtimePackages, yoloToggle]
      : runtimePackages,
    previous: packagesPrevious,
  });
  // `current` may carry a restored entry that is not on disk yet, so the
  // comparison has to be against what the settings manager loaded.
  if (reconciled.changed || current !== storedPackages) settingsManager.setPackages(reconciled.entries as never);
  // A still-installed pi-plan-vanguard would shadow the bundled /plan prompt
  // template (pi dispatches extension commands before expanding templates),
  // so the template waits until the user removes it. Their own plan install
  // is never removed for them (docs/distro.md, "Plan 模式" section).
  for (const skipped of reconciled.shadowed) {
    console.log(
      `[distro] not seeding ${skipped.source}: ${skipped.shadow} is still installed and its /plan command` +
        " would shadow the prompt template; remove that package to switch to the bundled one",
    );
  }

  if (firstRun) {
    const level = DISTRO.settingsDefaults.defaultThinkingLevel;
    if (level && !settingsManager.getDefaultThinkingLevel()) {
      settingsManager.setDefaultThinkingLevel(level as never);
    }
  }

  // One-time switch from the bundled pi-mcp-adapter extension to pi's
  // built-in MCP (distro revision 6): remove the package entry and the
  // adapter's "-builtin:mcp" guard, and carry adapter-only server configs
  // over to <agentDir>/mcp.json. Recorded so it never runs twice.
  const migrations = { ...(previous?.migrations ?? {}) };
  if (!migrations.mcpAdapter) {
    const report = runMcpAdapterMigration(agentDir, settingsManager);
    migrations.mcpAdapter = true;
    if (
      report.removedPackageEntries > 0 ||
      report.restoredBuiltinMcp ||
      report.migratedServers.length > 0 ||
      report.skippedServers.length > 0 ||
      report.warnings.length > 0
    ) {
      console.log(
        `[distro] pi-mcp-adapter -> built-in MCP: ${report.removedPackageEntries} package entry(ies) removed,` +
          ` builtin mcp ${report.restoredBuiltinMcp ? "restored" : "already on"},` +
          ` servers migrated: ${report.migratedServers.length ? report.migratedServers.join(", ") : "none"}` +
          (report.skippedServers.length ? `; skipped: ${report.skippedServers.join(", ")}` : "") +
          (report.warnings.length ? `; ${report.warnings.join("; ")}` : ""),
      );
    }
  }

  await settingsManager.flush();

  // One-time Code mode default (distro revision 9): `+codemode` in the global
  // defaultTools starts every session with Code mode active — the classifier
  // and image models the distro ships are reachable only from codemode
  // scripts. Runs after the flush: SettingsManager holds its own in-memory
  // snapshot of settings.json from before this write, and flushing it later
  // would erase the key. Applied only when the user's settings.json has no
  // `defaultTools` of their own; recorded so the GUI's "automatic" choice
  // (which deletes the key) is never re-applied against them.
  if (!migrations.defaultTools && DISTRO.settingsDefaults.defaultTools) {
    migrations.defaultTools = true;
    try {
      const applied = await updateGlobalSettings(getGlobalSettingsPath(agentDir), (settings) => {
        if (defaultToolEntries(settings) !== undefined) return false;
        settings.defaultTools = [...DISTRO.settingsDefaults.defaultTools!];
        return true;
      });
      if (applied) console.log("[distro] Code mode enabled by default (+codemode)");
    } catch (error) {
      console.warn("[distro] could not seed the default Code mode switch:", error);
    }
  }

  // One-time lazy tool activation (v0.7.402): the bundled pi-subagents and
  // pi-web-access start a fresh session with only their loader tool
  // (`subagents_enable` / `web_enable`) instead of declaring eight tool schemas
  // on the first request. Existing installs are the reason this is a migration
  // rather than an `agentFiles` default: their config files already exist, and
  // a value they chose themselves is never overwritten.
  if (!migrations.toolActivation) {
    try {
      const report = applyLazyToolActivation(agentDir);
      migrations.toolActivation = true;
      if (report.written.length > 0 || report.kept.length > 0 || report.invalid.length > 0) {
        console.log(
          `[distro] lazy tool activation: wrote ${report.written.join(", ") || "nothing"}`
            + `; kept ${report.kept.join(", ") || "nothing"}`
            + (report.invalid.length ? `; left unparsable: ${report.invalid.join(", ")}` : ""),
        );
      }
    } catch (error) {
      // A write failure must not skip the rest of the seed (agentFiles,
      // WATCHDOG.yml, desktop-distro.json); the flag stays unset so the next
      // start retries. A config file that is not valid JSON is not retried: it
      // is reported and left alone for good, like every other migration here.
      console.warn("[distro] could not seed lazy tool activation:", error);
    }
  }

  const newlySeededFiles = new Set<string>();
  for (const [name, contents] of Object.entries(DISTRO.agentFiles)) {
    const path = join(agentDir, name);
    // A legacy file the owning extension reads (and migrates itself on next
    // save) must not be shadowed by a freshly seeded canonical file.
    if ((DISTRO.legacyAgentFiles?.[name] ?? []).some((legacy) => fileExists(join(agentDir, legacy)))) continue;
    if (!fileExists(path) && isRecord(contents)) {
      writeJsonObject(path, contents);
      newlySeededFiles.add(name);
    }
  }

  ensureImageGenConfig(agentDir);

  for (const [name, contents] of Object.entries(DISTRO.agentTextFiles ?? {})) {
    // The advisor accepts both spellings; do not shadow an existing YAML config.
    if (name === "WATCHDOG.yml" && fileExists(join(agentDir, "WATCHDOG.yaml"))) continue;
    const path = join(agentDir, name);
    if (!fileExists(path) && typeof contents === "string") writeFileSync(path, contents, { mode: 0o644 });
  }

  if (versionChanged) refreshProviderModels();

  const releaseMigrations = runReleaseMigrations(
    agentDir,
    previous?.releaseMigrations,
    undefined,
    { newlySeededFiles },
  );

  if (toggleAwaitingMigration && yoloToggle && releaseMigrations["0.8.704"] === true) {
    // Reload after the direct settings migrations, then register the toggle
    // again — as the user's own entry (filters and unknown fields intact),
    // which is why the removal recorded it whole.
    const finalSettingsManager = SettingsManager.create(agentDir, agentDir);
    const latest = (finalSettingsManager.getGlobalSettings().packages ?? []) as PackageEntry[];
    const restored = pendingToggleAfter ? withRestoredToggle(latest, pendingToggleAfter) : latest;
    reconciled = reconcilePackages({
      entries: restored,
      seed,
      runtimePackages,
      previous: packagesPrevious,
    });
    if (reconciled.changed || restored !== latest) finalSettingsManager.setPackages(reconciled.entries as never);
    await finalSettingsManager.flush();
  } else if (yoloToggleRemovalMemory) {
    // The toggle stays out; the memory of the user's own removal must survive
    // the reconcile that ran without it in the seed.
    reconciled = {
      ...reconciled,
      managed: {
        packages: { ...reconciled.managed.packages, [YOLO_TOGGLE_SOURCE]: yoloToggleRemovalMemory },
      },
    };
  }

  writeJsonObject(distroStatePath(agentDir), {
    distro: DISTRO.id,
    seedVersion: manifest.seedVersion,
    defaultsApplied: true,
    packages: reconciled.managed.packages,
    migrations,
    releaseMigrations,
    // Carried until the toggle is registered again: the next start must
    // restore the user's entry instead of remembering a removal nobody made.
    ...(pendingToggleAfter && releaseMigrations["0.8.704"] !== true
      ? { pendingYoloToggle: pendingToggleAfter }
      : {}),
    // Preserved for ensureBundledBashShellPath, which merges into the same
    // file after this write; dropping it here would orphan the pin marker.
    ...(previous?.managedShellPath ? { managedShellPath: previous.managedShellPath } : {}),
  });
}
