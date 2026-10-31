/**
 * The IPC-backed models-extras service (static-frontend alias for
 * lib/models-extras-service.ts): catalog presets, provider discovery,
 * model testing, non-chat models, catalog refresh, and provider usage
 * go through typed IPC over pi_ipc to the management instance.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type {
  CatalogRefreshResponse,
  DiscoverModelsParams,
  DiscoverModelsResult,
  ModelCatalogQueryParams,
  ModelCatalogQueryResult,
  ModelTestResult,
  NonChatModelsResponse,
  ProviderUsageResult,
  TestModelParams,
} from "../../../lib/models-extras-service";

let client: IpcClient | null = null;

export function bindModelsExtrasService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) {
    throw new Error(
      "the models-extras service IPC bridge is not configured (bindModelsExtrasService)",
    );
  }
  return client;
}

function toError(caught: unknown, fallback: string): Error {
  if (caught instanceof IpcFailure) return new Error(caught.error.message || fallback);
  return caught instanceof Error ? caught : new Error(String(caught));
}

/** Fetch model catalog presets from models.dev (the IPC implementation). */
export async function fetchModelCatalogPresets(
  params: ModelCatalogQueryParams,
): Promise<ModelCatalogQueryResult> {
  try {
    return await ensureClient().request<ModelCatalogQueryResult>(
      "modelsConfig.catalog",
      params,
      { timeoutMs: 30_000 },
    );
  } catch (caught) {
    throw toError(caught, "Failed to load model catalog presets");
  }
}

/** Discover models from a provider's upstream API (the IPC implementation). */
export async function discoverProviderModels(
  params: DiscoverModelsParams,
): Promise<DiscoverModelsResult> {
  try {
    return await ensureClient().request<DiscoverModelsResult>(
      "modelsConfig.discover",
      params,
      { timeoutMs: 30_000 },
    );
  } catch (caught) {
    throw toError(caught, "Failed to discover models");
  }
}

/** Test model invocation with minimal prompt (the IPC implementation). */
export async function testModelConfiguration(
  params: TestModelParams,
): Promise<ModelTestResult> {
  try {
    return await ensureClient().request<ModelTestResult>(
      "modelsConfig.test",
      params,
      { timeoutMs: 30_000 },
    );
  } catch (caught) {
    const error = caught instanceof IpcFailure ? (caught.error.message || "Model test failed") : (caught instanceof Error ? caught.message : String(caught));
    return { ok: false, error };
  }
}

/** Fetch classifier and image models with global Code mode preference (the IPC implementation). */
export async function fetchNonChatModels(): Promise<NonChatModelsResponse> {
  try {
    return await ensureClient().request<NonChatModelsResponse>(
      "models.nonchat",
      {},
      { timeoutMs: 30_000 },
    );
  } catch (caught) {
    throw toError(caught, "Failed to load non-chat models");
  }
}

/** Request on-demand refresh of remote provider catalogs (the IPC implementation). */
export async function refreshModelCatalog(
  providerId?: string,
): Promise<CatalogRefreshResponse> {
  try {
    return await ensureClient().request<CatalogRefreshResponse>(
      "models.refreshCatalog",
      providerId ? { provider: providerId } : {},
      { timeoutMs: 30_000 },
    );
  } catch (caught) {
    throw toError(caught, "Failed to refresh model catalog");
  }
}

/** Query provider quota and usage (the IPC implementation). */
export async function fetchProviderUsage(
  providerId: string,
): Promise<ProviderUsageResult> {
  try {
    return await ensureClient().request<ProviderUsageResult>(
      "models.providerUsage",
      { providerId },
      { timeoutMs: 30_000 },
    );
  } catch (caught) {
    throw toError(caught, "Failed to query provider usage");
  }
}

export type {
  CatalogRefreshResponse,
  DiscoverModelsParams,
  DiscoverModelsResult,
  ModelCatalogQueryParams,
  ModelCatalogQueryResult,
  ModelTestResult,
  NonChatModelsResponse,
  ProviderUsageResult,
  TestModelParams,
};
