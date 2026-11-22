/**
 * A ghproxy-compatible GitHub mirror that serves ONLY allow-listed repositories.
 *
 * URL shape (the same one `lib/update-mirrors.ts` and
 * `src-tauri/src/update_install.rs` already build):
 *
 *   https://<this-host>/https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
 *
 * What is proxied, per allow-listed repository — nothing else:
 *   - api.github.com/repos/<repo>/releases/latest        (update check, JSON)
 *   - github.com/<repo>/releases/latest/download/<file>  (latest.json manifest)
 *   - github.com/<repo>/releases/download/<tag>/<file>   (installers, signatures)
 *   - github.com/<repo>/archive/<ref>.zip|.tar.gz        (source archives)
 *
 * Release assets and latest.json are NOT fetched from github.com: GitHub
 * answers Cloudflare's shared egress IPs with HTTP 429. The asset is looked up
 * in the (edge-cached) release JSON and downloaded from the API's asset
 * endpoint instead, which with GITHUB_TOKEN has a per-token quota.
 *
 * Abuse resistance:
 *   - fixed path patterns + repository allow-list, so it is not an open proxy;
 *   - GET/HEAD only, no client cookies/credentials forwarded upstream;
 *   - redirects are followed here, and only to GitHub's own download hosts;
 *   - the optional GITHUB_TOKEN is sent to api.github.com only, never to a
 *     redirect target;
 *   - metadata is edge-cached briefly, so a flood of update checks does not
 *     become a flood of GitHub API calls;
 *   - an optional per-IP rate limiter (RATE_LIMITER binding).
 *
 * Nothing here is trusted by the app: release metadata is re-validated and
 * installers are minisign-verified, so this mirror can only slow down or deny
 * an update, never change what gets installed.
 */

const DEFAULT_REPOS = "hao3039032/pi-agent-desktop";
const MAX_REDIRECTS = 5;
const METADATA_TTL_SECONDS = 300;
const USER_AGENT = "pi-agent-desktop-mirror";

/** Hosts a request may be redirected to while following a download. */
const REDIRECT_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

/** One path segment of a tag, ref or asset file name. */
const SEGMENT = "[A-Za-z0-9._+~-]+";
const REPO_PART = "[A-Za-z0-9._-]+";

const REPO = `(${REPO_PART}/${REPO_PART})`;

/**
 * The allowed shapes. `resolve` turns a match into the upstream plan:
 *   - `{ url }`: fetch this URL (redirects followed within GitHub);
 *   - `{ release, asset }`: look the asset up through the API, then download
 *     it from the API's asset endpoint. github.com rate-limits Cloudflare's
 *     shared egress IPs (HTTP 429), the token-authenticated API does not.
 */
const ROUTES = [
  {
    kind: "metadata",
    host: "api.github.com",
    pattern: new RegExp(`^/repos/${REPO}/releases/latest$`),
    resolve: (m) => ({ url: `https://api.github.com/repos/${m[1]}/releases/latest` }),
  },
  {
    kind: "metadata",
    host: "github.com",
    pattern: new RegExp(`^/${REPO}/releases/latest/download/(${SEGMENT})$`),
    resolve: (m) => ({ release: `https://api.github.com/repos/${m[1]}/releases/latest`, asset: m[2] }),
  },
  {
    kind: "asset",
    host: "github.com",
    pattern: new RegExp(`^/${REPO}/releases/download/(${SEGMENT})/(${SEGMENT})$`),
    resolve: (m) => ({
      release: `https://api.github.com/repos/${m[1]}/releases/tags/${m[2]}`,
      asset: m[3],
    }),
  },
  {
    kind: "asset",
    host: "github.com",
    pattern: new RegExp(`^/${REPO}/archive/((?:refs/(?:heads|tags)/)?${SEGMENT})\\.(zip|tar\\.gz)$`),
    resolve: (m) => ({ url: `https://codeload.github.com/${m[1]}/${m[3]}/${m[2]}` }),
  },
];

