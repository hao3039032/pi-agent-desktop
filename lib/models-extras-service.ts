import type {
  ModelCatalogEntry,
  ModelCatalogPreset,
  ModelCatalogRecommendation,
} from "./model-catalog";
import type { DiscoveredModel } from "./model-discovery";
import type { NonChatModelInfo, NonChatModels, NonChatModelType } from "./nonchat-models";
import type { ProviderUsageId } from "./provider-usage-ids";
import type {
  ProviderUsageResult,
  UsageBucket,
  UsageMetric,
  UsageReport,
  UsageUnit,
} from "./provider-usage";

export type CodemodePreference = "automatic" | "always";

export interface ModelTestResult {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  responseText?: string;
  error?: string;
}

export type NonChatModelsResponse = NonChatModels & {
  codemode?: CodemodePreference;
};

export interface CatalogRefreshResponse {
  completed: boolean;
  changed: boolean;
  reason?: "offline" | "runtime";
  error?: string;
}

export interface ModelCatalogQueryParams {
  q?: string;
  provider?: string;
  baseUrl?: string;
  limit?: number;
  [key: string]: unknown;
}

export interface ModelCatalogQueryResult {
  models: ModelCatalogEntry[];
  recommendation?: ModelCatalogRecommendation;
  source: string;
}

export interface DiscoverModelsParams {
  providerName: string;
  provider: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DiscoverModelsResult {
  models: DiscoveredModel[];
  endpoint: string;
}

export interface TestModelParams {
  providerName: string;
  provider: Record<string, unknown>;
  model: Record<string, unknown> | { id: string };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// HTTP implementations (Next.js client)
// ---------------------------------------------------------------------------

/** Fetch model catalog presets from models.dev (the HTTP implementation). */
export async function fetchModelCatalogPresets(
  params: ModelCatalogQueryParams,
): Promise<ModelCatalogQueryResult> {
  const search = new URLSearchParams();
  if (params.q?.trim()) search.set("q", params.q.trim());
  if (params.provider?.trim()) search.set("provider", params.provider.trim());
  if (params.baseUrl?.trim()) search.set("baseUrl", params.baseUrl.trim());
  if (params.limit !== undefined) search.set("limit", String(params.limit));

  const res = await fetch(`/api/models-config/catalog?${search.toString()}`);
  const data = (await res.json()) as ModelCatalogQueryResult & { error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Discover models from a provider's upstream API (the HTTP implementation). */
export async function discoverProviderModels(
  params: DiscoverModelsParams,
): Promise<DiscoverModelsResult> {
  const res = await fetch("/api/models-config/discover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as DiscoverModelsResult & { error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Test model invocation with minimal prompt (the HTTP implementation). */
export async function testModelConfiguration(
  params: TestModelParams,
): Promise<ModelTestResult> {
  const res = await fetch("/api/models-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as ModelTestResult;
  if (!res.ok && !data.error) {
    return { ok: false, error: `HTTP ${res.status}`, status: res.status };
  }
  return data;
}

/** Fetch classifier and image models with global Code mode preference (the HTTP implementation). */
export async function fetchNonChatModels(): Promise<NonChatModelsResponse> {
  const res = await fetch("/api/models/nonchat");
  const data = (await res.json()) as NonChatModelsResponse & { error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Request on-demand refresh of remote provider catalogs (the HTTP implementation). */
export async function refreshModelCatalog(
  providerId?: string,
): Promise<CatalogRefreshResponse> {
  const res = await fetch("/api/models/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(providerId ? { provider: providerId } : {}),
  });
  const data = (await res.json()) as CatalogRefreshResponse;
  if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Query provider quota and usage (the HTTP implementation). */
export async function fetchProviderUsage(
  providerId: string,
): Promise<ProviderUsageResult> {
  const res = await fetch("/api/provider-usage/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId }),
  });
  const data = (await res.json()) as ProviderUsageResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export type {
  ModelCatalogEntry,
  ModelCatalogPreset,
  ModelCatalogRecommendation,
  DiscoveredModel,
  NonChatModelInfo,
  NonChatModels,
  NonChatModelType,
  ProviderUsageId,
  ProviderUsageResult,
  UsageBucket,
  UsageMetric,
  UsageReport,
  UsageUnit,
};
