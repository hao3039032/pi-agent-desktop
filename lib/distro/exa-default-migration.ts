/**
 * Make Exa the default search provider (release 0.8.503).
 *
 * Only the exact old distro default (`provider: "gemini"` together with the
 * distro searchModel, and no conflicting searchProvider) is migrated. Custom
 * provider choices stay untouched. The switch happens only with a complete
 * Exa connection: an existing pair is reused, or a wholly absent pair is
 * derived from the configured LW service with the same credential-ownership
 * rules as the service form. A partial/unavailable connection keeps Gemini
 * instead of leaving search broken. The legacy ~/.pi/web-search.json is never
 * shadowed by creating a new agent-dir file.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DISTRO, distroServiceBaseUrl } from "./config";
import { resolveExaFallbackPair } from "./exa-fallback";
import { isRecord, readJsonObject, writeJsonObject } from "./json-file";
import { readModelsConfig } from "../models-config-store";

export interface ExaDefaultMigrationReport { written: string[]; kept: string[] }

export function applyExaDefaultMigration(agentDir: string): ExaDefaultMigrationReport {
  const report: ExaDefaultMigrationReport = { written: [], kept: [] };
  const webSearchPath = join(agentDir, "web-search.json");
  if (!existsSync(webSearchPath)) return report;

  const webSearch = readJsonObject(webSearchPath);
  if (webSearch === null) throw new Error("web-search.json is not valid JSON; left untouched");
  if (webSearch.provider === "exa" || webSearch.searchProvider === "exa") return report;

  const oldDefault = webSearch.provider === "gemini"
    && webSearch.searchModel === DISTRO.webSearch.defaults.searchModel
    && (webSearch.searchProvider === undefined || webSearch.searchProvider === "gemini");
  if (!oldDefault) {
    report.kept.push("web-search.json: custom search provider kept");
    return report;
  }

  const exa = DISTRO.webSearch.exaFallback;
  if (!exa) {
    report.kept.push("web-search.json: no Exa connection configured");
    return report;
  }

  let pair: Record<string, string> = {};
  const hasUrl = Object.hasOwn(webSearch, exa.baseUrlKey);
  const hasKey = Object.hasOwn(webSearch, exa.apiKeyKey);
  if (!hasUrl && !hasKey) {
    const models = readModelsConfig(join(agentDir, "models.json"));
    const provider = isRecord(models.providers) ? models.providers[DISTRO.provider.id] : undefined;
    const configuredBase = isRecord(provider) && typeof provider.baseUrl === "string" ? provider.baseUrl : "";
    const baseUrl = configuredBase ? distroServiceBaseUrl(configuredBase) : "";
    const apiKey = isRecord(provider) && typeof provider.apiKey === "string" ? provider.apiKey : "";
    pair = resolveExaFallbackPair(webSearch, baseUrl, apiKey, baseUrl, apiKey);
  }

  const connected = { ...webSearch, ...pair };
  const connectedBaseUrl = connected[exa.baseUrlKey];
  const connectedApiKey = connected[exa.apiKeyKey];
  const complete = typeof connectedBaseUrl === "string" && connectedBaseUrl.trim() !== ""
    && typeof connectedApiKey === "string" && connectedApiKey.trim() !== "";
  if (!complete) {
    report.kept.push("web-search.json: incomplete Exa connection; Gemini default kept");
    return report;
  }

  connected.provider = "exa";
  if (connected.searchProvider === "gemini") connected.searchProvider = "exa";
  writeJsonObject(webSearchPath, connected);
  report.written.push("web-search.json");
  return report;
}