/** Response headers worth passing back to the client. */
const PASS_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "content-disposition",
  "accept-ranges",
  "etag",
  "last-modified",
];

/** `"a/b, C/d"` -> Set{"a/b", "c/d"} (GitHub names are case-insensitive). */
export function parseAllowedRepos(raw) {
  const repos = new Set();
  for (const part of String(raw ?? "").split(/[\s,]+/)) {
    const repo = part.trim().toLowerCase();
    if (new RegExp(`^${REPO_PART}/${REPO_PART}$`).test(repo)) repos.add(repo);
  }
  return repos;
}

/**
 * The GitHub URL a mirror request names, or null. Accepts the ghproxy form
 * `/https://github.com/...`, tolerating a proxy that collapsed `//` to `/`.
 */
export function extractTarget(requestUrl) {
  const url = new URL(requestUrl);
  if (url.search) return null;
  const match = /^\/https:\/+(.+)$/i.exec(url.pathname);
  if (!match) return null;
  try {
    return new URL(`https://${match[1]}`);
  } catch {
    return null;
  }
}

/**
 * Whether `target` is one of the allowed shapes for an allowed repository.
 * Returns `{ kind }` or a refusal reason.
 */
export function classifyTarget(target, allowedRepos) {
  if (!target) return { error: "not a mirror URL" };
  if (target.protocol !== "https:" || target.port || target.username || target.password) {
    return { error: "unsupported URL" };
  }
  if (target.search || target.hash) return { error: "query strings are not allowed" };
  if (/%2f|%5c|%2e/i.test(target.pathname) || target.pathname.includes("..")) {
    return { error: "encoded or relative paths are not allowed" };
  }
  for (const route of ROUTES) {
    if (target.hostname !== route.host) continue;
    const match = route.pattern.exec(target.pathname);
    if (!match) continue;
    if (!allowedRepos.has(match[1].toLowerCase())) return { error: "repository is not allowed" };
    return { kind: route.kind, ...route.resolve(match) };
  }
  return { error: "path is not allowed" };
}

