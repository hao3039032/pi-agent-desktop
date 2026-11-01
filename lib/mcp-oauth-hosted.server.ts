import { createHash } from "node:crypto";
import { authorizeMcp, McpOAuthProvider, stepUpScope, type AuthorizationServerMetadata } from "@earendil-works/pi-mcp/oauth";
import type { McpSignInOptions } from "./pi-sdk-internals";

/** A listener belongs to one management task, never to the WebView. */
export interface McpHostedCallback {
  redirectUrl: string;
  wait(state: string, redirectUrl: URL, signal: AbortSignal): Promise<{ code: string; iss?: string }>;
  close(): void;
}

export type McpHostedCallbackFactory = (options: {
  host: string;
  redirectHost: string;
  port?: number;
  required: boolean;
  path: string;
  extraPaths: string[];
}, signal: AbortSignal) => Promise<McpHostedCallback>;

function callbackId(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = "";
  return createHash("sha256").update(url.href).digest().subarray(0, 9).toString("base64url");
}

function metadataDocument(serverUrl: string, redirectUrl: string, metadata: AuthorizationServerMetadata | undefined) {
  if (!metadata?.client_id_metadata_document_supported || !metadata.token_endpoint_auth_methods_supported?.includes("none")) {
    throw new Error('The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"');
  }
  if (metadata.authorization_response_iss_parameter_supported) return { url: "https://pi.dev/oauth/client.json", redirectUrl };
  const id = callbackId(serverUrl);
  const redirect = new URL(redirectUrl);
  redirect.pathname = `/callback/${id}`;
  return { url: `https://pi.dev/oauth/${id}/client.json`, redirectUrl: redirect.href };
}

function parseResponse(input: string | undefined, state: string, redirect: URL): { code: string; iss?: string } {
  if (!input?.trim()) throw new Error("Sign-in cancelled");
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("Expected the full redirect URL from the browser address bar"); }
  if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) throw new Error("The redirect URL does not match this sign-in's redirect URI");
  const error = url.searchParams.get("error");
  if (error) throw new Error(url.searchParams.get("error_description") ?? error);
  if (url.searchParams.get("state") !== state) throw new Error("The redirect URL belongs to a different sign-in");
  const code = url.searchParams.get("code");
  if (!code) throw new Error("The redirect URL does not contain an authorization code");
  return { code, iss: url.searchParams.get("iss") ?? undefined };
}

