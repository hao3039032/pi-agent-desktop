/**
 * Optional Exa fallback connection for pi-web-access (`provider: "exa"`).
 * The platform gateway proxies Exa's native POST /search and POST /contents
 * at `<service baseUrl>/exa` and authenticates with the user's platform key —
 * not an upstream Exa key. The pair only pre-fills a connection: the default
 * `provider` stays "gemini" and `workflow` stays "none"; switching the search
 * provider to "exa" is the user's on-demand choice. Whether the platform key
 * may call Exa at all is enforced (and billed) server-side; the client never
 * sends a test request.
 *
 * The pair is owned as a unit and shared by both writers (the service form
 * in service-config.ts and the release migration below). It is (re-)written
 * only when both sides are absent or provably ours: the URL equals what the
 * previous service address derives to and the key equals the previously
 * stored platform key. A custom URL or key keeps both sides untouched, so the
 * platform key never travels to a custom Exa host and a custom key never
 * travels to the gateway; a half-custom pair is never completed with the
 * other side's derived value.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DISTRO } from "./config";
import { isRecord, readJsonObject, writeJsonObject } from "./json-file";
import { readModelsConfig } from "../models-config-store";

/** The gateway's Exa endpoint for a service address: `<base>/exa` with
 * trailing slashes collapsed and an existing suffix kept; "" when the base is
 * unusable. Derived from whatever address the user saved — never a hard-coded
 * host. */
export function exaFallbackBaseUrl(
  baseUrl: string,
  suffix = DISTRO.webSearch.exaFallback?.baseUrlSuffix ?? "/exa",
): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return "";
  return base.endsWith(suffix) ? base : base + suffix;
}

/**
 * The Exa pair a service-form save or the release migration should write into
 * web-search.json. `{}` means "leave the pair alone": the file's values (or
 * their absence) are the user's. `prevBaseUrl`/`prevApiKey` are the service
 * address and platform key *before* this write (for the migration they equal
 * the next ones, so the pair is only ever filled in, never re-pointed).
 */
export function resolveExaFallbackPair(
  file: Record<string, unknown>,
  prevBaseUrl: string,
  prevApiKey: string,
  nextBaseUrl: string,
  nextApiKey: string,
): Record<string, string> {
  const exa = DISTRO.webSearch.exaFallback;
  if (!exa) return {};
  const hasUrl = Object.hasOwn(file, exa.baseUrlKey);
  const hasKey = Object.hasOwn(file, exa.apiKeyKey);
  // Only a completely absent pair can be seeded. Partial, cleared or malformed
  // values are explicit configuration, not permission to mix credentials.
  const absent = !hasUrl && !hasKey;
  const prevDerived = exaFallbackBaseUrl(prevBaseUrl, exa.baseUrlSuffix);
  const owned = hasUrl && hasKey && prevDerived !== "" && prevApiKey !== ""
    && file[exa.baseUrlKey] === prevDerived && file[exa.apiKeyKey] === prevApiKey;
  if (!absent && !owned) return {};
  const url = exaFallbackBaseUrl(nextBaseUrl, exa.baseUrlSuffix);
  if (!url || !nextApiKey) return {};
  return { [exa.baseUrlKey]: url, [exa.apiKeyKey]: nextApiKey };
}

export interface ExaFallbackReport { written: string[]; kept: string[] }

/**
 * Fill the Exa fallback pair into an *existing* `<agentDir>/web-search.json`
 * (release 0.8.215) so upgrading users get the fallback without reopening the
 * service form. Only runs where the connection is provably derivable:
 * models.json carries LW credentials and the file already exists — it is never
 * created here, because an agent-dir file would shadow the legacy
 * `~/.pi/web-search.json` (same rule as the toolActivation seed). A custom or
 * half-custom pair is kept as the user's choice; unreadable files and I/O
 * errors throw so the release receipt stays unset and the next start retries.
 */
export function applyExaFallbackMigration(agentDir: string): ExaFallbackReport {
  const report: ExaFallbackReport = { written: [], kept: [] };
  const webSearchFile = join(agentDir, "web-search.json");
  if (!existsSync(webSearchFile)) return report;

  const models = readModelsConfig(join(agentDir, "models.json"));
  const provider = isRecord(models.providers) ? models.providers[DISTRO.provider.id] : undefined;
  const baseUrl = isRecord(provider) && typeof provider.baseUrl === "string" ? provider.baseUrl : "";
  const apiKey = isRecord(provider) && typeof provider.apiKey === "string" ? provider.apiKey : "";
  if (!baseUrl || !apiKey) return report; // service not configured: nothing to derive from

  const webSearch = readJsonObject(webSearchFile);
  if (webSearch === null) throw new Error("web-search.json is not valid JSON; left untouched");
  const pair = resolveExaFallbackPair(webSearch, baseUrl, apiKey, baseUrl, apiKey);
  if (Object.keys(pair).length === 0) {
    report.kept.push("web-search.json: custom Exa connection kept");
    return report;
  }
  const next = { ...webSearch, ...pair };
  if (JSON.stringify(next) !== JSON.stringify(webSearch)) {
    writeJsonObject(webSearchFile, next);
    report.written.push("web-search.json");
  }
  return report;
}
