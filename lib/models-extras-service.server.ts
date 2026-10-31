import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  flattenModelsDevCatalog,
  recommendModelCatalogPreset,
  searchModelCatalog,
  type ModelCatalogEntry,
  type ModelCatalogRecommendation,
} from "./model-catalog";
import {
  buildModelsListUrl,
  nextModelsPageUrl,
  parseDiscoveredModels,
  type DiscoveredModel,
} from "./model-discovery";
import { resolveModelDiscoveryAuth } from "./model-discovery-auth";
import { readModelsConfig } from "./models-config-store";
import { createModelRuntimeWithExtensions } from "./model-runtime";
import { readCodemodePreference, type CodemodePreference } from "./codemode-settings";
import { listNonChatModels, type NonChatModels, type NonChatModelRuntime } from "./nonchat-models";
import { shareModelCatalogRefresh, type CatalogRefreshResult } from "./model-catalog-refresh";
import {
  isProviderUsageId,
  queryProviderUsage,
  type ProviderUsageId,
  type ProviderUsageResult,
} from "./provider-usage";

export const MODELS_DEV_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const DISCOVERY_TIMEOUT_MS = 20_000;
const MAX_DISCOVERY_PAGES = 20;
const TEST_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// ---------------------------------------------------------------------------
// 1. modelsConfig.catalog
// ---------------------------------------------------------------------------

interface CatalogCache {
  entries: ModelCatalogEntry[];
  expiresAt: number;
  inFlight?: Promise<ModelCatalogEntry[]>;
}

declare global {
  var __piModelsDevCatalogCache: CatalogCache | undefined;
}

function getCache(): CatalogCache {
  return (globalThis.__piModelsDevCatalogCache ??= { entries: [], expiresAt: 0 });
}

