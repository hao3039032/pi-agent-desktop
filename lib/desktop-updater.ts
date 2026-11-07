/**
 * Desktop auto-update driver.
 *
 * The webview never supplies a download URL, mirror list, signature or target.
 * It may name one of the download routes the shell compiled in (`auto`,
 * `direct`, or a mirror from `distro/distro.json`): the shell re-validates the
 * id against its own whitelist, rejects anything else, and then checks,
 * downloads over that route, verifies the minisign signature and installs.
 * That keeps the trust boundary in Rust and keeps this file to progress
 * reporting, route listing and error translation.
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

/** One download route the shell compiled in, for the Settings picker. */
export interface DesktopUpdateSource {
  /** `auto`, `direct` or `mirror:<host>` — opaque to the page beyond echoing it back. */
  id: string;
  kind: "auto" | "direct" | "mirror";
  /** The mirror origin, present for `mirror` entries. */
  host?: string;
}

export const DEFAULT_UPDATE_SOURCE_ID = "auto";

/**
 * `transport` is a network verdict and may succeed later — every configured
 * source failed. `manifest` means the update metadata itself could not be read
 * (an HTML error page, a truncated answer). `source` means the route id the
 * page named is not one this build compiled in. The rest are verdicts about
 * the update itself: `signature` a verification failure (never retried, never
 * installed), `unavailable` a build or platform that cannot update, `install`
 * a local installation failure, `busy` a second concurrent attempt.
 */
export type DesktopUpgradeFailureKind =
  | "transport"
  | "manifest"
  | "source"
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
  "source",
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

/** Keep only well-formed route entries; the shell re-validates every id. */
export function toDesktopUpdateSources(raw: unknown): DesktopUpdateSource[] {
  if (!Array.isArray(raw)) return [];
  const kinds = new Set(["auto", "direct", "mirror"] as const);
  const sources: DesktopUpdateSource[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { id?: unknown; kind?: unknown; host?: unknown };
    if (typeof candidate.id !== "string" || !candidate.id) continue;
    if (typeof candidate.kind !== "string" || !kinds.has(candidate.kind as "auto" | "direct" | "mirror")) continue;
    // A mirror without its host cannot be labelled or matched later, so it is
    // not a choice at all rather than a broken one.
    if (candidate.kind === "mirror" && typeof candidate.host !== "string") continue;
    sources.push({
      id: candidate.id,
      kind: candidate.kind as DesktopUpdateSource["kind"],
      ...(candidate.kind === "mirror" && typeof candidate.host === "string" ? { host: candidate.host } : {}),
    });
  }
  return sources;
}

/** The saved id when this build still knows it, otherwise the automatic route. */
export function resolveDesktopUpdateSourceId(
  saved: string | null | undefined,
  sources: readonly DesktopUpdateSource[],
): string {
  return saved && sources.some((source) => source.id === saved)
    ? saved
    : DEFAULT_UPDATE_SOURCE_ID;
}

/**
 * The download routes this build's shell compiled in, for the Settings picker.
 * Empty in a browser (nothing to route there) or when this build cannot
 * install updates; a native failure rejects so the UI can offer a retry.
 */
export async function listDesktopUpdateSources(): Promise<DesktopUpdateSource[]> {
  if (!isTauriDesktop()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return toDesktopUpdateSources(await invoke<unknown>("list_update_sources"));
}

export async function installLatestDesktopRelease(
  onProgress: (progress: DesktopUpgradeProgress) => void,
  options: { sourceId?: string } = {},
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
    // The payload is exactly one route id from the shell's own list; the
    // shell re-validates it and never accepts a URL, host, signature or target.
    const outcome = await invoke<NativeOutcome>("install_available_update", {
      source: options.sourceId ?? DEFAULT_UPDATE_SOURCE_ID,
    });
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
