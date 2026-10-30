import type {
  AppComponentReleaseInfo,
  AppUpdateInfo,
  AppUpdateProjectId,
} from "@/lib/app-update-types";
import { APP_DISTRIBUTION_NAME, APP_REPOSITORY, APP_VERSION } from "./branding";
import { mirrorGitHubUrl } from "./update-mirrors";
import { resolveUpdateMirrors } from "./update-mirrors-server";

export const APP_UPDATE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const APP_UPDATE_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface AppUpdateProject {
  id: AppUpdateProjectId;
  name: string;
  repository: `${string}/${string}`;
  currentVersion: string;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

interface ParsedVersion {
  display: string;
  core: [number, number, number];
  prerelease: string[];
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const APP_UPDATE_PROJECTS: readonly AppUpdateProject[] = [
  {
    id: "pi-agent-desktop",
    name: APP_DISTRIBUTION_NAME,
    repository: APP_REPOSITORY,
    currentVersion: APP_VERSION,
  },
];

function parseVersion(value: string): ParsedVersion | null {
  const display = value.trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(display);
  if (!match) return null;

  return {
    display,
    core: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }

  return 0;
}

export function compareAppVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Invalid version comparison: ${left} / ${right}`);

  for (let index = 0; index < a.core.length; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function isAppUpdateDue(lastCheckedAt: number | undefined, now: number): boolean {
  return !Number.isFinite(lastCheckedAt)
    || now - (lastCheckedAt as number) >= APP_UPDATE_CHECK_INTERVAL_MS
    || now < (lastCheckedAt as number);
}

export function getNextAppUpdateCheckAt(
  lastCheckedAt: Partial<Record<AppUpdateProjectId, number>>,
  now: number,
): number {
  return Math.min(...APP_UPDATE_PROJECTS.map((project) => {
    const checkedAt = lastCheckedAt[project.id];
    return Number.isFinite(checkedAt)
      ? Math.max(now, (checkedAt as number) + APP_UPDATE_CHECK_INTERVAL_MS)
      : now;
  }));
}

function repositoryUrl(project: AppUpdateProject): string {
  return `https://github.com/${project.repository}`;
}

export function getUnknownAppReleaseInfo(project: AppUpdateProject): AppComponentReleaseInfo {
  return {
    project: project.id,
    name: project.name,
    repository: project.repository,
    repositoryUrl: repositoryUrl(project),
    currentVersion: parseVersion(project.currentVersion)?.display ?? project.currentVersion,
    latestVersion: null,
    releaseUrl: null,
    updateAvailable: false,
    releaseStatus: "unknown",
  };
}

function unpublishedRelease(project: AppUpdateProject): AppComponentReleaseInfo {
  return {
    ...getUnknownAppReleaseInfo(project),
    releaseStatus: "unpublished",
  };
}

/**
 * The release page this repository would publish for `tag`, or null when the
 * URL is any other page — including another repository's.
 *
 * A host check alone is not enough: release metadata may now arrive through a
 * mirror, and "an update is available, click here" pointing at an arbitrary
 * github.com page is exactly the phishing shape we must refuse.
 */
function repositoryReleaseUrl(project: AppUpdateProject, raw: string, tag: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
  if (url.username || url.password || url.port || url.search || url.hash) return null;
  const expectedPath = `/${project.repository}/releases/tag/${encodeURIComponent(tag)}`;
  return url.pathname.replace(/\/+$/, "") === expectedPath ? url.toString() : null;
}

function parseRelease(project: AppUpdateProject, raw: GitHubRelease): AppComponentReleaseInfo {
  if (raw.draft === true || raw.prerelease === true) {
    throw new AppUpdatePayloadError("GitHub returned a non-stable latest release.");
  }
  if (typeof raw.tag_name !== "string" || typeof raw.html_url !== "string") {
    throw new AppUpdatePayloadError("GitHub returned an invalid release payload.");
  }

  const latest = parseVersion(raw.tag_name);
  const current = parseVersion(project.currentVersion);
  if (!latest || !current) throw new AppUpdatePayloadError("GitHub returned an invalid release version.");

  const releaseUrl = repositoryReleaseUrl(project, raw.html_url, raw.tag_name);
  if (!releaseUrl) throw new AppUpdatePayloadError("GitHub returned an invalid release URL.");

  return {
    project: project.id,
    name: project.name,
    repository: project.repository,
    repositoryUrl: repositoryUrl(project),
    currentVersion: current.display,
    latestVersion: latest.display,
    releaseUrl,
    updateAvailable: compareAppVersions(latest.display, current.display) > 0,
    releaseStatus: "available",
  };
}

/**
 * Why a metadata request produced no release. The distinction matters: only
 * the canonical GitHub API may answer "this repository has no release yet",
 * and only transport failures are worth trying against another mirror.
 */
export class AppUpdateTransportError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "AppUpdateTransportError";
    this.status = status;
  }
}

