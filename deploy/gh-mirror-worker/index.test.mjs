import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, classifyTarget, extractTarget, parseAllowedRepos } from "./src/index.mjs";

const REPO = "hao3039032/pi-agent-desktop";
const env = { ALLOWED_REPOS: REPO };
const M = "https://gh.example.com";

function fakeFetch(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    const handler = routes[url];
    if (!handler) return new Response("not found", { status: 404 });
    return handler(init);
  };
  return { fetcher, calls };
}

function memoryCache() {
  const store = new Map();
  return {
    store,
    async match(req) { return store.get(req.url)?.clone(); },
    async put(req, res) { store.set(req.url, res); },
  };
}

test("only allow-listed repositories in the fixed shapes are mirrored", () => {
  const allowed = parseAllowedRepos(REPO);
  const ok = [
    `https://api.github.com/repos/${REPO}/releases/latest`,
    `https://github.com/${REPO}/releases/latest/download/latest.json`,
    `https://github.com/${REPO}/releases/download/v0.8.701/Pi.Agent.LW_0.8.701_x64-setup.exe`,
    `https://github.com/${REPO}/archive/refs/tags/v0.8.701.tar.gz`,
    `https://github.com/HAO3039032/Pi-Agent-Desktop/archive/main.zip`,
  ];
  for (const url of ok) assert.ok(classifyTarget(new URL(url), allowed).kind, url);

  const refused = [
    "https://github.com/someone/else/releases/download/v1/a.zip",
    `https://github.com/${REPO}`,
    `https://github.com/${REPO}/blob/main/README.md`,
    `https://raw.githubusercontent.com/${REPO}/main/README.md`,
    `https://api.github.com/repos/${REPO}/releases`,
    `https://api.github.com/user`,
    `https://github.com/${REPO}/releases/download/v1/a.zip?x=1`,
    `https://github.com/${REPO}/releases/download/v1/..%2f..%2fx`,
    `https://github.com/${REPO}/releases/download/v1/sub/dir.zip`,
    `https://example.com/${REPO}/releases/download/v1/a.zip`,
    `https://github.com:8443/${REPO}/releases/download/v1/a.zip`,
  ];
  for (const url of refused) assert.ok(classifyTarget(new URL(url), allowed).error, url);
});

test("the ghproxy prefix form is parsed, including a collapsed double slash", () => {
  assert.equal(extractTarget(`${M}/https://github.com/a/b`)?.toString(), "https://github.com/a/b");
  assert.equal(extractTarget(`${M}/https:/github.com/a/b`)?.toString(), "https://github.com/a/b");
  assert.equal(extractTarget(`${M}/http://github.com/a/b`), null);
  assert.equal(extractTarget(`${M}/github.com/a/b`), null);
  assert.equal(extractTarget(`${M}/https://github.com/a/b?x=1`), null);
});

test("other repositories and methods are refused without touching GitHub", async () => {
  const { fetcher, calls } = fakeFetch({});
  const other = await handleRequest(new Request(`${M}/https://github.com/torvalds/linux/archive/master.zip`), env, { fetcher, cache: null });
  assert.equal(other.status, 403);
  const post = await handleRequest(new Request(`${M}/https://github.com/${REPO}/releases/latest/download/latest.json`, { method: "POST" }), env, { fetcher, cache: null });
  assert.equal(post.status, 405);
  assert.equal(calls.length, 0);
});

const API = `https://api.github.com/repos/${REPO}`;
function releaseJson(assets) {
  return () => new Response(JSON.stringify({ tag_name: "v1", assets }), { status: 200, headers: { "content-type": "application/json" } });
}

