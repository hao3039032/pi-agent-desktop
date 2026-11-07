"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ConfigButton, ConfigSwitch } from "@/components/SettingsUi";
import { ChatConfirmDialog } from "@/components/ChatConfirmDialog";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import {
  browserPasswordNative,
  getLanAccessNative,
  handleExternalLinkClick,
  isBrowserPasswordUsable,
  lanAddressesNative,
  setLanAccessNative,
  type BrowserPasswordStatus,
  type LanAddressStatus,
} from "@/lib/desktop-native";

/**
 * The "Allow network access" switch and the addresses it opens the server to.
 *
 * A usable browser password must exist before the switch can be turned on
 * (the sibling BrowserPasswordSection shares its status here); enabling
 * re-verifies with the server at the moment of confirmation. Without a
 * password the server refuses remote requests even when the preference is
 * already on, so that state is shown as paused rather than live.
 *
 * The switch is the stored preference; the server reads it only at startup, so
 * what is shown is the *running* server's answer (`lanListening`), never "now
 * reachable" for a toggle that still needs a full quit and restart. The URL
 * list comes from the local-only desktop route: real adapter addresses and the
 * port this server is bound to, not a guessed port or a client-side hostname.
 */
export function LanAccessSection({
  passwordStatus,
  onPasswordStatusChange,
}: {
  /** Browser-password state shared with BrowserPasswordSection; null/undefined = unknown, which fails closed. */
  passwordStatus?: BrowserPasswordStatus | null;
  onPasswordStatusChange?: (status: BrowserPasswordStatus | null) => void;
} = {}) {
  const { t } = useI18n();
  const statusId = useId();
  // null = not read yet; the switch stays disabled so a click cannot race the read.
  const [preference, setPreference] = useState<boolean | null>(null);
  const [prefError, setPrefError] = useState(false);
  const [lanStatus, setLanStatus] = useState<LanAddressStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  // The shared password status could not be read: fail closed, stay retryable.
  const [passwordError, setPasswordError] = useState(false);
  // One refresh counter for both reads, so one retry recovers either failure.
  const [refreshAttempt, setRefreshAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Set when the pre-enable password re-verification refused: the hint then
  // explains the prerequisite instead of a generic error.
  const [passwordBlocked, setPasswordBlocked] = useState(false);
  const onPasswordStatusChangeRef = useRef(onPasswordStatusChange);
  onPasswordStatusChangeRef.current = onPasswordStatusChange;

  // The shared status can be unknown (the sibling's read failed before this
  // mounted); re-read it with the same retry so one button recovers both.
  useEffect(() => {
    let cancelled = false;
    setPasswordError(false);
    browserPasswordNative()
      .then((status) => { if (!cancelled) onPasswordStatusChangeRef.current?.(status); })
      .catch(() => { if (!cancelled) setPasswordError(true); });
    return () => { cancelled = true; };
  }, [refreshAttempt]);

  useEffect(() => {
    let cancelled = false;
    setPrefError(false);
    getLanAccessNative()
      .then((enabled) => { if (!cancelled) setPreference(enabled); })
      .catch(() => { if (!cancelled) setPrefError(true); });
    return () => { cancelled = true; };
  }, [refreshAttempt]);

  useEffect(() => {
    let cancelled = false;
    setStatusError(false);
    lanAddressesNative()
      .then((data) => { if (!cancelled) setLanStatus(data); })
      .catch(() => { if (!cancelled) setStatusError(true); });
    return () => { cancelled = true; };
  }, [refreshAttempt]);

  const refresh = () => {
    setPasswordBlocked(false);
    setRefreshAttempt((value) => value + 1);
  };

  const save = async (next: boolean) => {
    setBusy(true);
    setSaveError(false);
    try {
      await setLanAccessNative(next);
      setPreference(next);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  // Enabling re-verifies the password with the server at the moment of
  // confirmation — never the sibling's input box or a stale shared status,
  // both of which can claim a password that is no longer there.
  const confirmEnable = async () => {
    setBusy(true);
    setSaveError(false);
    setPasswordBlocked(false);
    try {
      const check = await browserPasswordNative();
      onPasswordStatusChangeRef.current?.(check);
      if (!isBrowserPasswordUsable(check)) {
        setPasswordBlocked(true);
        return;
      }
      await setLanAccessNative(true);
      setPreference(true);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (next: boolean) => {
    setPasswordBlocked(false);
    // Enabling exposes the server; it asks first, through the shared in-app
    // dialog (Escape/focus stacking included), not an OS-native alert.
    if (next) {
      setConfirming(true);
      return;
    }
    void save(false);
  };

  const copyAddress = async (url: string) => {
    try {
      await copyText(url);
      setCopied(url);
      window.setTimeout(() => setCopied((current) => (current === url ? null : current)), 1500);
    } catch {
      // Nothing to add: the row keeps its address, so the user can still copy by hand.
    }
  };

  // Unknown while either read has not answered: never claim "pending" or
  // "off" from a missing answer — that is how the switch lied before.
  const listening = lanStatus?.lanListening === true;
  const passwordReady = isBrowserPasswordUsable(passwordStatus);
  const statusText = saveError || prefError
    ? t("appSettings.lanError")
    : passwordBlocked
      ? t("appSettings.lanNeedsPassword")
      : preference === null
        ? ""
        : statusError
          ? t("appSettings.lanStatusError")
          : lanStatus === null
            ? t("appSettings.lanStatusLoading")
            : !passwordReady
              ? t(preference ? "appSettings.lanPausedNoPassword" : "appSettings.lanNeedsPassword")
              : preference
                ? listening ? t("appSettings.lanActive") : t("appSettings.lanRestart")
                : listening ? t("appSettings.lanStillOpen") : t("appSettings.lanHint");

  const urls = preference === true && lanStatus?.port != null && lanStatus.addresses.length > 0
    ? lanStatus.addresses.map((entry) => ({
      url: `http://${entry.address}:${lanStatus.port}`,
      interface: entry.interface,
    }))
    : [];

  return (
    <div className="settings-option-list">
      <div className="settings-option">
        <span className="settings-option-text">
          <span className="settings-option-title">{t("appSettings.lanAccess")}</span>
          <span className="settings-option-hint" role="status" id={statusId}>{statusText}</span>
        </span>
        <ConfigSwitch
          checked={preference === true}
          // Turning the network off stays available without a password (it is
          // the safe direction); only enabling needs one.
          disabled={preference === null || busy || (!passwordReady && preference !== true)}
          label={t("appSettings.lanAccess")}
          describedBy={statusId}
          onChange={toggle}
        />
      </div>
      {/* Always visible, whatever the preference is: either read failing leaves
          the switch meaningless, so the retry must be reachable even when off. */}
      {(prefError || statusError || passwordError) && (
        <div className="lan-address-error" role="alert">
          <span>{t(prefError || passwordError ? "appSettings.lanError" : "appSettings.lanStatusError")}</span>
          <ConfigButton size="small" onClick={refresh}>
            {t("common.retry")}
          </ConfigButton>
        </div>
      )}
      {preference === true && passwordReady && (
        <div className="lan-address-block">
          <span className="settings-option-hint">
            {listening ? t("appSettings.lanAddresses") : lanStatus === null || statusError ? "" : t("appSettings.lanAddressesPending")}
          </span>
          {lanStatus === null || statusError ? null : lanStatus.port == null ? (
            <div className="lan-address-error" role="status">
              <span>{t("appSettings.lanPortUnknown")}</span>
              <ConfigButton size="small" onClick={refresh}>
                {t("common.retry")}
              </ConfigButton>
            </div>
          ) : urls.length === 0 ? (
            <div className="lan-address-error" role="status">
              <span>{t("appSettings.lanNoAddresses")}</span>
              <ConfigButton size="small" onClick={refresh}>
                {t("common.retry")}
              </ConfigButton>
            </div>
          ) : (
            <ul className="lan-address-list">
              {urls.map(({ url, interface: adapter }) => (
                <li key={`${adapter}\u0000${url}`} className="lan-address-row">
                  {/* The URL itself is the link (the whole point of the row); the
                      desktop opens it in the system browser. */}
                  <a
                    className="lan-address-url"
                    href={url}
                    onClick={(event) => handleExternalLinkClick(event, url)}
                  >
                    {url}
                  </a>
                  <span className="lan-address-adapter">{adapter}</span>
                  <ConfigButton
                    size="small"
                    className="lan-address-copy"
                    aria-label={t("appSettings.lanCopyAria", { url })}
                    onClick={() => void copyAddress(url)}
                  >
                    {copied === url ? t("i18n.copied") : t("i18n.copy")}
                  </ConfigButton>
                </li>
              ))}
            </ul>
          )}
          <span className="settings-option-hint">{t("appSettings.lanAddressCaveat")}</span>
        </div>
      )}
      {confirming && (
        <ChatConfirmDialog
          danger
          title={t("appSettings.lanConfirmTitle")}
          body={t("appSettings.lanConfirm")}
          confirmLabel={t("appSettings.lanConfirmAction")}
          cancelLabel={t("common.cancel")}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void confirmEnable();
          }}
        />
      )}
    </div>
  );
}
