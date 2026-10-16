/**
 * One-time migration from the pi-mcp-adapter extension to pi's built-in MCP
 * (fork-owned; see docs/distro.md). Revisions of this distro used to bundle
 * `npm:pi-mcp-adapter`; the bundle now ships without it and leans on the
 * official MCP support (`~/.pi/agent/mcp.json` + the built-in mcp extension).
 *
 * What the adapter leaves behind on an updated install, and what we do:
 *
 * - `packages` entries pointing at the adapter (bundled copy path, or a bare
 *   `npm:` spec the user added) → removed; without this pi keeps loading the
 *   adapter from a path that no longer exists (or reinstalls it).
 * - `"-builtin:mcp"` in `extensions` (the adapter writes this on first start
 *   so the two never both run) → removed, restoring the built-in MCP.
 * - MCP server definitions in the files only the adapter reads → converted
 *   into `~/.pi/agent/mcp.json` (existing entries win; nothing is deleted):
 *     `~/.pi/agent/mcp-adapter.json`   the adapter's own config
 *     `~/.config/mcp/mcp.json`         shared global config (adapter default)
 *     `~/.agents/mcp.json`             tool-agnostic global config
 *     `~/.agents/mcp/mcp.json`         tool-agnostic global config
 *   Server fields are translated per the adapter's documented mapping:
 *     disabled → enabled:false · requestTimeoutMs(ms) → timeout(s)
 *     directTools true/"search"/[names] → exposure direct/deferred /
 *     toolExposure{direct} · excludeTools → toolExposure{hidden}
 *     oauth.redirectUri → oauth.callbackUrl · type:"sse" entries skipped
 *   Adapter-only tuning (lifecycle, idleTimeout, approveTools, scriptMode,
 *   includeTools, …) has no built-in equivalent and is dropped. OAuth sign-ins
 *   live in the OS keychain and cannot be moved: those servers ask for a
 *   one-time `/mcp login <server>` again.
 *
 * Runs at most once per agent dir (`migrations.mcpAdapter` in
 * desktop-distro.json) and every step is a no-op when nothing matches.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { isRecord, readJsonObject, writeJsonObject } from "./json-file";
import { entrySource, packageKey } from "./packages";

const ADAPTER_PACKAGE_KEY = "npm:pi-mcp-adapter";

export interface McpMigrationReport {
  /** Number of `packages` entries removed for the adapter. */
  removedPackageEntries: number;
  /** True when `"-builtin:mcp"` was removed from `extensions`. */
  restoredBuiltinMcp: boolean;
  /** Server names merged into the agent dir's mcp.json. */
  migratedServers: string[];
  /** Server names skipped (legacy SSE transport or unconvertible). */
  skippedServers: string[];
  /** Non-fatal problems; surfaced in logs only. */
  warnings: string[];
}

function homeFile(...segments: string[]): string {
  return join(process.env.HOME ?? process.env.USERPROFILE ?? "", ...segments);
}