/** A mirror (or GitHub) answered with something that is not this release. */
export class AppUpdatePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppUpdatePayloadError";
  }
}

const LATEST_API_PATH = "/releases/latest";

function canonicalApiUrl(project: AppUpdateProject): string {
  return `https://api.github.com/repos/${project.repository}${LATEST_API_PATH}`;
}

/**
 * Whether `url` is this repository's own GitHub API release URL — the only
 * place a 404 may be read as "no release yet".
 */
function isCanonicalApiUrl(project: AppUpdateProject, url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:"
      && parsed.hostname === "api.github.com"
      && parsed.pathname === `/repos/${project.repository}${LATEST_API_PATH}`
      && parsed.search === "";
  } catch {
    return false;
  }
}

export async function getLatestAppRelease(
  project: AppUpdateProject,
  options: {
    fetcher?: Fetcher;
    timeoutMs?: number;
    mirrors?: readonly string[];
    /** Ceiling for the whole check, all sources included. */
    deadlineMs?: number;
  } = {},
): Promise<AppComponentReleaseInfo> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  // Every attempt shares one budget: a black-holed network must not hold the
  // settings dialog open for 15s × (1 direct + 1 redirect probe + N mirrors).
  const deadline = Date.now() + (options.deadlineMs ?? 45_000);
  const remaining = () => Math.max(0, deadline - Date.now());
  const attemptTimeout = Math.min(timeoutMs, remaining());

  try {
    return await fetchLatestFromApi(project, canonicalApiUrl(project), { fetcher, timeoutMs: attemptTimeout });
  } catch (apiError) {
    if (!(apiError instanceof AppUpdateTransportError)) throw apiError;
    // api.github.com is blocked or throttled on some networks while
    // github.com resolves. Ask the website where "latest" landed: the redirect
    // names the tag without the API.
    try {
      return await fetchLatestFromRedirect(project, fetcher, Math.min(10_000, remaining()));
    } catch {
      // Probe failed; mirrors below get the remaining budget.
    }

    const mirrors = options.mirrors ?? resolveUpdateMirrors();
    let payloadError: Error | undefined;
    for (const mirror of mirrors) {
      if (remaining() <= 0) break;
      try {
        return await fetchLatestFromApi(
          project,
          mirrorGitHubUrl(canonicalApiUrl(project), mirror),
          { fetcher, timeoutMs: Math.min(timeoutMs, remaining()), mirror },
        );
      } catch (error) {
        if (error instanceof AppUpdatePayloadError) {
          // This mirror answered with something that is not the release we
          // asked about. Remember it (it outranks the network error) but let a
          // working mirror still answer — a broken mirror is not a verdict
          // about the update.
          payloadError ??= error;
          continue;
        }
        // Transport-level failure (unreachable, timeout, 403/404 from a
        // file-only mirror): next candidate.
      }
    }
    throw payloadError ?? apiError;
  }
}

