/**
 * The provider-auth service seam (migration M3), client half: the Models
 * panel's provider sign-in surface — the OAuth/API-key provider lists, the
 * API-key save/remove, and the OAuth logout. Client-safe by construction
 * (types + the HTTP implementations only); the compositions live in
 * lib/provider-auth-service.server.ts, the ONE implementation the Next
 * routes (app/api/auth/**) and the management instance's `auth.providers` /
 * `auth.apiKeyStore` / `auth.apiKeyDelete` / `auth.logout` ops both run.
 *
 * The static build swaps this module for the IPC implementation
 * (static-frontend/src/data/provider-auth-service.ts).
 */

/** One OAuth entry in Settings › Models (the GET /api/auth/providers shape). */
export interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
  /** Provider also accepts an API key, so it appears in both picker sections. */
  supportsApiKey?: boolean;
}

/** One API-key entry in Settings › Models (the GET /api/auth/providers shape). */
export interface ApiKeyProvider {
  id: string;
  displayName: string;
  configured: boolean;
  source?: string;
  modelCount: number;
  /** Provider also supports OAuth, so it appears in both picker sections. */
  supportsOAuth?: boolean;
}

/** GET /api/auth/providers' body (both lists; `providers` mirrors `oauthProviders`). */
export interface AuthProviderLists {
  providers: OAuthProvider[];
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
}

/**
 * The provider lists (the HTTP implementation). Callers refresh BOTH lists
 * after any credential change: a dual-auth provider rendered from only one
 * list appears twice or not at all (#309).
 */
export async function fetchAuthProviders(): Promise<AuthProviderLists> {
  const res = await fetch("/api/auth/providers");
  const d = await res.json() as Partial<AuthProviderLists>;
  return {
    providers: Array.isArray(d.providers) ? d.providers : [],
    oauthProviders: Array.isArray(d.oauthProviders) ? d.oauthProviders : [],
    apiKeyProviders: Array.isArray(d.apiKeyProviders) ? d.apiKeyProviders : [],
  };
}

/**
 * Save a provider API key (the HTTP implementation): POST
 * /api/auth/api-key/[provider]. The raw key is never read back — only the
 * status lists are, after the change.
 */
export async function storeProviderApiKey(provider: string, apiKey: string): Promise<void> {
  const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const d = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
  if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
}

/**
 * Remove a stored provider API key (the HTTP implementation). A provider
 * authenticated with OAuth refuses with the route's 409 message — the
 * credential must be deleted from the OAuth section, by type.
 */
export async function deleteProviderApiKey(provider: string): Promise<void> {
  const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider)}`, { method: "DELETE" });
  const d = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
  if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
}

/**
 * Log out an OAuth-authenticated provider (the HTTP implementation). A
 * provider authenticated with an API key refuses with the route's 409
 * message.
 */
export async function logoutProvider(provider: string): Promise<void> {
  const res = await fetch(`/api/auth/logout/${encodeURIComponent(provider)}`, { method: "POST" });
  const d = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!res.ok || d.error) throw new Error(d.error ?? `HTTP ${res.status}`);
}