/** Files the adapter read that pi's built-in MCP does not. Later entries win. */
function adapterConfigSources(agentDir: string): string[] {
  return [
    homeFile(".config", "mcp", "mcp.json"),
    homeFile(".agents", "mcp.json"),
    homeFile(".agents", "mcp", "mcp.json"),
    join(agentDir, "mcp-adapter.json"),
  ];
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

/** Convert one adapter server entry to pi's mcp.json shape, or null to skip. */
export function convertAdapterServer(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (raw.type === "sse") return null;

  const out: Record<string, unknown> = {};
  if (typeof raw.command === "string") {
    out.command = raw.command;
    if (asStringArray(raw.args)) out.args = raw.args;
    if (isRecord(raw.env)) out.env = raw.env;
    if (typeof raw.cwd === "string") out.cwd = raw.cwd;
  } else if (typeof raw.url === "string") {
    out.url = raw.url;
    if (isRecord(raw.headers)) out.headers = raw.headers;
    if (isRecord(raw.auth) && typeof raw.auth.provider === "string") out.auth = { provider: raw.auth.provider };
    if (isRecord(raw.oauth)) {
      const oauth: Record<string, unknown> = {};
      for (const key of ["clientId", "clientSecret", "scope", "clientName"] as const) {
        if (typeof raw.oauth[key] === "string") oauth[key] = raw.oauth[key];
      }
      // The adapter's redirectUri is exactly pi's callbackUrl (loopback only).
      if (typeof raw.oauth.redirectUri === "string") oauth.callbackUrl = raw.oauth.redirectUri;
      if (Object.keys(oauth).length > 0) out.oauth = oauth;
    }
  } else {
    return null; // neither stdio nor http — nothing to migrate
  }

  if (typeof raw.description === "string") out.description = raw.description;
  if (raw.disabled === true) out.enabled = false;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.requestTimeoutMs === "number" && raw.requestTimeoutMs > 0) {
    out.timeout = Math.max(1, Math.round(raw.requestTimeoutMs / 1000));
  }

  const toolExposure: Record<string, string> = {};
  const excludeTools = asStringArray(raw.excludeTools);
  if (excludeTools) {
    for (const tool of excludeTools) toolExposure[tool] = "hidden";
  }
  if (raw.directTools === true) {
    out.exposure = "direct";
  } else if (raw.directTools === "search") {
    out.exposure = "deferred";
  } else {
    const directTools = asStringArray(raw.directTools);
    if (directTools) {
      // Proxy server (pi default exposure) with these tools promoted to direct.
      for (const tool of directTools) toolExposure[tool] = "direct";
    }
  }
  if (Object.keys(toolExposure).length > 0) out.toolExposure = toolExposure;

  return out;
}

/** Merge adapter-era server definitions into `<agentDir>/mcp.json`. */
function migrateServerConfigs(agentDir: string, report: McpMigrationReport): void {
  const officialPath = join(agentDir, "mcp.json");
  const official = readJsonObject(officialPath);
  if (official === null) {
    report.warnings.push(`${officialPath} is unreadable; MCP servers were not migrated`);
    return;
  }
  const servers = isRecord(official.mcpServers) ? { ...official.mcpServers } : {};

  for (const source of adapterConfigSources(agentDir)) {
    if (!existsSync(source)) continue;
    const config = readJsonObject(source);
    if (config === null) {
      report.warnings.push(`${source} is unreadable; skipped`);
      continue;
    }
    if (!isRecord(config.mcpServers)) continue;
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      if (name in servers) continue; // the official file wins
      const converted = convertAdapterServer(entry);
      if (converted === null) {
        report.skippedServers.push(name);
        continue;
      }
      servers[name] = converted;
      report.migratedServers.push(name);
    }
  }

  if (report.migratedServers.length === 0) return;
  writeJsonObject(officialPath, { ...official, mcpServers: servers });
}

function migratePackagesAndExtensions(
  settingsManager: SettingsManager,
  report: McpMigrationReport,
): boolean {
  let changed = false;

  const packages = settingsManager.getPackages() as import("./packages").PackageEntry[];
  const kept = packages.filter((entry) => {
    const key = packageKey(entrySource(entry));
    if (key === ADAPTER_PACKAGE_KEY) {
      report.removedPackageEntries += 1;
      return false;
    }
    return true;
  });
  if (kept.length !== packages.length) {
    settingsManager.setPackages(kept);
    changed = true;
  }

  const extensions = settingsManager.getExtensionPaths();
  if (extensions.includes("-builtin:mcp")) {
    settingsManager.setExtensionPaths(extensions.filter((item) => item !== "-builtin:mcp"));
    report.restoredBuiltinMcp = true;
    changed = true;
  }

  return changed;
}

/**
 * The whole one-time migration. Settings writes go through the caller's
 * SettingsManager (persisted by its flush in seedAgentDir).
 */
export function runMcpAdapterMigration(agentDir: string, settingsManager: SettingsManager): McpMigrationReport {
  const report: McpMigrationReport = {
    removedPackageEntries: 0,
    restoredBuiltinMcp: false,
    migratedServers: [],
    skippedServers: [],
    warnings: [],
  };
  migratePackagesAndExtensions(settingsManager, report);
  migrateServerConfigs(agentDir, report);
  return report;
}
