import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DISTRO, imageGenBaseUrl, mergeDistroModels, rebaseDistroModelUrls } from "./config";
import { LAZY_TOOL_ACTIVATION } from "./lazy-tool-activation";
import { readNpmMirrorEnabled, setNpmMirrorEnabled } from "./npm-mirror";
import { isRecord, readJsonObject, writeJsonObject } from "./json-file";
import { readModelsConfig, writeModelsConfig } from "../models-config-store";

export interface DistroServiceStatus {
  providerId: string;
  providerName: string;
  configured: boolean;
  baseUrl: string;
  hasApiKey: boolean;
  npmMirror: boolean;
}

export class DistroConfigError extends Error {}

function webSearchPath(agentDir: string): string {
  return join(agentDir, "web-search.json");
}

function imageGenPath(agentDir: string): string | null {
  return DISTRO.imageGen ? join(agentDir, DISTRO.imageGen.configFile) : null;
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
    npmMirror: readNpmMirrorEnabled(),
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
 * models.json (the chat provider), web-search.json (pi-web-access) and
 * pi-model-images.json (the imagegen CLI shipped as a skill since
 * pi-model-images 0.2, which talks to the OpenAI Images API directly).
 * An omitted/empty apiKey keeps the stored one, so changing only the URL
 * does not require re-entering the key.
 */
export async function applyDistroServiceConfig(input: { baseUrl?: unknown; apiKey?: unknown; useNpmMirror?: unknown }): Promise<DistroServiceStatus> {
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
        models: mergeDistroModels(
          existing.models,
          rebaseDistroModelUrls(DISTRO.provider.models, baseUrl),
        ),
      },
    },
  });

  const agentDir = getAgentDir();
  const webSearchFile = webSearchPath(agentDir);
  // pi-web-access resolves its config as <agentDir>/web-search.json (when it
  // exists) → ~/.pi/web-search.json (legacy) → defaults, so the file is created
  // here, on the first service-config save, instead of being seeded as a bare
  // `agentFiles` entry: an existing user who still configures the legacy file
  // would otherwise be switched to an empty agent-dir file and lose their
  // provider/apiKey. The lazy switch goes in only when the file has no content
  // yet (missing or empty) — the key is a one-shot seed, so a file that already
  // holds settings (including one where the user deleted the key to fall back to
  // the extensions' `auto`) is never touched.
  // It also cannot live in `webSearch.defaults`: those are re-merged on every
  // save, which would put the key back after such a deletion.
  const webSearch = readJsonObject(webSearchFile);
  // An empty (0-byte or all-whitespace) file counts as not written yet: it holds
  // no user choice to respect, so it is treated as a first creation.
  const webSearchHasContent = webSearch !== null && Object.keys(webSearch).length > 0;
  if (webSearch) {
    writeJsonObject(webSearchFile, {
      ...(webSearchHasContent ? {} : { toolActivation: LAZY_TOOL_ACTIVATION }),
      ...DISTRO.webSearch.defaults,
      ...webSearch,
      [DISTRO.webSearch.baseUrlKey]: baseUrl,
      [DISTRO.webSearch.apiKeyKey]: apiKey,
    });
  } else {
    console.warn("[distro] web-search.json is not valid JSON; left untouched");
  }

  // Same service, OpenAI form: the imagegen CLI posts to
  // `{baseUrl}/images/generations` and must not share the anthropic base.
  const imageGen = imageGenPath(agentDir);
  if (imageGen) {
    const imageGenConfig = readJsonObject(imageGen);
    if (imageGenConfig) {
      writeJsonObject(imageGen, {
        ...imageGenConfig,
        baseUrl: imageGenBaseUrl(baseUrl),
        apiKey,
      });
    } else {
      console.warn(`[distro] ${DISTRO.imageGen?.configFile} is not valid JSON; left untouched`);
    }
  }

  const settingsManager = SettingsManager.create(agentDir, agentDir);
  let settingsDirty = false;
  if (!settingsManager.getDefaultProvider()) {
    settingsManager.setDefaultModelAndProvider(DISTRO.provider.id, DISTRO.provider.defaultModel);
    settingsDirty = true;
  }
  if (typeof input.useNpmMirror === "boolean") {
    await setNpmMirrorEnabled(input.useNpmMirror, agentDir);
  }
  if (settingsDirty) await settingsManager.flush();

  return readDistroServiceStatus();
}
