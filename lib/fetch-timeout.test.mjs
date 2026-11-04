import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

async function loadSubject() {
  return import("./fetch-timeout.ts");
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** A server that accepts the connection and then never answers. */
function hangingFetch(calls = []) {
  return (url, init) => {
    calls.push(url);
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("AbortError")));
    });
  };
}

test("a hung request rejects at the deadline instead of waiting forever", async () => {
  const { fetchWithDeadline } = await loadSubject();
  globalThis.fetch = hangingFetch();

  const started = Date.now();
  await assert.rejects(
    fetchWithDeadline("/api/sessions/abc", 40),
    // Keep the deadline in diagnostic details. The conversation's main UI
    // uses a localized recovery message, not this implementation detail.
    /timed out after 40ms/,
  );
  assert.ok(Date.now() - started < 1_000);
});

test("a hang is retried once and the retry can succeed", async () => {
  const { fetchWithRetry } = await loadSubject();
  const calls = [];
  let attempt = 0;
  globalThis.fetch = (url, init) => {
    attempt++;
    calls.push(url);
    // Mirrors a cold start: the first caller eats the warm-up and gives up,
    // the server finishes that work anyway, so the retry lands warm.
    if (attempt === 1) {
      return new Promise((_r, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("AbortError")));
      });
    }
    return Promise.resolve({ ok: true, status: 200 });
  };

  const res = await fetchWithRetry("/api/sessions/abc", { timeoutMs: 40, retryTimeoutMs: 200 });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 2);
});

test("both attempts failing surfaces the error so the retry button appears", async () => {
  const { fetchWithRetry } = await loadSubject();
  const calls = [];
  globalThis.fetch = hangingFetch(calls);

  await assert.rejects(
    fetchWithRetry("/api/sessions/abc", { timeoutMs: 30, retryTimeoutMs: 30 }),
    /timed out/,
  );
  assert.equal(calls.length, 2);
});

test("a load the user already navigated away from is not retried", async () => {
  const { fetchWithRetry } = await loadSubject();
  const calls = [];
  globalThis.fetch = hangingFetch(calls);

  await assert.rejects(
    fetchWithRetry("/api/sessions/abc", { timeoutMs: 30, shouldRetry: () => false }),
    /timed out/,
  );
  assert.equal(calls.length, 1);
});

test("the session load that owns the loading state uses a deadline", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  const body = source.slice(
    source.indexOf("const loadSession = useCallback"),
    source.indexOf("const retryLoad = useCallback"),
  );

  // Switching chats does not remount ChatWindow (AppShell deliberately keeps
  // sessionKey stable), so this one request owns `loading`. A bare fetch here
  // means a hung request leaves "loading session" on screen permanently.
  assert.match(body, /fetchWithRetry\(`\/api\/sessions\/\$\{encodeURIComponent\(sid\)\}\?\$\{params\}`/);
  assert.match(body, /shouldRetry: isCurrent/);
});

test("a healthy request is untouched and leaves no pending timer", async () => {
  const { fetchWithRetry } = await loadSubject();
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200 });

  const res = await fetchWithRetry("/api/sessions/abc", { timeoutMs: 30 });
  assert.equal(res.ok, true);
});