async function fetchLatestFromApi(
  project: AppUpdateProject,
  url: string,
  { fetcher, timeoutMs, mirror }: { fetcher: Fetcher; timeoutMs: number; mirror?: string },
): Promise<AppComponentReleaseInfo> {
  if (timeoutMs <= 0) throw new AppUpdateTransportError("The update check ran out of time.");
  let response: Response;
  try {
    response = await fetcher(url, {
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `pi-agent-desktop/${APP_VERSION}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AppUpdateTransportError(mirror ? `${mirror}: ${reason}` : reason);
  }
  // Only the repository's own API URL may say "no release yet". A mirror
  // answering 404 simply cannot serve this endpoint, and treating that as an
  // authoritative "unpublished" would let a third party hide real updates for
  // a whole check interval.
  if (response.status === 404) {
    if (isCanonicalApiUrl(project, url)) return unpublishedRelease(project);
    throw new AppUpdateTransportError(`${mirror ?? url}: HTTP 404`, 404);
  }
  if (!response.ok) {
    throw new AppUpdateTransportError(`${mirror ?? url}: HTTP ${response.status}`, response.status);
  }
  let payload: GitHubRelease;
  try {
    payload = await response.json() as GitHubRelease;
  } catch {
    // A mirror that answers 200 with an HTML error page is not serving the
    // API; that is a broken mirror, not a release.
    throw new AppUpdateTransportError(`${mirror ?? url}: response was not JSON`);
  }
  return parseRelease(project, payload);
}

/**
 * Fallback for networks where api.github.com is unreachable but github.com
 * works: `GET /<repo>/releases/latest` answers 302 to the newest stable
 * release's tag page (drafts and prereleases are skipped, same as the API),
 * or to the plain releases list when there is no stable release yet. The
 * redirect has to stay inside this repository's tag pages; any other target
 * is a failed probe, not an answer.
 */
async function fetchLatestFromRedirect(
  project: AppUpdateProject,
  fetcher: Fetcher,
  timeoutMs: number,
): Promise<AppComponentReleaseInfo> {
  const response = await fetcher(`https://github.com/${project.repository}/releases/latest`, {
    redirect: "manual",
    cache: "no-store",
    headers: { "User-Agent": `pi-agent-desktop/${APP_VERSION}` },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const location = response.headers.get("location");
  if (!location) throw new AppUpdateTransportError("GitHub did not redirect the latest-release URL.");

  const target = new URL(location, "https://github.com/");
  if (target.protocol !== "https:" || target.hostname !== "github.com") {
    throw new AppUpdateTransportError("GitHub redirected the latest-release URL to an unexpected target.");
  }

  // The redirect must land inside this repository: only its own tag page
  // names the release that was asked about. The plain releases list still
  // means there is no stable release yet; any other target — another
  // repository, a non-release page — is a failed probe, so the caller keeps
  // the original API error instead of an "unpublished" answer.
  const pathname = target.pathname.replace(/\/+$/, "");
  const releasesPath = `/${project.repository}/releases`;
  const tagPath = `${releasesPath}/tag/`;
  if (pathname === releasesPath) return unpublishedRelease(project);
  if (!pathname.startsWith(tagPath)) {
    throw new AppUpdateTransportError("GitHub redirected the latest-release URL outside this repository.");
  }

  const tag = decodeURIComponent(pathname.slice(tagPath.length));
  const latest = parseVersion(tag);
  const current = parseVersion(project.currentVersion);
  if (!latest || !current) throw new AppUpdateTransportError(`GitHub redirected to an invalid release tag: ${tag}`);

  const releaseUrl = `https://github.com/${project.repository}/releases/tag/${encodeURIComponent(tag)}`;
  return {
    project: project.id,
    name: project.name,
    repository: project.repository,
    repositoryUrl: repositoryUrl(project),
    currentVersion: current.display,
    latestVersion: latest.display,
    releaseUrl,
    updateAvailable: compareAppVersions(latest.display, current.display) > 0,
    releaseStatus: "available",
  };
}

export async function checkAppUpdate(
  project: AppUpdateProject,
  options: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<AppUpdateInfo | null> {
  const release = await getLatestAppRelease(project, options);
  if (!release.updateAvailable || !release.latestVersion || !release.releaseUrl) return null;
  return {
    project: release.project,
    name: release.name,
    currentVersion: release.currentVersion,
    latestVersion: release.latestVersion,
    releaseUrl: release.releaseUrl,
  };
}
