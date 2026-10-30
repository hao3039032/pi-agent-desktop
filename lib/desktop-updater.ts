/**
 * Desktop auto-update driver.
 *
 * The webview never supplies a download URL, mirror list, signature or target:
 * it asks the shell to install whatever update it finds, and the shell
 * (`src-tauri/src/update_install.rs`) checks, downloads — direct first, then
 * through the mirrors compiled in from `distro/distro.json` — verifies the
 * minisign signature and installs. That keeps the trust boundary in Rust and
 * keeps this file to progress reporting and error translation.
 */

export type DesktopUpgradePhase = "checking" | "downloading" | "installing";

export interface DesktopUpgradeProgress {
  phase: DesktopUpgradePhase;
  downloadedBytes?: number;
  totalBytes?: number;
  targetVersion?: string;
  /** `github.com` for the canonical asset, otherwise the mirror serving it. */
  sourceHost?: string;
}

export interface DesktopUpgradeResult {
  installed: boolean;
  targetVersion?: string;
  sourceHost?: string;
}

/**
 * `transport` is a network verdict and may succeed later — every configured
 * source failed. `manifest` means the update metadata itself could not be read
 * (an HTML error page, a truncated answer). The rest are verdicts about the
 * update itself: `signature` a verification failure (never retried, never
 * installed), `unavailable` a build or platform that cannot update, `install` a
 * local installation failure, `busy` a second concurrent attempt.
 */
export type DesktopUpgradeFailureKind =
  | "transport"
  | "manifest"
  | "signature"
  | "unavailable"
  | "install"
  | "busy"
  | "other";

export class DesktopUpgradeError extends Error {
  readonly kind: DesktopUpgradeFailureKind;
  /** Hosts the shell actually tried, `github.com` first. */
  readonly attemptedHosts: readonly string[];

  constructor(kind: DesktopUpgradeFailureKind, message: string, attemptedHosts: readonly string[] = []) {
    super(message);
    this.name = "DesktopUpgradeError";
    this.kind = kind;
    this.attemptedHosts = attemptedHosts;
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

interface NativeProgress {
  phase: string;
  sourceHost: string;
  downloadedBytes: number;
  totalBytes?: number;
  targetVersion: string;
}

interface NativeOutcome {
  installed: boolean;
  targetVersion?: string;
  sourceHost?: string;
}

interface NativeFailure {
  kind?: unknown;
  message?: unknown;
  attemptedHosts?: unknown;
}

const FAILURE_KINDS = new Set<DesktopUpgradeFailureKind>([
  "transport",
  "manifest",
  "signature",
  "unavailable",
  "install",
  "busy",
  "other",
]);

/**
 * Translate the shell's structured failure into a typed error.
 *
 * The distinction is load-bearing: `transport` means every source failed to
 * reach the network (retrying later may work), while `signature` and `install`
 * are verdicts about this update and must keep the shell's own wording.
 */
export function toDesktopUpgradeError(error: unknown): DesktopUpgradeError {
  if (error instanceof DesktopUpgradeError) return error;
  if (error && typeof error === "object") {
    const failure = error as NativeFailure;
    const kind = typeof failure.kind === "string" && FAILURE_KINDS.has(failure.kind as DesktopUpgradeFailureKind)
      ? failure.kind as DesktopUpgradeFailureKind
      : "other";
    const message = typeof failure.message === "string" && failure.message
      ? failure.message
      : "The update could not be installed.";
    const hosts = Array.isArray(failure.attemptedHosts)
      ? failure.attemptedHosts.filter((host): host is string => typeof host === "string")
      : [];
    return new DesktopUpgradeError(kind, message, hosts);
  }
  return new DesktopUpgradeError("other", error instanceof Error ? error.message : String(error));
}

export async function installLatestDesktopRelease(
  onProgress: (progress: DesktopUpgradeProgress) => void,
): Promise<DesktopUpgradeResult> {
  if (!isTauriDesktop()) {
    throw new DesktopUpgradeError(
      "unavailable",
      "Automatic installation is only available in the packaged desktop app.",
    );
  }

  // Arm the busy state before the first await. The native check can take a
  // while on a slow network, and until it reports back the button must already
  // be disabled and the settings dialog must already be held open.
  onProgress({ phase: "checking" });

  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);

  const unlisten = await listen<NativeProgress>("pi-update-progress", (event) => {
    const payload = event.payload;
    onProgress({
      phase: payload.phase === "installing" ? "installing" : "downloading",
      downloadedBytes: payload.downloadedBytes,
      totalBytes: payload.totalBytes,
      targetVersion: payload.targetVersion,
      sourceHost: payload.sourceHost,
    });
  });

  try {
    const outcome = await invoke<NativeOutcome>("install_available_update");
    if (!outcome.installed) return { installed: false };

    onProgress({
      phase: "installing",
      targetVersion: outcome.targetVersion,
      sourceHost: outcome.sourceHost,
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    return {
      installed: true,
      targetVersion: outcome.targetVersion,
      sourceHost: outcome.sourceHost,
    };
  } catch (error) {
    throw toDesktopUpgradeError(error);
  } finally {
    await unlisten();
  }
}
