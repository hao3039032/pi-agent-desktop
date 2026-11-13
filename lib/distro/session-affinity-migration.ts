/**
 * Stable session-affinity headers for the distro gateway (release 0.8.402).
 *
 * The gateway identifies a conversation by the `x-session-id` request header
 * (OpenRouter-style session affinity, `compat.sendSessionAffinityHeaders` +
 * `compat.sessionAffinityFormat: "openrouter"` in models.json), which lets it
 * route a whole conversation consistently and reach the upstream prompt
 * cache. pi 1.5.2 sends it on the anthropic-messages, openai-completions and
 * openai-responses paths; the distro provider speaks anthropic-messages with
 * per-model openai-completions overrides, so one provider-level pair covers
 * both. The declarative source is `distro/distro.json` → `provider.compat`
 * (see docs/distro.md and the handover doc this follows, "Pi 会话 Header
 * 配置交接": `openrouter` is only the header format name — nothing is
 * re-routed to OpenRouter).
 *
 * The fields are only ever filled in where absent: an explicit value the user
 * already set — a deliberate `false`, a different format — is kept as their
 * choice and reported, never overwritten. Model-level compat overrides are
 * untouched (pi applies them on top of the provider's). An install whose
 * service is not configured yet (no distro provider in models.json) records
 * the receipt anyway: the service form fills the same defaults when it
 * creates the provider (lib/distro/service-config.ts).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DISTRO, mergeDistroProviderCompat } from "./config";
import { isRecord } from "./json-file";
import { readModelsConfig, writeModelsConfig } from "../models-config-store";

export interface SessionAffinityReport { written: string[]; kept: string[] }

/**
 * Fill the provider compat defaults from distro.json into an *existing*
 * `models.json` distro provider entry. Missing file / not-yet-configured
 * service → no-op success (the receipt is still recorded); an unreadable
 * models.json throws so the release receipt stays unset and the next start
 * retries. Idempotent: a second run writes nothing.
 */
export function applySessionAffinityMigration(agentDir: string): SessionAffinityReport {
  const report: SessionAffinityReport = { written: [], kept: [] };
  const defaults = DISTRO.provider.compat;
  if (!defaults) return report;

  const modelsPath = join(agentDir, "models.json");
  if (!existsSync(modelsPath)) return report;

  const config = readModelsConfig(modelsPath);
  const providers = isRecord(config.providers) ? config.providers : {};
  const provider = providers[DISTRO.provider.id];
  if (!isRecord(provider)) return report; // service not configured yet

  const existingCompat = provider.compat;
  if (isRecord(existingCompat)) {
    const overridden = Object.entries(defaults)
      .filter(([key, value]) => key in existingCompat && !isDeepStrictEqual(existingCompat[key], value))
      .map(([key]) => key);
    if (overridden.length) report.kept.push(`models.json: kept explicit ${overridden.join(", ")}`);
  }

  const compat = mergeDistroProviderCompat(provider.compat);
  if (!compat || isDeepStrictEqual(compat, provider.compat)) return report;

  writeModelsConfig({
    ...config,
    providers: { ...providers, [DISTRO.provider.id]: { ...provider, compat } },
  }, modelsPath);
  report.written.push("models.json");
  return report;
}
