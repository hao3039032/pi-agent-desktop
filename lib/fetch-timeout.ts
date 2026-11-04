/**
 * fetch with a hard deadline, plus one automatic retry.
 *
 * A request that *hangs* is worse than one that fails: a failure rejects and
 * the caller can show an error, while a hang leaves a loading state on screen
 * forever. Hangs are realistic here rather than theoretical — HTTP/1.1 allows
 * only a handful of connections per origin and the app holds several
 * long-lived SSE streams, so a request can sit queued behind them with nothing
 * to react to.
 *
 * Anything driving a user-visible loading state should go through this instead
 * of a bare fetch.
 */

/** Generous enough for a cold packaged server; short enough to not feel stuck. */
export const DEFAULT_FETCH_TIMEOUT_MS = 6_000;

export async function fetchWithDeadline<T = Response>(
  url: string,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  init: RequestInit = {},
  readResponse?: (response: Response) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // With a reader the deadline covers the body as well as response headers.
    return readResponse ? await readResponse(response) : response as T;
  } catch (error) {
    if (timedOut) throw new Error(`Request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

/**
 * Retry gets a longer deadline than the first attempt: reaching it at all
 * means the server was busy, and the most likely reason is a cold start whose
 * work continues server-side after the client gives up — so the retry usually
 * lands on an already-warm server, but deserves room if it does not.
 */
export const DEFAULT_FETCH_RETRY_TIMEOUT_MS = 10_000;

/**
 * One deadline-bounded retry. `shouldRetry` lets the caller drop a retry that
 * has become pointless — the user switching away mid-request, say — so a
 * stale load cannot cost another full timeout.
 */
export async function fetchWithRetry<T = Response>(
  url: string,
  options: {
    timeoutMs?: number;
    retryTimeoutMs?: number;
    init?: RequestInit;
    shouldRetry?: () => boolean;
    onRetry?: () => void;
    readResponse?: (response: Response) => Promise<T>;
  } = {},
): Promise<T> {
  const {
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    retryTimeoutMs = DEFAULT_FETCH_RETRY_TIMEOUT_MS,
    init = {},
    shouldRetry,
    onRetry,
    readResponse,
  } = options;
  try {
    return await fetchWithDeadline<T>(url, timeoutMs, init, readResponse);
  } catch (error) {
    if (init.signal?.aborted || (shouldRetry && !shouldRetry())) throw error;
    onRetry?.();
    return fetchWithDeadline<T>(url, retryTimeoutMs, init, readResponse);
  }
}