function textResponse(status, message, extra = {}) {
  return new Response(`${message}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

function upstreamHeaders(request, url, env, apiAccept = "application/vnd.github+json") {
  const headers = new Headers({ "user-agent": USER_AGENT });
  if (url.hostname === "api.github.com") {
    headers.set("accept", apiAccept);
    headers.set("x-github-api-version", "2022-11-28");
    if (env.GITHUB_TOKEN) headers.set("authorization", `Bearer ${env.GITHUB_TOKEN}`);
  } else {
    headers.set("accept", "*/*");
  }
  // Resumable downloads; nothing else from the client goes upstream.
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  return headers;
}

/** Fetch `target`, following redirects only within GitHub's own hosts. */
async function fetchUpstream(request, target, env, fetcher, apiAccept) {
  let url = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetcher(url.toString(), {
      method: request.method,
      headers: upstreamHeaders(request, url, env, apiAccept),
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    let next;
    try {
      next = new URL(location, url);
    } catch {
      return textResponse(502, "upstream sent an invalid redirect");
    }
    if (next.protocol !== "https:" || !REDIRECT_HOSTS.has(next.hostname)) {
      return textResponse(502, "upstream redirected outside GitHub");
    }
    url = next;
  }
  return textResponse(502, "too many upstream redirects");
}

/**
 * The API download URL of release asset `name`, from the (edge-cached)
 * release JSON. Returns `{ url }` or `{ status, message }`.
 */
async function findReleaseAsset(releaseUrl, name, env, fetcher, cache, ctx) {
  const cacheKey = cache ? new Request(`https://mirror-cache.invalid/release/${releaseUrl}`) : null;
  let body = null;
  if (cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) body = await hit.text();
  }
  if (body === null) {
    const url = new URL(releaseUrl);
    const response = await fetcher(releaseUrl, {
      method: "GET",
      headers: upstreamHeaders(new Request("https://mirror.invalid/"), url, env),
    });
    if (response.status === 404) return { status: 404, message: "release not found" };
    if (!response.ok) return { status: 502, message: `GitHub API answered HTTP ${response.status}` };
    body = await response.text();
    if (cacheKey) {
      const store = cache.put(cacheKey, new Response(body, {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${METADATA_TTL_SECONDS}` },
      }));
      if (ctx?.waitUntil) ctx.waitUntil(store);
      else await store;
    }
  }
  let release;
  try {
    release = JSON.parse(body);
  } catch {
    return { status: 502, message: "GitHub API answered with invalid JSON" };
  }
  const asset = Array.isArray(release?.assets) ? release.assets.find((item) => item?.name === name) : null;
  if (!asset) return { status: 404, message: "asset not found" };
  // The asset URL must be this repository's API asset endpoint.
  const expected = `${releaseUrl.replace(/\/releases\/.*$/, "")}/releases/assets/`;
  if (typeof asset.url !== "string" || !asset.url.startsWith(expected) || !/^\d+$/.test(asset.url.slice(expected.length))) {
    return { status: 502, message: "GitHub API answered with an unexpected asset URL" };
  }
  return { url: asset.url };
}

function clientResponse(upstream, kind) {
  const headers = new Headers();
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "cache-control",
    upstream.ok
      ? (kind === "metadata" ? `public, max-age=${METADATA_TTL_SECONDS}` : "public, max-age=3600")
      : "no-store",
  );
  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * The request handler, with its I/O injectable for tests.
 * `deps.fetcher` defaults to fetch, `deps.cache` to the edge cache.
 */
export async function handleRequest(request, env = {}, deps = {}) {
  const fetcher = deps.fetcher ?? fetch;
  const cache = deps.cache === undefined ? globalThis.caches?.default : deps.cache;
  const ctx = deps.ctx;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse(405, "method not allowed", { allow: "GET, HEAD" });
  }

  const url = new URL(request.url);
  if (url.pathname === "/" || url.pathname === "/robots.txt") {
    return textResponse(200, url.pathname === "/" ? "pi-agent-desktop release mirror" : "User-agent: *\nDisallow: /");
  }

  if (env.RATE_LIMITER) {
    const key = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key });
    if (!success) return textResponse(429, "too many requests", { "retry-after": "60" });
  }

  const target = extractTarget(request.url);
  const verdict = classifyTarget(target, parseAllowedRepos(env.ALLOWED_REPOS ?? DEFAULT_REPOS));
  if (verdict.error) return textResponse(403, `forbidden: ${verdict.error}`);

  // Short edge cache for metadata only (update checks are frequent, tiny and
  // shared by every user). Installers stream straight through.
  const cacheable = verdict.kind === "metadata" && request.method === "GET" && !request.headers.has("range") && cache;
  const cacheKey = cacheable ? new Request(`https://mirror-cache.invalid/${target.toString()}`) : null;
  if (cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  let upstream;
  try {
    if (verdict.release) {
      const found = await findReleaseAsset(verdict.release, verdict.asset, env, fetcher, cache, ctx);
      if (!found.url) return textResponse(found.status, found.message);
      upstream = await fetchUpstream(request, new URL(found.url), env, fetcher, "application/octet-stream");
    } else {
      upstream = await fetchUpstream(request, new URL(verdict.url), env, fetcher);
    }
  } catch {
    return textResponse(502, "upstream unreachable");
  }
  const response = clientResponse(upstream, verdict.kind);
  if (cacheKey && response.status === 200) {
    const store = cache.put(cacheKey, response.clone());
    if (ctx?.waitUntil) ctx.waitUntil(store);
    else await store;
  }
  return response;
}

const worker = {
  fetch(request, env, ctx) {
    return handleRequest(request, env, { ctx });
  },
};

export default worker;
