/**
 * The provider-auth login service seam (migration M3), client half:
 * the Models panel's OAuth login stream and manual code/selection submission.
 * Client-safe by construction: types + HTTP implementations only (EventSource / fetch).
 *
 * The static build swaps this module for the IPC implementation
 * (static-frontend/src/data/provider-auth-login.ts).
 */

export type OAuthLoginEvent =
  | { type: "auth"; url: string; instructions: string | null; token: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds: number | null;
      expiresInSeconds: number | null;
    }
  | { type: "prompt_request"; message: string; placeholder: string | null; token: string }
  | { type: "select_request"; message: string; options: { id: string; label: string }[]; token: string }
  | { type: "progress"; message: string }
  | { type: "success" }
  | { type: "error"; message: string }
  | { type: "cancelled" };

/**
 * Open the OAuth login stream for a provider (the HTTP implementation: GET /api/auth/login/[provider]).
 * Returns a teardown function that closes the stream and cancels the login.
 */
export function subscribeOAuthLogin(
  provider: string,
  onEvent: (event: OAuthLoginEvent) => void,
  onError: (error: Error) => void,
): () => void {
  const es = new EventSource(`/api/auth/login/${encodeURIComponent(provider)}`);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as OAuthLoginEvent;
      onEvent(data);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  };
  es.onerror = () => {
    onError(new Error("Connection lost"));
  };
  return () => {
    es.close();
  };
}

/**
 * Submit manual code, prompt input, or select choice (the HTTP implementation: POST /api/auth/login/[provider]).
 */
export async function submitOAuthLoginCode(
  provider: string,
  token: string,
  code: string,
): Promise<void> {
  const res = await fetch(`/api/auth/login/${encodeURIComponent(provider)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, code: code.trim() }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(d.error ?? `HTTP ${res.status}`);
  }
}
