"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "@/components/SettingsUi";
import { browserPasswordNative, confirmLanAccessNative, type BrowserPasswordStatus } from "@/lib/desktop-native";

export function BrowserPasswordSection() {
  const { t } = useI18n();
  const [status, setStatus] = useState<BrowserPasswordStatus | null>(null);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    browserPasswordNative().then((data) => { if (!cancelled) setStatus(data); })
      .catch(() => { if (!cancelled) setNote("browserPassword.error"); });
    return () => { cancelled = true; };
  }, [attempt]);

  const save = async (remove: boolean) => {
    setBusy(true);
    setNote("");
    try {
      if (remove && !await confirmLanAccessNative(t("browserPassword.removeConfirm"), t("browserPassword.title"))) return;
      const next = await browserPasswordNative(remove ? "DELETE" : "PUT", remove ? undefined : password);
      setStatus(next);
      setPassword("");
      setRepeat("");
      setNote(remove ? "browserPassword.removed" : "browserPassword.saved");
    } catch {
      setNote("browserPassword.error");
    } finally {
      setBusy(false);
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
          minLength={12} maxLength={1024} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <label className="remote-access-step">
        <span className="settings-option-hint">{t("browserPassword.repeat")}</span>
        <input className="mcp-add-input" type="password" autoComplete="new-password" value={repeat} disabled={busy}
          maxLength={1024} onChange={(event) => setRepeat(event.target.value)} />
      </label>
      <div className="settings-action-group">
        <ConfigButton disabled={busy || password.length < 12 || password !== repeat} onClick={() => void save(false)}>
          {t(status.enabled ? "browserPassword.reset" : "browserPassword.set")}
        </ConfigButton>
        {status.enabled && <ConfigButton disabled={busy} onClick={() => void save(true)}>{t("browserPassword.remove")}</ConfigButton>}
      </div>
    </>}
    {note && <p className="settings-option-hint" role="status">{t(note)}</p>}
    {!status && note && <ConfigButton onClick={() => { setNote(""); setAttempt((value) => value + 1); }}>{t("browserPassword.retry")}</ConfigButton>}
  </div>;
}
