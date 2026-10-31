/**
 * The IPC-backed provider-auth service (the static build's alias target for
 * lib/provider-auth-service.ts): the Models panel's provider lists, the
 * API-key save/remove and the OAuth logout go over pi_ipc — the management
 * instance runs the repo's own lib/provider-auth-service.server.ts
 * compositions (the same functions the Next /api/auth/* routes serve), so
 * credential material never crosses to the frontend on either path, and the
 * type-gated delete keeps an OAuth account signed in exactly like the
 * route's 409 did.
 *
 * The login STREAM (auth.loginStream) has its own module
 * (provider-auth-login.ts): a Channel subscription, not a request.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type {
  ApiKeyProvider,
  AuthProviderLists,
  OAuthProvider,
} from "../../../lib/provider-auth-service";

let client: IpcClient | null = null;

export function bindProviderAuthService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) throw new Error("the provider-auth service IPC bridge is not configured (bindProviderAuthService)");
  return client;
}

/** The provider lists (the IPC implementation; both lists, like the route's body). */
export async function fetchAuthProviders(): Promise<AuthProviderLists> {
  try {
    const data = await ensureClient().request<{ providers?: OAuthProvider[]; oauthProviders?: OAuthProvider[]; apiKeyProviders?: ApiKeyProvider[] }>(
      "auth.providers",
      undefined,
      { timeoutMs: 60_000 },
    );
    const oauthProviders = Array.isArray(data.oauthProviders) ? data.oauthProviders : [];
    return {
      // `providers` mirrors `oauthProviders` (the route's legacy field).
      providers: Array.isArray(data.providers) ? data.providers : oauthProviders,
      oauthProviders,
      apiKeyProviders: Array.isArray(data.apiKeyProviders) ? data.apiKeyProviders : [],
    };
  } catch (caught) {
    if (caught instanceof IpcFailure) throw new Error(caught.error.message || "Failed to load providers");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Save a provider API key (the IPC implementation; never auto-resent). */
export async function storeProviderApiKey(provider: string, apiKey: string): Promise<void> {
  try {
    await ensureClient().request<{ success: boolean }>(
      "auth.apiKeyStore",
      { provider, apiKey },
      { timeoutMs: 190_000 },
    );
  } catch (caught) {
    if (caught instanceof IpcFailure) throw new Error(caught.error.message || "Failed to save API key");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Remove a stored API key (the IPC implementation; the 409 message rides the error). */
export async function deleteProviderApiKey(provider: string): Promise<void> {
  try {
    await ensureClient().request<{ success: boolean }>(
      "auth.apiKeyDelete",
      { provider },
      { timeoutMs: 60_000 },
    );
  } catch (caught) {
    if (caught instanceof IpcFailure) throw new Error(caught.error.message || "Failed to remove API key");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}

/** Log out an OAuth-authenticated provider (the IPC implementation). */
export async function logoutProvider(provider: string): Promise<void> {
  try {
    await ensureClient().request<{ ok: boolean }>(
      "auth.logout",
      { provider },
      { timeoutMs: 60_000 },
    );
  } catch (caught) {
    if (caught instanceof IpcFailure) throw new Error(caught.error.message || "Failed to sign out");
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}
