import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DISTRO, rebaseDistroModelUrls } from "./config";
import { fileExists, isRecord, readJsonObject, writeJsonObject } from "./json-file";
import { reconcilePackages, type ManagedState, type PackageEntry } from "./packages";
import { readModelsConfig, writeModelsConfig } from "../models-config-store";
import { runMcpAdapterMigration } from "./mcp-migration";

export interface SeedManifest {
  distro: string;
  revision: number;
  /** Changes whenever the bundled package set or any of their versions changes. */
  seedVersion: string;
  packages: Array<{ source: string; path: string; version?: string }>;
}

interface DistroState extends ManagedState {
  distro: string;
  seedVersion?: string;
  defaultsApplied?: boolean;
  /** One-time migrations that already ran (name → true). */
  migrations?: Record<string, boolean>;
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
 * after an app update. Only the model catalog is managed; the user's baseUrl
 * and apiKey are never touched here.
 */
function refreshProviderModels(): void {
  try {
    const config = readModelsConfig();
    const providers = isRecord(config.providers) ? config.providers : {};
    const existing = providers[DISTRO.provider.id];
    if (!isRecord(existing)) return;
    const storedBaseUrl = typeof existing.baseUrl === "string" ? existing.baseUrl : DISTRO.defaultBaseUrl;
    writeModelsConfig({
      ...config,
      providers: {
        ...providers,
        [DISTRO.provider.id]: {
          ...existing,
          name: DISTRO.provider.name,
          api: DISTRO.provider.api,
          models: rebaseDistroModelUrls(DISTRO.provider.models, storedBaseUrl),
        },
      },
    });
  } catch (error) {
    console.warn("[distro] could not refresh provider models:", error);
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
  const seed = manifest.packages.map((pkg) => ({
    source: pkg.source,
    relativePath: pkg.path,
    path: join(resourcesDir, "pi-seed", ...pkg.path.split("/")),
  }));
  const current = (settingsManager.getGlobalSettings().packages ?? []) as PackageEntry[];
  const reconciled = reconcilePackages({ entries: current, seed, previous });
  if (reconciled.changed) settingsManager.setPackages(reconciled.entries as never);

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

  for (const [name, contents] of Object.entries(DISTRO.agentFiles)) {
    const path = join(agentDir, name);
    // A legacy file the owning extension reads (and migrates itself on next
    // save) must not be shadowed by a freshly seeded canonical file.
    if ((DISTRO.legacyAgentFiles?.[name] ?? []).some((legacy) => fileExists(join(agentDir, legacy)))) continue;
    if (!fileExists(path) && isRecord(contents)) writeJsonObject(path, contents);
  }

  for (const [name, contents] of Object.entries(DISTRO.agentTextFiles ?? {})) {
    const path = join(agentDir, name);
    if (!fileExists(path) && typeof contents === "string") writeFileSync(path, contents, { mode: 0o644 });
  }

  if (versionChanged) refreshProviderModels();

  writeJsonObject(distroStatePath(agentDir), {
    distro: DISTRO.id,
    seedVersion: manifest.seedVersion,
    defaultsApplied: true,
    packages: reconciled.managed.packages,
    migrations,
  });
}
