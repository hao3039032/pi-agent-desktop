"use client";

import { useEffect, useId, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { fetchArtifactsSettings, saveArtifactsSettings } from "@/lib/artifact-settings-service";
import { ConfigSwitch } from "./SettingsUi";

/**
 * Settings › General › Chat: whether sessions tell the model it can answer
 * with artifacts. Rendering `:::artifact` blocks does not depend on it.
 */
export function ArtifactsSettingRow() {
  const { t } = useI18n();
  const hintId = useId();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchArtifactsSettings()
      .then((data) => {
        if (!cancelled) setEnabled(data.enabled);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    setFailed(false);
    saveArtifactsSettings(next)
      .then((data) => setEnabled(data.enabled))
      .catch(() => {
        setEnabled(previous);
        setFailed(true);
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="settings-chat-option settings-chat-switch-option artifacts-setting-row">
      <span className="artifacts-setting-text">
        <span>{t("settings.artifacts")}</span>
        <span id={hintId} className="artifacts-setting-hint">
          {failed ? t("settings.artifactsFailed") : t("settings.artifactsHint")}
        </span>
      </span>
      <ConfigSwitch
        checked={enabled ?? true}
        loading={enabled === null || saving}
        label={t("settings.artifacts")}
        describedBy={hintId}
        onChange={update}
      />
    </div>
  );
}