test("release assets are looked up through the API and downloaded from its asset endpoint", async () => {
  const asset = `https://github.com/${REPO}/releases/download/v1/app.exe`;
  const cdn = "https://release-assets.githubusercontent.com/signed?sig=abc";
  const { fetcher, calls } = fakeFetch({
    [`${API}/releases/tags/v1`]: releaseJson([{ name: "app.exe", url: `${API}/releases/assets/42` }]),
    [`${API}/releases/assets/42`]: () => new Response(null, { status: 302, headers: { location: cdn } }),
    [cdn]: () => new Response("bytes", { status: 206, headers: { "content-type": "application/octet-stream", "set-cookie": "x=1" } }),
  });
  const res = await handleRequest(
    new Request(`${M}/${asset}`, { headers: { range: "bytes=0-4", cookie: "secret=1", authorization: "Bearer leak" } }),
    { ...env, GITHUB_TOKEN: "t0ken" },
    { fetcher, cache: null },
  );
  assert.equal(res.status, 206);
  assert.equal(await res.text(), "bytes");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.deepEqual(calls.map((c) => c.url), [`${API}/releases/tags/v1`, `${API}/releases/assets/42`, cdn]);
  const [meta, download, bytes] = calls.map((c) => c.init.headers);
  assert.equal(meta.get("range"), null);
  assert.equal(download.get("accept"), "application/octet-stream");
  assert.equal(download.get("range"), "bytes=0-4");
  assert.equal(bytes.get("range"), "bytes=0-4");
  // The token goes to api.github.com only, never to the CDN redirect target.
  assert.equal(meta.get("authorization"), "Bearer t0ken");
  assert.equal(download.get("authorization"), "Bearer t0ken");
  assert.equal(bytes.get("authorization"), null);
  for (const headers of [meta, download, bytes]) assert.equal(headers.get("cookie"), null);
});

test("latest/download resolves through the latest release", async () => {
  const { fetcher, calls } = fakeFetch({
    [`${API}/releases/latest`]: releaseJson([{ name: "latest.json", url: `${API}/releases/assets/7` }]),
    [`${API}/releases/assets/7`]: () => new Response('{"version":"1"}', { status: 200 }),
  });
  const res = await handleRequest(new Request(`${M}/https://github.com/${REPO}/releases/latest/download/latest.json`), env, { fetcher, cache: memoryCache() });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"version":"1"}');
  assert.equal(calls.length, 2);
});

test("a missing asset is 404 and a foreign asset URL is refused", async () => {
  const missing = fakeFetch({ [`${API}/releases/tags/v1`]: releaseJson([]) });
  const res404 = await handleRequest(new Request(`${M}/https://github.com/${REPO}/releases/download/v1/nope.exe`), env, { fetcher: missing.fetcher, cache: null });
  assert.equal(res404.status, 404);

  const foreign = fakeFetch({
    [`${API}/releases/tags/v1`]: releaseJson([{ name: "app.exe", url: "https://api.github.com/repos/evil/repo/releases/assets/1" }]),
  });
  const res502 = await handleRequest(new Request(`${M}/https://github.com/${REPO}/releases/download/v1/app.exe`), env, { fetcher: foreign.fetcher, cache: null });
  assert.equal(res502.status, 502);
  assert.equal(foreign.calls.length, 1);
});

test("a redirect outside GitHub is refused", async () => {
  const { fetcher } = fakeFetch({
    [`${API}/releases/tags/v1`]: releaseJson([{ name: "app.exe", url: `${API}/releases/assets/42` }]),
    [`${API}/releases/assets/42`]: () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
  });
  const res = await handleRequest(new Request(`${M}/https://github.com/${REPO}/releases/download/v1/app.exe`), env, { fetcher, cache: null });
  assert.equal(res.status, 502);
});

test("source archives go straight to codeload", async () => {
  const codeload = `https://codeload.github.com/${REPO}/tar.gz/refs/tags/v0.8.701`;
  const { fetcher, calls } = fakeFetch({ [codeload]: () => new Response("tgz", { status: 200 }) });
  const res = await handleRequest(new Request(`${M}/https://github.com/${REPO}/archive/refs/tags/v0.8.701.tar.gz`), env, { fetcher, cache: null });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.map((c) => c.url), [codeload]);
});

test("the API check sends the token and is edge-cached", async () => {
  const api = `https://api.github.com/repos/${REPO}/releases/latest`;
  const { fetcher, calls } = fakeFetch({
    [api]: () => new Response('{"tag_name":"v1"}', { status: 200, headers: { "content-type": "application/json" } }),
  });
  const cache = memoryCache();
  const first = await handleRequest(new Request(`${M}/${api}`), { ...env, GITHUB_TOKEN: "t0ken" }, { fetcher, cache });
  assert.equal(first.status, 200);
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer t0ken");
  const second = await handleRequest(new Request(`${M}/${api}`), env, { fetcher, cache });
  assert.equal(await second.text(), '{"tag_name":"v1"}');
  assert.equal(calls.length, 1);
});

test("the optional rate limiter rejects with 429", async () => {
  const { fetcher } = fakeFetch({});
  const res = await handleRequest(
    new Request(`${M}/https://github.com/${REPO}/releases/latest/download/latest.json`),
    { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } },
    { fetcher, cache: null },
  );
  assert.equal(res.status, 429);
});
