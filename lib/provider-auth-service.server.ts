import { invalidateModelsCache } from "./models-cache";
import { createModelRuntimeWithExtensions } from "./model-runtime";
import {
  buildApiKeyProviderList,
  buildOAuthProviderList,
} from "./provider-listing";
import {
  collectProviderListingInputs,
  customModelsJsonProviderIds,
} from "./provider-listing-runtime";
import { removeStoredCredentialIfType, storeProviderCredential } from "./provider-credential-store";

/**
 * The provider-auth service seam (migration M3), server half: the ONE
 * composition behind the provider auth routes. Both backends run this exact
 * module — the Next routes (app/api/auth/providers, api-key, logout) and the
 * management instance's `auth.*` ops (the esbuild projection in
 * scripts/migration/build-management-modules.mjs bundles this file). A drift
 * between them is a contract break, so the routes and the extension ops are
 * thin adapters, never a second copy of this logic.
 *
 * The layers underneath are unchanged: capability-driven listing
 * (lib/provider-listing.ts), the ModelRuntime adapter
 * (lib/provider-listing-runtime.ts) and the type-gated credential
 * remove under pi's own auth.json lock (lib/provider-credential-store.ts).
 */

/** The shaped refusals the routes answer 400/409 (the UI shows the message). */
export type ProviderAuthRefusalReason =
  /** POST body carried no usable key (400). */
  | "invalid_args"
  /** The provider declares no API-key login method (500). */
  | "api_key_unsupported"
  /** The provider declares no OAuth method (400). */
  | "unknown_provider"
  /** The stored credential is the other kind; delete it from its own section (409). */
  | "credential_type_mismatch";

export class ProviderAuthRefusalError extends Error {
  public readonly reason: ProviderAuthRefusalReason;

  constructor(reason: ProviderAuthRefusalReason, message: string) {
    super(message);
    this.name = "ProviderAuthRefusalError";
    this.reason = reason;
  }
}

/**
 * GET /api/auth/providers' body: both auth lists, built from the auth
 * methods providers actually declare (never a hardcoded id list — #309).
 * ModelsConfig renders custom models.json providers itself, so their ids
 * keep them out of the API-key list.
 */
export async function composeProviderLists(): Promise<{
  providers: ReturnType<typeof buildOAuthProviderList>;
  oauthProviders: ReturnType<typeof buildOAuthProviderList>;
  apiKeyProviders: ReturnType<typeof buildApiKeyProviderList>;
}> {
  const modelRuntime = await createModelRuntimeWithExtensions();
  const inputs = await collectProviderListingInputs(
    modelRuntime,
    customModelsJsonProviderIds(),
  );
  const oauthProviders = buildOAuthProviderList(inputs);
  const apiKeyProviders = buildApiKeyProviderList(inputs);
  return { providers: oauthProviders, oauthProviders, apiKeyProviders };
}

/**
 * POST /api/auth/api-key/[provider]'s shared body. The provider's own
 * login() runs with a headless prompt shim (select the API-key option,
 * answer the secret prompt once); the returned credential is stored
 * directly so a slow catalog refresh cannot leave the save hanging, and the
 * models cache is dropped so the next list read reflects the new auth.
 */
export async function storeProviderApiKey(
  provider: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    throw new ProviderAuthRefusalError("invalid_args", "apiKey is required");
  }
  const modelRuntime = await createModelRuntimeWithExtensions();
  const apiKeyAuth = modelRuntime.getProvider(provider)?.auth.apiKey;
  if (!apiKeyAuth?.login) {
    throw new ProviderAuthRefusalError(
      "api_key_unsupported",
      `${provider} does not support API key login`,
    );
  }
  let keySubmitted = false;
  const credential = await apiKeyAuth.login({
    // The HTTP route passes the request's signal (a client disconnect
    // aborts the flow); callers without one keep a fresh un-aborted signal
    // — the login is bounded by its own caller timeout instead.
    signal: signal ?? new AbortController().signal,
    notify: () => {},
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        const keyOption = prompt.options.find((option) => option.id === "api-key" || option.id === "bearer-token");
        if (keyOption) return keyOption.id;
        throw new Error(`${provider} requires interactive authentication setup`);
      }
      if (!keySubmitted && prompt.type === "secret") {
        keySubmitted = true;
        return apiKey.trim();
      }
      throw new Error(`${provider} requires additional authentication settings`);
    },
  });
  // ModelRuntime.login() persists the credential and then performs an
  // unbounded network catalog refresh. Store the returned credential
  // directly so a slow catalog cannot leave the save request hanging.
  await storeProviderCredential(provider, credential);
  invalidateModelsCache();
}

/**
 * DELETE /api/auth/api-key/[provider]'s shared body: the credential is
 * removed only when its stored type is api_key — an OAuth credential
 * refuses with the 409 message instead of silently logging the account out.
 */
export async function removeProviderApiKey(provider: string): Promise<void> {
  const removal = await removeStoredCredentialIfType(provider, "api_key");
  if (removal.status === "type_mismatch") {
    throw new ProviderAuthRefusalError(
      "credential_type_mismatch",
      `${provider} is authenticated with OAuth, not an API key`,
    );
  }
  invalidateModelsCache();
}

/**
 * POST /api/auth/logout/[provider]'s shared body: only providers that
 * declare an OAuth method can be logged out this way, and only an oauth
 * credential is deleted (an API-key credential refuses with the 409
 * message).
 */
export async function logoutProvider(provider: string): Promise<void> {
  const modelRuntime = await createModelRuntimeWithExtensions();
  if (!modelRuntime.getProvider(provider)?.auth.oauth) {
    throw new ProviderAuthRefusalError("unknown_provider", `Unknown provider: ${provider}`);
  }
  const removal = await removeStoredCredentialIfType(provider, "oauth");
  if (removal.status === "type_mismatch") {
    throw new ProviderAuthRefusalError(
      "credential_type_mismatch",
      `${provider} is authenticated with an API key, not OAuth`,
    );
  }
  invalidateModelsCache();
}
