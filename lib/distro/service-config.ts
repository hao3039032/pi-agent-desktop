import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DISTRO } from "./config";
import { isRecord, readJsonObject, writeJsonObject } from "./json-file";
import { readModelsConfig, writeModelsConfig } from "../models-config-store";

export interface DistroServiceStatus {
  providerId: string;
  providerName: string;
  configured: boolean;
  baseUrl: string;
  hasApiKey: boolean;
}

export class DistroConfigError extends Error {}

function webSearchPath(agentDir: string): string {
  return join(agentDir, "web-search.json");
}

export function readDistroServiceStatus(): DistroServiceStatus {
  let provider: Record<string, unknown> = {};
  try {
    const config = readModelsConfig();
    const providers = isRecord(config.providers) ? config.providers : {};
    const existing = providers[DISTRO.provider.id];
    if (isRecord(existing)) provider = existing;
  } catch {
    // An unreadable models.json reads as "not configured"; saving refuses to overwrite it.
  }
  const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
  const hasApiKey = typeof provider.apiKey === "string" && provider.apiKey.trim() !== "";
  return {
    providerId: DISTRO.provider.id,
    providerName: DISTRO.provider.name,
    configured: baseUrl !== "" && hasApiKey,
    baseUrl: baseUrl || DISTRO.defaultBaseUrl,
    hasApiKey,
  };
}

export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new DistroConfigError("baseUrl is required");
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DistroConfigError("baseUrl must be a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DistroConfigError("baseUrl must start with http:// or https://");
  }
  return trimmed;
}

/**
 * Write the service address and key everywhere the distro uses them:
 * models.json (the chat provider) and web-search.json (pi-web-access).
 * An omitted/empty apiKey keeps the stored one, so changing only the URL
 * does not require re-entering the key.
 */
export async function applyDistroServiceConfig(input: { baseUrl?: unknown; apiKey?: unknown }): Promise<DistroServiceStatus> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const incomingKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (/\s/.test(incomingKey)) throw new DistroConfigError("apiKey must not contain whitespace");

  const config = readModelsConfig();
  const providers = isRecord(config.providers) ? config.providers : {};
  const existing = isRecord(providers[DISTRO.provider.id]) ? providers[DISTRO.provider.id] as Record<string, unknown> : {};
  const storedKey = typeof existing.apiKey === "string" ? existing.apiKey : "";
  const apiKey = incomingKey || storedKey;
  if (!apiKey) throw new DistroConfigError("apiKey is required");

  writeModelsConfig({
    ...config,
    providers: {
      ...providers,
      [DISTRO.provider.id]: {
        ...existing,
        name: DISTRO.provider.name,
        baseUrl,
        api: DISTRO.provider.api,
        apiKey,
        models: DISTRO.provider.models,
      },
    },
  });

  const agentDir = getAgentDir();
  const webSearch = readJsonObject(webSearchPath(agentDir));
  if (webSearch) {
    writeJsonObject(webSearchPath(agentDir), {
      ...DISTRO.webSearch.defaults,
      ...webSearch,
      [DISTRO.webSearch.baseUrlKey]: baseUrl,
      [DISTRO.webSearch.apiKeyKey]: apiKey,
    });
  } else {
    console.warn("[distro] web-search.json is not valid JSON; left untouched");
  }

  const settingsManager = SettingsManager.create(agentDir, agentDir);
  if (!settingsManager.getDefaultProvider()) {
    settingsManager.setDefaultModelAndProvider(DISTRO.provider.id, DISTRO.provider.defaultModel);
    await settingsManager.flush();
  }

  return readDistroServiceStatus();
}
