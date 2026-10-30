"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppComponentReleaseInfo, AppUpdatesResponse } from "@/lib/app-update-types";
import {
  APP_DISTRIBUTION_NAME,
  APP_RELEASES_URL,
  APP_VERSION,
  APP_VERSION_DISPLAY,
} from "@/lib/branding";
import { handleExternalLinkClick } from "@/lib/desktop-native";
import { DesktopUpgradeError, installLatestDesktopRelease, type DesktopUpgradeProgress } from "@/lib/desktop-updater";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "./SettingsUi";

interface Props {
  /** Lets the host settings dialog stay up while a signed update is installing. */
  onBusyChange?: (busy: boolean) => void;
}

/**
 * "Version & Updates" for the packaged desktop distribution.
 *
 * Lives at the top of the General settings tab: the update check is the one
 * piece of the old standalone app-info panel a user actually comes back for,
 * and General is where the rest of the app-wide preferences already sit.
 */
export function AppUpdatesSection({ onBusyChange }: Props) {
  const { t } = useI18n();
  const [components, setComponents] = useState<AppComponentReleaseInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [upgradeProgress, setUpgradeProgress] = useState<DesktopUpgradeProgress | null>(null);
  const [upgradeError, setUpgradeError] = useState<{ text: string; kind: DesktopUpgradeError["kind"] } | null>(null);
  const upgradeInFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/updates?refresh=1", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<AppUpdatesResponse>;
      })
      .then((data) => {
        setComponents(Array.isArray(data.components) ? data.components : []);
        setLoadError(null);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError("checkFailed");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const busy = Boolean(upgradeProgress);
  useEffect(() => {
    onBusyChange?.(busy);
    return () => {
      if (busy) onBusyChange?.(false);
    };
  }, [busy, onBusyChange]);

  const appRelease = useMemo(
    () => components.find((component) => component.project === "pi-agent-desktop"),
    [components],
  );
  const updateAvailable = useMemo(
    () => components.some((component) => component.updateAvailable),
    [components],
  );
  const canUpgrade = !loading && updateAvailable && !upgradeProgress;
  // A mirror serving the installer is worth naming: it explains both the
  // switched source and why the progress bar restarted at that switch.
  const downloadSource = upgradeProgress?.phase === "downloading"
    && upgradeProgress.sourceHost
    && upgradeProgress.sourceHost !== "github.com"
    ? upgradeProgress.sourceHost
    : null;
  const downloadPercent = upgradeProgress?.phase === "downloading" && upgradeProgress.totalBytes
    ? Math.min(100, Math.round((upgradeProgress.downloadedBytes ?? 0) / upgradeProgress.totalBytes * 100))
    : null;
  const upgradeLabel = upgradeProgress?.phase === "checking"
    ? t("appSettings.preparing")
    : upgradeProgress?.phase === "downloading"
      ? (downloadPercent === null
        ? t("appSettings.downloading")
        : t("appSettings.downloadingPercent", { percent: downloadPercent }))
      : upgradeProgress?.phase === "installing"
        ? t("appSettings.installing")
        : t("appSettings.update");

  const latestReleaseText = loading
    ? "…"
    : loadError
      ? t("appSettings.checkFailed")
      : !appRelease || appRelease.releaseStatus === "unknown"
        ? t("appSettings.releaseUnavailable")
        : appRelease.releaseStatus === "error"
          ? t("appSettings.checkFailed")
          : appRelease.releaseStatus === "unpublished" || !appRelease.latestVersion
            ? t("appSettings.noReleases")
            : `v${appRelease.latestVersion}`;

  const statusText = loading
    ? t("appSettings.checkingReleases")
    : loadError || appRelease?.releaseStatus === "error"
      ? t("appSettings.checkFailed")
      : updateAvailable
        ? t("appSettings.updateAvailable")
        : t("appSettings.upToDate");

  const currentVersion = appRelease?.currentVersion ?? APP_VERSION;
  const currentVersionText = `v${currentVersion === APP_VERSION ? APP_VERSION_DISPLAY : currentVersion}`;
  const releaseUrl = appRelease?.releaseUrl ?? null;
  const releaseHref = releaseUrl ?? APP_RELEASES_URL;
  const hasLatest = !loading && !loadError && Boolean(appRelease?.latestVersion)
    && appRelease?.releaseStatus !== "unknown" && appRelease?.releaseStatus !== "unpublished";

  const handleUpgrade = async () => {
    // The ref closes the same-tick window the render state cannot: a second
    // click can land before `upgradeProgress` has been committed.
    if (!canUpgrade || upgradeInFlight.current) return;
    upgradeInFlight.current = true;
    setUpgradeError(null);
    try {
      const result = await installLatestDesktopRelease(setUpgradeProgress);
      if (!result.installed) {
        setUpgradeProgress(null);
        setUpgradeError({ text: t("appSettings.noSignedBundle", { name: APP_DISTRIBUTION_NAME }), kind: "other" });
      }
    } catch (error) {
      setUpgradeProgress(null);
      if (error instanceof DesktopUpgradeError) {
        // Keep the shell's own wording: a signature or install failure is a
        // verdict about this update, and replacing it with a generic sentence
        // would hide exactly the detail a user has to act on.
        const hosts = error.attemptedHosts.join(", ") || "GitHub";
        setUpgradeError({
          text: error.kind === "transport"
            ? t("appSettings.updateDownloadUnreachable", { hosts })
            : error.kind === "manifest"
              ? t("appSettings.updateManifestUnreadable", { hosts })
              : error.message,
          kind: error.kind,
        });
      } else {
        setUpgradeError({ text: error instanceof Error ? error.message : String(error), kind: "other" });
      }
    } finally {
      upgradeInFlight.current = false;
    }
  };

  return (
    <section className="settings-general-section settings-updates">
      <h3 className="settings-general-heading">{t("appSettings.updatesSection")}</h3>
      <div className="settings-update-card">
        <dl className="settings-update-versions">
          <div className="settings-update-row">
            <dt>{t("appSettings.currentVersion")}</dt>
            <dd>{currentVersionText}</dd>
          </div>
          <div className="settings-update-row">
            <dt>{t("appSettings.latestRelease")}</dt>
            <dd className={updateAvailable ? "is-latest" : undefined}>
              {!hasLatest ? (
                latestReleaseText
              ) : (
                <a
                  href={releaseHref}
                  target="_blank"
                  rel="noreferrer"
                  title={t("appSettings.openRelease")}
                  onClick={(event) => handleExternalLinkClick(event, releaseHref)}
                >
                  {latestReleaseText} <span aria-hidden="true">↗</span>
                </a>
              )}
              {updateAvailable && <span className="settings-update-badge">{t("appSettings.upgradeAvailable")}</span>}
            </dd>
          </div>
        </dl>
        <div className="settings-update-side">
          <span className="settings-update-status" role="status">{statusText}</span>
          {(updateAvailable || upgradeProgress) && (
            <ConfigButton
              variant="primary"
              disabled={!canUpgrade}
              title={downloadSource ? t("appSettings.updateSource", { host: downloadSource }) : undefined}
              onClick={() => void handleUpgrade()}
            >
              {upgradeLabel}
            </ConfigButton>
          )}
        </div>
      </div>
      {updateAvailable && (
        <p className="settings-general-description settings-updates-note">
          {t("appSettings.updateNote", { name: APP_DISTRIBUTION_NAME })}
        </p>
      )}
      {upgradeError && (
        <p role="alert" className="settings-general-error">
          {upgradeError.text}
          {releaseUrl && (
            <a
              className="settings-updates-release-link"
              href={releaseUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => handleExternalLinkClick(event, releaseUrl)}
            >
              {t("appSettings.openRelease")}
            </a>
          )}
        </p>
      )}
    </section>
  );
}
