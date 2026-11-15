/**
 * Switch the managed LW provider to openai-completions (release 0.8.502).
 *
 * The user-facing service address stays unsuffixed for web search, Exa and
 * image generation; only the chat provider's baseUrl gains `/v1`. Managed
 * model definitions are refreshed from distro.json so GLM receives pi's zai
 * compatibility fields and Claude keeps an explicit anthropic-messages
 * override. Custom models, credentials and provider compat are preserved.
 * Missing/not-yet-configured services are a no-op; unreadable files throw so
 * the release receipt stays unset and the next startup retries.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  DISTRO,
  distroProviderBaseUrl,
  distroServiceBaseUrl,
  mergeDistroModels,
  rebaseDistroModelUrls,
} from "./config";
import { isRecord } from "./json-file";
import { readModelsConfig, writeModelsConfig } from "../models-config-store";

export interface OpenAICompletionsMigrationReport { written: string[] }

export function applyOpenAICompletionsMigration(agentDir: string): OpenAICompletionsMigrationReport {
  const report: OpenAICompletionsMigrationReport = { written: [] };
  const modelsPath = join(agentDir, "models.json");
  if (!existsSync(modelsPath)) return report;

  const config = readModelsConfig(modelsPath);
  const providers = isRecord(config.providers) ? config.providers : {};
  const provider = providers[DISTRO.provider.id];
  if (!isRecord(provider)) return report;

  const configuredBase = typeof provider.baseUrl === "string" && provider.baseUrl.trim()
    ? provider.baseUrl
    : DISTRO.defaultBaseUrl;
  const serviceBaseUrl = distroServiceBaseUrl(configuredBase);
  const nextProvider = {
    ...provider,
    name: DISTRO.provider.name,
    baseUrl: distroProviderBaseUrl(serviceBaseUrl),
    api: DISTRO.provider.api,
    models: mergeDistroModels(
      provider.models,
      rebaseDistroModelUrls(DISTRO.provider.models, serviceBaseUrl),
    ),
  };
  if (isDeepStrictEqual(nextProvider, provider)) return report;

  writeModelsConfig({
    ...config,
    providers: { ...providers, [DISTRO.provider.id]: nextProvider },
  }, modelsPath);
  report.written.push("models.json");
  return report;
}