/** The SDK's public OAuth engine owns discovery, registration, PKCE and token exchange. */
export async function signInMcpWithHostedCallback(
  options: McpSignInOptions,
  startCallback: McpHostedCallbackFactory,
  signal: AbortSignal,
  onTokenRequest: (inFlight: boolean) => void = () => {},
): Promise<void> {
  const { serverUrl, store, settings, challenge, prompt } = options;
  if (signal.aborted) throw new Error("Sign-in cancelled");
  const stored = await store.load();
  const callbackUrl = new URL(settings.callbackUrl ?? "http://127.0.0.1/callback");
  const address = callbackUrl.hostname.replace(/^\[|\]$/g, "");
  const configuredPort = callbackUrl.port ? Number(callbackUrl.port) : settings.callbackPort;
  const registered = stored?.clientInformation && "redirect_uris" in stored.clientInformation
    ? stored.clientInformation.redirect_uris ?? [] : [];
  const preferredPort = configuredPort ?? (registered[0] ? Number(new URL(registered[0]).port) || undefined : undefined);
  const cimd = settings.clientRegistration === "cimd";
  const callback = await startCallback({
    host: address === "localhost" ? "127.0.0.1" : address,
    redirectHost: address,
    port: preferredPort,
    required: configuredPort !== undefined,
    path: callbackUrl.pathname,
    extraPaths: cimd ? [`/callback/${callbackId(serverUrl)}`] : [],
  }, signal);
  try {
    if (signal.aborted) throw new Error("Sign-in cancelled");
    if (!callbackUrl.port && settings.callbackPort !== undefined) callbackUrl.port = String(settings.callbackPort);
    const redirectUrl = configuredPort !== undefined ? (settings.callbackUrl && new URL(settings.callbackUrl).port ? settings.callbackUrl : callbackUrl.href) : callback.redirectUrl;
    if (stored) {
      const next = { ...stored };
      delete next.oauthState;
      const keepClient = settings.clientId || (cimd ? !stored.clientInformation : registered.includes(redirectUrl));
      if (!keepClient) { delete next.clientInformation; delete next.tokens; delete next.tokensExpireAt; }
      await store.save(next);
    }
    let authorizationUrl: URL | undefined;
    let tokenOutcomeUnknown = false;
    const provider = new McpOAuthProvider({
      serverUrl, redirectUrl,
      clientMetadata: { client_name: settings.clientName ?? "pi" },
      clientMetadataDocument: cimd ? (metadata) => metadataDocument(serverUrl, redirectUrl, metadata) : undefined,
      clientId: settings.clientId, clientSecret: settings.clientSecret,
      store: {
        load: () => store.load(),
        save: (value) => {
          if (tokenOutcomeUnknown) throw new Error("OAuth token request outcome is unknown");
          return store.save(value);
        },
      },
      onRedirect: (url) => { authorizationUrl = url; },
    });
    const stepUp = challenge?.error === "insufficient_scope";
    const scope = [...new Set([settings.scope, stepUp ? stepUpScope(stored?.tokens?.scope, challenge?.scope) : challenge?.scope]
      .flatMap((value) => value?.split(/\s+/).filter(Boolean) ?? []))].join(" ") || undefined;
    // User cancellation does not abort an in-flight token request. The 15s
    // request deadline still does: the remote server may already have issued
    // tokens or rotated a refresh token, so its outcome is then unknown.
    const authorize = async (extra: { skipRefresh?: boolean; authorizationCode?: string; iss?: string }) => {
      const deadline = new AbortController();
      let tokenTimedOut = false;
      const timedFetch: typeof fetch = async (input, init) => {
        const timeout = AbortSignal.timeout(15_000);
        const grant = init?.body instanceof URLSearchParams ? init.body.get("grant_type") : undefined;
        const isTokenRequest = grant === "authorization_code" || grant === "refresh_token";
        const onTimeout = () => { tokenTimedOut = true; tokenOutcomeUnknown = true; deadline.abort(); };
        if (isTokenRequest) {
          onTokenRequest(true);
          timeout.addEventListener("abort", onTimeout, { once: true });
        }
        try {
          const response = await fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
          if (isTokenRequest) {
            // pi-mcp reads the token response with text(); keep the deadline
            // active through body consumption, but not through later storage.
            const text = response.text.bind(response);
            response.text = async () => {
              try { return await text(); }
              finally { timeout.removeEventListener("abort", onTimeout); }
            };
          }
          return response;
        } catch (error) {
          timeout.removeEventListener("abort", onTimeout);
          throw error;
        }
      };
      try {
        const result = await authorizeMcp(provider, { serverUrl, fetch: timedFetch, signal: deadline.signal,
          resourceMetadataUrl: challenge?.resourceMetadataUrl, authorizationServerMetadataUrl: settings.authServerMetadataUrl, scope, ...extra });
        if (tokenTimedOut) throw new Error("token request timed out");
        return result;
      } catch (error) {
        if (tokenTimedOut) throw new Error("OAuth token request timed out; local sign-in stopped. The server may have issued tokens or rotated the refresh token; the remote outcome is unknown.");
        throw error;
      } finally {
        onTokenRequest(false);
      }
    };
    if (await authorize({ skipRefresh: stepUp }) === "AUTHORIZED") return;
    if (signal.aborted) throw new Error("Sign-in cancelled");
    if (!authorizationUrl) throw new Error("OAuth flow did not produce an authorization URL");
    const state = await provider.state();
    const redirect = new URL((authorizationUrl as URL).searchParams.get("redirect_uri") ?? redirectUrl);
    prompt.showAuthorizationUrl(authorizationUrl);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const browser = callback.wait(state, redirect, combined);
    const manual = prompt.promptForRedirectUrl(combined).then((input) => parseResponse(input, state, redirect));
    let response: { code: string; iss?: string };
    try { response = await Promise.race([browser, manual]); }
    finally { controller.abort(); browser.catch(() => {}); manual.catch(() => {}); }
    if (signal.aborted) throw new Error("Sign-in cancelled");
    await authorize({ authorizationCode: response.code, iss: response.iss });
  } finally { callback.close(); }
}