async function fetchCatalog(sourceUrl: string): Promise<ModelCatalogEntry[]> {
  const response = await fetch(sourceUrl, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  const entries = flattenModelsDevCatalog(await response.json());
  if (entries.length === 0) throw new Error("models.dev returned an empty catalog");
  return entries;
}

export async function loadCatalog(sourceUrl = process.env.PI_MODELS_DEV_URL || MODELS_DEV_URL): Promise<ModelCatalogEntry[]> {
  const cache = getCache();
  if (cache.entries.length > 0 && cache.expiresAt > Date.now()) return cache.entries;
  if (!cache.inFlight) {
    cache.inFlight = fetchCatalog(sourceUrl).then((entries) => {
      cache.entries = entries;
      cache.expiresAt = Date.now() + CATALOG_TTL_MS;
      return entries;
    }).finally(() => {
      cache.inFlight = undefined;
    });
  }

  try {
    return await cache.inFlight;
  } catch (error) {
    if (cache.entries.length > 0) return cache.entries;
    throw error;
  }
}

export interface ModelCatalogQueryParams {
  q?: string;
  provider?: string;
  baseUrl?: string;
  limit?: number;
}

export interface ModelCatalogQueryResult {
  models: ModelCatalogEntry[];
  recommendation?: ModelCatalogRecommendation;
  source: string;
}

export async function queryModelCatalog(
  params: ModelCatalogQueryParams = {},
  sourceUrl?: string,
): Promise<ModelCatalogQueryResult> {
  const query = (params.q ?? "").slice(0, 120);
  const provider = (params.provider ?? "").slice(0, 120);
  const baseUrl = (params.baseUrl ?? "").slice(0, 500);
  const limit = Number.isFinite(params.limit) && (params.limit ?? 0) > 0 ? (params.limit as number) : 50;

  const resolvedSource = sourceUrl || process.env.PI_MODELS_DEV_URL || MODELS_DEV_URL;
  const entries = await loadCatalog(resolvedSource);
  const models = searchModelCatalog(entries, query, provider, limit);
  const recommendation = recommendModelCatalogPreset(entries, query, provider, baseUrl);
  return { models, recommendation, source: resolvedSource };
}

// ---------------------------------------------------------------------------
// 2. modelsConfig.discover
// ---------------------------------------------------------------------------

function hasHeader(headers: Headers, name: string): boolean {
  return headers.has(name);
}

function buildHeaders(api: string, apiKey: string | undefined, configured: Record<string, string>): Headers {
  const headers = new Headers(configured);
  if (!hasHeader(headers, "accept")) headers.set("Accept", "application/json");
  if (!apiKey) return headers;

  if (api === "anthropic-messages") {
    if (!hasHeader(headers, "x-api-key")) headers.set("x-api-key", apiKey);
    if (!hasHeader(headers, "anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (api === "google-generative-ai") {
    if (!hasHeader(headers, "x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
  } else if (!hasHeader(headers, "authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

export interface DiscoverModelsParams {
  providerName: string;
  provider: Record<string, unknown>;
}

export interface DiscoverModelsResult {
  models: DiscoveredModel[];
  endpoint: string;
}

export async function discoverModels(params: DiscoverModelsParams): Promise<DiscoverModelsResult> {
  const providerName = typeof params.providerName === "string" ? params.providerName.trim() : "";
  if (!providerName) throw new Error("providerName is required");
  if (!isRecord(params.provider)) throw new Error("provider is required");

  let providerWithKey = params.provider;
  if (typeof params.provider.apiKey !== "string" || !params.provider.apiKey.trim()) {
    try {
      const stored = readModelsConfig();
      const storedProviders = (stored.providers ?? {}) as Record<string, unknown>;
      const storedProvider = storedProviders[providerName] as Record<string, unknown> | undefined;
      if (storedProvider && typeof storedProvider.apiKey === "string" && storedProvider.apiKey.trim()) {
        providerWithKey = { ...params.provider, apiKey: storedProvider.apiKey };
      }
    } catch {
      // Ignore read failure and continue with given provider
    }
  }

  const configuredBaseUrl = typeof params.provider.baseUrl === "string" ? params.provider.baseUrl.trim() : "";
  const configuredApi = typeof params.provider.api === "string" && params.provider.api ? params.provider.api : "";

  let auth: Awaited<ReturnType<typeof resolveModelDiscoveryAuth>>;
  try {
    auth = await resolveModelDiscoveryAuth(providerName, providerWithKey);
  } catch (error) {
    if (!configuredBaseUrl) throw new Error("Base URL is required");
    throw error;
  }
  if (typeof providerWithKey.apiKey === "string" && providerWithKey.apiKey.trim() && !auth.apiKey) {
    throw new Error(`No API key found for "${providerName}"`);
  }

  const baseUrl = configuredBaseUrl || auth.baseUrl || "";
  if (!baseUrl) throw new Error("Base URL is required");
  const api = configuredApi || auth.api || "openai-completions";

  let endpoint: URL;
  try {
    endpoint = buildModelsListUrl(baseUrl, api);
  } catch {
    throw new Error("Base URL is invalid");
  }

  const headers = buildHeaders(api, auth.apiKey, auth.headers);
  const collected: unknown[] = [];
  let pageUrl: URL | null = endpoint;

  for (let page = 0; pageUrl && page < MAX_DISCOVERY_PAGES; page += 1) {
    const response = await fetch(pageUrl, {
      cache: "no-store",
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(responseText.slice(0, 500) || `Upstream returned HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error("Upstream model list was not valid JSON");
    }

    collected.push(payload);
    pageUrl = nextModelsPageUrl(pageUrl, api, payload);
  }

  const models = parseDiscoveredModels(collected.length === 1 ? collected[0] : collected);
  if (models.length === 0) {
    throw new Error("No models found in the upstream response");
  }

  return { models, endpoint: endpoint.toString() };
}

// ---------------------------------------------------------------------------
// 3. modelsConfig.test
// ---------------------------------------------------------------------------

export interface TestModelParams {
  providerName: string;
  provider: Record<string, unknown>;
  model: Record<string, unknown> | { id: string };
}

export interface ModelTestResult {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  responseText?: string;
  error?: string;
}

export async function testModel(params: TestModelParams): Promise<ModelTestResult> {
  const providerName = typeof params.providerName === "string" ? params.providerName.trim() : "";
  if (!providerName) return { ok: false, error: "providerName is required" };
  if (!isRecord(params.provider)) return { ok: false, error: "provider is required" };
  if (!isRecord(params.model)) return { ok: false, error: "model is required" };

  const modelId = typeof params.model.id === "string" ? params.model.id.trim() : "";
  if (!modelId) return { ok: false, error: "Model ID is required" };

  let providerWithKey = params.provider;
  if (typeof params.provider.apiKey !== "string" || !params.provider.apiKey.trim()) {
    try {
      const stored = readModelsConfig();
      const storedProviders = (stored.providers ?? {}) as Record<string, unknown>;
      const storedProvider = storedProviders[providerName] as Record<string, unknown> | undefined;
      if (storedProvider && typeof storedProvider.apiKey === "string" && storedProvider.apiKey.trim()) {
        providerWithKey = { ...params.provider, apiKey: storedProvider.apiKey };
      }
    } catch {
      // Ignore read failure and continue with given provider
    }
  }

  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "pi-web-model-test-"));
    const modelsPath = join(tempDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        [providerName]: {
          ...providerWithKey,
          models: [{ ...params.model, id: modelId }],
        },
      },
    }, null, 2), "utf8");

    const modelRuntime = await ModelRuntime.create({ modelsPath });
    const loadError = modelRuntime.getError();
    if (loadError) return { ok: false, error: loadError };

    const model = modelRuntime.getModel(providerName, modelId);
    if (!model) return { ok: false, error: `Model not found: ${providerName}/${modelId}` };

    const resolved = await modelRuntime.getAuth(model);
    if (!resolved?.auth.apiKey) {
      return { ok: false, error: `No API key found for "${providerName}"` };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    let status: number | undefined;
    const startedAt = Date.now();

    try {
      const message = await completeSimple(model, {
        messages: [{
          role: "user",
          content: "Reply with OK only.",
          timestamp: Date.now(),
        }],
      }, {
        apiKey: resolved.auth.apiKey,
        headers: resolved.auth.headers,
        maxTokens: 16,
        timeoutMs: TEST_TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
        onResponse: (response) => { status = response.status; },
      });

      const latencyMs = Date.now() - startedAt;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return {
          ok: false,
          error: message.errorMessage ?? (controller.signal.aborted ? "Test timed out" : "Model returned an error"),
          latencyMs,
          status,
        };
      }

      return {
        ok: true,
        latencyMs,
        status,
        responseText: getAssistantText(message).slice(0, 300),
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. models.nonchat
// ---------------------------------------------------------------------------

export interface NonChatModelsResult extends NonChatModels {
  codemode?: CodemodePreference;
}

export async function loadNonChatModels(): Promise<NonChatModelsResult> {
  const modelRuntime = await createModelRuntimeWithExtensions();
  const [models, codemode] = await Promise.all([
    listNonChatModels(modelRuntime as unknown as NonChatModelRuntime),
    readCodemodePreference(),
  ]);
  return { ...models, codemode };
}

// ---------------------------------------------------------------------------
// 5. models.refreshCatalog
// ---------------------------------------------------------------------------

export interface RefreshProviderCatalogsParams {
  provider?: string;
}

export async function refreshProviderCatalogs(
  params: RefreshProviderCatalogsParams = {},
): Promise<CatalogRefreshResult> {
  const provider = typeof params.provider === "string" ? params.provider.trim() : undefined;
  return shareModelCatalogRefresh(provider ? { providers: [provider] } : {});
}

// ---------------------------------------------------------------------------
// 6. models.providerUsage
// ---------------------------------------------------------------------------

export async function queryProviderUsageReport(providerId: string): Promise<ProviderUsageResult> {
  if (!isProviderUsageId(providerId)) {
    throw new Error(`Unsupported provider: "${providerId}"`);
  }
  try {
    return await queryProviderUsage(providerId);
  } catch {
    return {
      providerId: providerId as ProviderUsageId,
      status: "query-failed",
      message: "The provider usage query failed.",
    };
  }
}
