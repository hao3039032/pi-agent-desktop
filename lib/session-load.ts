/** Session opening has a different budget from small settings/list requests:
 * a live CLI snapshot may take up to 60s. Do not abandon it after 6s and enqueue
 * another identical read. Both attempts remain bounded, including JSON bodies.
 */
export const SESSION_READ_TIMEOUT_MS = 65_000;
export const SESSION_READ_SLOW_MS = 8_000;
export type SessionLoadPhase = "opening" | "slow" | "retrying" | "ready" | "failed";

/** Retry transient server failures inside fetchWithRetry, but not 4xx replies. */
export async function readSessionResponse<T>(response: Response): Promise<{ res: Response; payload: T | null }> {
  if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
  return { res: response, payload: response.ok ? await response.json() as T : null };
}
