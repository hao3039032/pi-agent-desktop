"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "@/components/SettingsUi";
import { ChatConfirmDialog } from "@/components/ChatConfirmDialog";
import { browserPasswordNative, type BrowserPasswordStatus } from "@/lib/desktop-native";

/** Mirrors the server's rule (lib/browser-password.ts); the route rejects anything else. */
const MIN_BROWSER_PASSWORD_LENGTH = 12;

/**
 * Reports every password status this section learns (initial read, save,
 * remove) so a parent can gate the network-access switch on it. null = unknown.
 */
export function BrowserPasswordSection({
  onStatusChange,
}: { onStatusChange?: (status: BrowserPasswordStatus | null) => void } = {}) {
  const { t } = useI18n();
  const validationId = useId();
  const [status, setStatus] = useState<BrowserPasswordStatus | null>(null);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [pending, setPending] = useState<"save" | "remove" | null>(null);
  const [note, setNote] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Reported through a ref so reporting never re-runs the read effect.
  const reportRef = useRef(onStatusChange);
  reportRef.current = onStatusChange;

  useEffect(() => {
    let cancelled = false;
    browserPasswordNative().then((data) => {
      if (cancelled) return;
      setStatus(data);
      reportRef.current?.(data);
    })
      .catch(() => { if (!cancelled) setNote("browserPassword.error"); });
    return () => { cancelled = true; };
  }, [attempt]);

  // Live validation: the save button never goes quietly grey. The reasons are
  // shown in the form (and read out), not only enforced by the disabled state.
  const tooShort = password.length > 0 && password.length < MIN_BROWSER_PASSWORD_LENGTH;
  const mismatch = repeat.length > 0 && password !== repeat;
  const matches = password.length >= MIN_BROWSER_PASSWORD_LENGTH && password === repeat;
  const validation = tooShort
    ? t("browserPassword.tooShort", { count: password.length, min: MIN_BROWSER_PASSWORD_LENGTH })
    : password.length >= MIN_BROWSER_PASSWORD_LENGTH && repeat.length === 0
      ? t("browserPassword.needRepeat")
      : mismatch
        ? t("browserPassword.mismatch")
        : matches
          ? t("browserPassword.matches")
          : "";

  const busy = pending !== null;

  const save = async (remove: boolean) => {
    setPending(remove ? "remove" : "save");
    setNote("");
    try {
      const next = await browserPasswordNative(remove ? "DELETE" : "PUT", remove ? undefined : password);
      setStatus(next);
      reportRef.current?.(next);
      setPassword("");
      setRepeat("");
      setNote(remove ? "browserPassword.removed" : "browserPassword.saved");
    } catch {
      setNote("browserPassword.error");
    } finally {
      setPending(null);
    }
  };

  return <div className="settings-option-list">
    <div className="settings-option">
      <span className="settings-option-text">
        <span className="settings-option-title">{t("browserPassword.title")}</span>
        <span className="settings-option-hint">{t("browserPassword.hint")}</span>
        <span className="settings-option-hint" role="status">
          {status ? t(status.managed ? "browserPassword.managed" : status.corrupt ? "browserPassword.corrupt" : status.enabled ? "browserPassword.on" : "browserPassword.off") : t("browserPassword.loading")}
        </span>
      </span>
    </div>
    {status && !status.managed && <>
      <label className="remote-access-step">
        <span className="settings-option-hint">{t("browserPassword.new")}</span>
        <input className="mcp-add-input" type="password" autoComplete="new-password" value={password} disabled={busy}
          minLength={MIN_BROWSER_PASSWORD_LENGTH} maxLength={1024} aria-invalid={tooShort || undefined}
          aria-describedby={validation ? validationId : undefined}
          onChange={(event) => setPassword(event.target.value)} />
      </label>
      <label className="remote-access-step">
        <span className="settings-option-hint">{t("browserPassword.repeat")}</span>
        <input className="mcp-add-input" type="password" autoComplete="new-password" value={repeat} disabled={busy}
          maxLength={1024} aria-invalid={mismatch || undefined}
          aria-describedby={validation ? validationId : undefined}
          onChange={(event) => setRepeat(event.target.value)} />
      </label>
      {validation && <p className="settings-option-hint" id={validationId} role="status">{validation}</p>}
      <div className="settings-action-group">
        <ConfigButton disabled={busy || !matches} aria-busy={busy || undefined} onClick={() => void save(false)}>
          {pending === "save" ? t("browserPassword.saving") : t(status.enabled ? "browserPassword.reset" : "browserPassword.set")}
        </ConfigButton>
        {status.enabled && (
          <ConfigButton disabled={busy} aria-busy={busy || undefined} onClick={() => setConfirmRemove(true)}>
            {pending === "remove" ? t("browserPassword.removing") : t("browserPassword.remove")}
          </ConfigButton>
        )}
      </div>
    </>}
    {note && <p className="settings-option-hint" role="status">{t(note)}</p>}
    {!status && note && <ConfigButton onClick={() => { setNote(""); setAttempt((value) => value + 1); }}>{t("browserPassword.retry")}</ConfigButton>}
    {confirmRemove && (
      <ChatConfirmDialog
        danger
        title={t("browserPassword.removeTitle")}
        body={t("browserPassword.removeConfirm")}
        confirmLabel={t("browserPassword.remove")}
        cancelLabel={t("common.cancel")}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          void save(true);
        }}
      />
    )}
  </div>;
}
