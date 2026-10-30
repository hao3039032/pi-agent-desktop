import { APP_REPOSITORY } from "./branding";
import { mirrorGitHubUrl, resolveUpdateMirrors } from "./update-mirrors";

export type DesktopUpgradePhase = "checking" | "downloading" | "installing";

export interface DesktopUpgradeProgress {
  phase: DesktopUpgradePhase;
  downloadedBytes?: number;
  totalBytes?: number;
  targetVersion?: string;
}

export interface DesktopUpgradeResult {
  installed: boolean;
  targetVersion?: string;
  /** Present when the upgrade failed: a mirror-prefixed release page URL. */
  mirrorReleaseUrl?: string;
}

/** Error thrown when the updater could not reach any endpoint or download. */
export class DesktopUpgradeNetworkError extends Error {
  /** Mirror-prefixed release page for manual download, when a mirror is configured. */
  readonly mirrorReleaseUrl: string | null;
  constructor(message: string, mirrorReleaseUrl: string | null) {
    super(message);
    this.name = "DesktopUpgradeNetworkError";
    this.mirrorReleaseUrl = mirrorReleaseUrl;
  }
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}
export async function installLatestDesktopRelease(
  onProgress: (progress: DesktopUpgradeProgress) => void,
): Promise<DesktopUpgradeResult> {
  if (!isTauriDesktop()) {
    throw new Error("Automatic installation is only available in the packaged desktop app.");
  }

  // The updater's endpoints (direct github.com first, then the accelerator
  // mirrors baked in at build time) are tried in order by the plugin itself.
  // When even that fails — or the installer download fails on a network where
  // github.com is unreachable — surface a mirror-prefixed release page so the
  // user can fetch the signed installer manually. The Tauri signature check
  // happens inside the installer flow, independent of which host served it.
  const [{ check }, { relaunch }] = await Promise.all([
    import("@tauri-apps/plugin-updater"),
    import("@tauri-apps/plugin-process"),
  ]);
  let update;
  try {
    update = await check({ timeout: 30_000 });
  } catch (error) {
    throw toNetworkError(error);
  }
  if (!update) return { installed: false };

  let downloadedBytes = 0;
  let totalBytes: number | undefined;
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength;
        onProgress({
          phase: "downloading",
          downloadedBytes,
          totalBytes,
          targetVersion: update.version,
        });
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        onProgress({
          phase: "downloading",
          downloadedBytes,
          totalBytes,
          targetVersion: update.version,
        });
      } else {
        onProgress({ phase: "installing", targetVersion: update.version });
      }
    });
  } catch (error) {
    throw toNetworkError(error, update.version);
  }

  onProgress({ phase: "installing", targetVersion: update.version });
  await relaunch();
  return { installed: true, targetVersion: update.version };
}

function toNetworkError(error: unknown, version?: string): DesktopUpgradeNetworkError {
  const message = error instanceof Error ? error.message : String(error);
  const mirror = mirrorReleasePageUrl(version);
  return new DesktopUpgradeNetworkError(message, mirror);
}

/** First configured mirror's view of this fork's releases page, or null. */
export function mirrorReleasePageUrl(version?: string | null): string | null {
  if (typeof window === "undefined") return null;
  const [mirror] = resolveUpdateMirrors();
  if (!mirror) return null;
  const base = `https://github.com/${APP_REPOSITORY}/releases`;
  const target = version ? `${base}/tag/v${version.replace(/^v/, "")}` : `${base}/latest`;
  return mirrorGitHubUrl(target, mirror);
}
