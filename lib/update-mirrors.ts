/**
 * Public ghproxy-style download accelerators for GitHub, used as fallbacks
 * when github.com / api.github.com are unreachable (common on mainland-China
 * networks). The mirror convention is a URL prefix:
 *
 *   https://<mirror>/https://github.com/owner/repo/releases/download/...
 *
 * Mirrors are tried in order after the direct connection fails. None of them
 * is trusted: responses still pass the same validation as the direct answer
 * (parseRelease / parseUpdaterManifest), and the installer itself is verified
 * by the Tauri updater minisign signature regardless of which host served it.
 *
 * The list is deliberately small and curated; public mirrors die regularly
 * (measured 2026-10: several well-known ones already time out). The first two
 * below also proxy api.github.com JSON, which the update CHECK needs; the
 * third serves release files only and simply fails the API attempt.
 *
 * Override or clear with PI_UPDATE_MIRRORS="host1,host2" (comma/space
 * separated hosts or full origins; empty string disables all fallbacks).
 */

/** Hosts in try order. Must serve the `https://<mirror>/<full-url>` form. */
export const DEFAULT_UPDATE_MIRRORS: readonly string[] = [
  "gh-proxy.com",
  "ghproxy.cn",
  "ghfast.top",
];

export function resolveUpdateMirrors(env: Record<string, string | undefined> = {}): readonly string[] {
  const raw = env.PI_UPDATE_MIRRORS;
  if (raw === undefined) return DEFAULT_UPDATE_MIRRORS;
  return raw.split(/[\s,]+/)
    .map((host) => host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, ""))
    .filter(Boolean);
}

const GITHUB_HOSTS = new Set(["github.com", "api.github.com", "objects.githubusercontent.com", "codeload.github.com", "raw.githubusercontent.com"]);

/**
 * Prefix a github.com URL with a mirror origin, e.g.
 * mirrorGitHubUrl("https://api.github.com/repos/o/r/releases/latest", "gh-proxy.com")
 *   -> "https://gh-proxy.com/https://api.github.com/repos/o/r/releases/latest"
 *
 * Non-GitHub or non-https URLs are returned unchanged — a mirror that would
 * proxy arbitrary hosts turns any URL-handling bug into an open redirect.
 */
export function mirrorGitHubUrl(url: string, mirrorHost: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "https:" || !GITHUB_HOSTS.has(parsed.hostname)) return url;
  const host = mirrorHost.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host || !/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return url;
  return `https://${host}/${parsed.toString()}`;
}

/** True when the URL is one this module would be willing to mirror. */
export function isMirrorableGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && GITHUB_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}
