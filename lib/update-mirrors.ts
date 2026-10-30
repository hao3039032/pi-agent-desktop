/**
 * Public ghproxy-style download accelerators for GitHub.
 *
 * The convention these mirrors share is a URL prefix:
 *
 *   https://<mirror>/https://github.com/owner/repo/releases/download/...
 *
 * Two different callers use it for two different legs of an update:
 * - this repository's server (`/api/updates`) mirrors the release-metadata
 *   request so the version notice survives a network where github.com is
 *   blocked;
 * - the desktop shell mirrors the installer download (see
 *   `src-tauri/src/update_install.rs`).
 *
 * Which mirrors are configured is decided in ONE place, `distro/distro.json`'s
 * `updateMirrors`, and resolved per runtime:
 * - the shell bakes the list in at release time (`PI_AGENT_DESKTOP_UPDATE_MIRRORS`);
 * - the server reads the same file (see `lib/update-mirrors-server.ts`) unless
 *   `PI_UPDATE_MIRRORS` overrides it.
 *
 * Nothing here trusts a mirror's answer. Metadata still goes through
 * `parseRelease`, and installed bytes are always verified against the Tauri
 * updater's minisign key, so a mirror can slow down or deny an update but
 * cannot change what gets installed.
 */

/**
 * Hosts are `host` or `host:port`; a value can never become a path or URL.
 *
 * The same rules live in `scripts/distro-build-config.mjs` (which throws) and
 * `src-tauri/src/update_install.rs` (which filters). Tests on all three sides
 * use the same accept/reject list, so a value the release build accepts cannot
 * be silently dropped by the shell.
 */
export function isMirrorHost(value: string): boolean {
  if (!value || value.length > 253) return false;
  const separator = value.lastIndexOf(":");
  const name = separator === -1 ? value : value.slice(0, separator);
  const port = separator === -1 ? undefined : value.slice(separator + 1);
  if (!name || name.length > 253) return false;
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port)) return false;
    const number = Number(port);
    if (number < 1 || number > 65535) return false;
  }
  const labels = name.split(".");
  // A single label would resolve through a search domain.
  if (labels.length < 2) return false;
  return labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9-]+$/i.test(label)
    && !label.startsWith("-")
    && !label.endsWith("-")
  ));
}

/** The retry budget the shell also enforces. */
export const MAX_UPDATE_MIRRORS = 3;

/** Comma- or whitespace-separated hosts, lowercased, de-duplicated and capped. */
export function parseMirrorList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const hosts: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const host = normalizeMirrorHost(part);
    if (host && !hosts.includes(host)) hosts.push(host);
    if (hosts.length === MAX_UPDATE_MIRRORS) break;
  }
  return hosts;
}

/** `https://gh-proxy.com/` -> `gh-proxy.com`; anything not a host -> null. */
export function normalizeMirrorHost(value: string): string | null {
  const host = value.trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return isMirrorHost(host) ? host : null;
}

const MIRRORABLE_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
]);

/**
 * Prefix a GitHub URL with a mirror origin, e.g.
 * `mirrorGitHubUrl("https://api.github.com/repos/o/r/releases/latest", "gh-proxy.com")`
 *   -> `https://gh-proxy.com/https://api.github.com/repos/o/r/releases/latest`
 *
 * Anything that is not an https GitHub URL is returned unchanged: mirroring an
 * arbitrary host would turn a URL-handling bug into an open forwarder.
 */
export function mirrorGitHubUrl(url: string, mirrorHost: string): string {
  const host = normalizeMirrorHost(mirrorHost);
  if (!host) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "https:" || !MIRRORABLE_HOSTS.has(parsed.hostname)) return url;
  return `https://${host}/${parsed.toString()}`;
}

/** True when `mirrorGitHubUrl` would rewrite this URL. */
export function isMirrorableGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && MIRRORABLE_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}
