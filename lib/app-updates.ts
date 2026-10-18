import type {
  AppComponentReleaseInfo,
  AppUpdateInfo,
  AppUpdateProjectId,
} from "@/lib/app-update-types";
import { APP_DISTRIBUTION_NAME, APP_REPOSITORY, APP_VERSION } from "./branding";

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

function parseRelease(project: AppUpdateProject, raw: GitHubRelease): AppComponentReleaseInfo {
  if (raw.draft === true || raw.prerelease === true) {
    throw new Error("GitHub returned a non-stable latest release.");
  }
  if (typeof raw.tag_name !== "string" || typeof raw.html_url !== "string") {
    throw new Error("GitHub returned an invalid release payload.");
  }

  const latest = parseVersion(raw.tag_name);
  const current = parseVersion(project.currentVersion);
  if (!latest || !current) throw new Error("GitHub returned an invalid release version.");

  const releaseUrl = new URL(raw.html_url);
  if (releaseUrl.protocol !== "https:" || releaseUrl.hostname !== "github.com") {
    throw new Error("GitHub returned an invalid release URL.");
  }

  return {
    project: project.id,
    name: project.name,
    repository: project.repository,
    repositoryUrl: repositoryUrl(project),
    currentVersion: current.display,
    latestVersion: latest.display,
    releaseUrl: releaseUrl.toString(),
    updateAvailable: compareAppVersions(latest.display, current.display) > 0,
    releaseStatus: "available",
  };
}

export async function getLatestAppRelease(
  project: AppUpdateProject,
  options: { fetcher?: Fetcher; timeoutMs?: number } = {},
): Promise<AppComponentReleaseInfo> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  try {
    return await fetchLatestFromApi(project, fetcher, timeoutMs);
  } catch (apiError) {
    // The API endpoint may simply be unreachable — api.github.com is blocked
    // or throttled on some networks while github.com itself resolves. Ask the
    // website where its "latest" release landed: the redirect target names
    // the tag without needing the API at all. (A definitive 404 never gets
    // here: fetchLatestFromApi answers it with an unpublished release
    // itself, so any error reaching this handler means the API call failed.)
    try {
      return await fetchLatestFromRedirect(project, fetcher, Math.min(timeoutMs, 10_000));
    } catch {
      throw apiError;
    }
  }
}

async function fetchLatestFromApi(
  project: AppUpdateProject,
  fetcher: Fetcher,
  timeoutMs: number,
): Promise<AppComponentReleaseInfo> {
  const response = await fetcher(
    `https://api.github.com/repos/${project.repository}/releases/latest`,
    {
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `pi-agent-desktop/${APP_VERSION}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (response.status === 404) return unpublishedRelease(project);
  if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}.`);
  return parseRelease(project, await response.json() as GitHubRelease);
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
  if (!location) throw new Error("GitHub did not redirect the latest-release URL.");

  const target = new URL(location, "https://github.com/");
  if (target.protocol !== "https:" || target.hostname !== "github.com") {
    throw new Error("GitHub redirected the latest-release URL to an unexpected target.");
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
    throw new Error("GitHub redirected the latest-release URL outside this repository.");
  }

  const tag = decodeURIComponent(pathname.slice(tagPath.length));
  const latest = parseVersion(tag);
  const current = parseVersion(project.currentVersion);
  if (!latest || !current) throw new Error(`GitHub redirected to an invalid release tag: ${tag}`);

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
