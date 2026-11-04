import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithRetry } from './fetch-timeout.ts';
import { readSessionResponse, SESSION_READ_TIMEOUT_MS } from './session-load.ts';

test('session read budget exceeds the CLI snapshot budget', () => {
  assert.ok(SESSION_READ_TIMEOUT_MS > 60000);
});

test('HTTP 5xx is retried once, while a 404 is returned without retry', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let calls = 0, retries = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response('', { status: 503 }) : Response.json({ sessionId: 'a' });
  const result = await fetchWithRetry('/session', { readResponse: readSessionResponse, onRetry: () => retries++ });
  assert.equal(result.payload.sessionId, 'a');
  assert.equal(calls, 2);
  assert.equal(retries, 1);
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', { status: 404 }); };
  assert.equal((await fetchWithRetry('/session', { readResponse: readSessionResponse })).res.status, 404);
  assert.equal(calls, 1);
});

test('the deadline covers a stalled JSON body, not just response headers', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let calls = 0;
  globalThis.fetch = async (_url, { signal }) => {
    calls++;
    return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) };
  };
  await assert.rejects(fetchWithRetry('/session', {
    timeoutMs: 15, retryTimeoutMs: 15, readResponse: readSessionResponse,
  }), /timed out/);
  assert.equal(calls, 2);
});

test('switching away aborts the active request without automatic retry', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let calls = 0;
  globalThis.fetch = async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const controller = new AbortController();
  const request = fetchWithRetry('/session', { init: { signal: controller.signal }, readResponse: readSessionResponse });
  controller.abort();
  await assert.rejects(request);
  assert.equal(calls, 1);
});
