/**
 * The IPC-backed OAuth login service (the static build's alias target for
 * lib/provider-auth-login.ts): the Models panel's OAuth login stream
 * (auth.loginStream over a Tauri Channel) and manual code/selection submission
 * (auth.loginManualCode over pi_ipc).
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type { OAuthLoginEvent } from "../../../lib/provider-auth-login";

export type { OAuthLoginEvent };

let client: IpcClient | null = null;

export function bindProviderAuthLogin(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) {
    throw new Error("the provider-auth login IPC bridge is not configured (bindProviderAuthLogin)");
  }
  return client;
}

/**
 * Open the OAuth login stream for a provider over IPC (auth.loginStream).
 * Returns a teardown function that cancels the stream and flow.
 */
export function subscribeOAuthLogin(
  provider: string,
  onEvent: (event: OAuthLoginEvent) => void,
  onError: (error: Error) => void,
): () => void {
  return ensureClient().subscribe<OAuthLoginEvent>(
    "auth.loginStream",
    { provider },
    (message) => {
      if (message.payload) {
        onEvent(message.payload);
      }
    },
    (err) => {
      onError(new Error(err.message || "Connection lost"));
    },
  );
}

/**
 * Submit a manual code, prompt answer, or select choice over IPC (auth.loginManualCode).
 */
export async function submitOAuthLoginCode(
  provider: string,
  token: string,
  code: string,
): Promise<void> {
  try {
    await ensureClient().request<{ ok: boolean }>(
      "auth.loginManualCode",
      { provider, token, code: code.trim() },
      { timeoutMs: 60_000 },
    );
  } catch (caught) {
    if (caught instanceof IpcFailure) {
      throw new Error(caught.error.message || "Failed to submit login code");
    }
    throw caught instanceof Error ? caught : new Error(String(caught));
  }
}
