"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigField } from "@/components/SettingsUi";
import { distroStrings } from "./strings";

export interface DistroServiceStatus {
  providerId: string;
  providerName: string;
  configured: boolean;
  baseUrl: string;
  hasApiKey: boolean;
  npmMirror: boolean;
}

const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  outline: "none",
};

export async function fetchDistroStatus(): Promise<DistroServiceStatus> {
  const response = await fetch("/api/distro", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as DistroServiceStatus;
}

export function DistroServiceForm({
  status,
  onSaved,
  secondaryAction,
}: {
  status: DistroServiceStatus;
  onSaved: (status: DistroServiceStatus) => void;
  secondaryAction?: React.ReactNode;
}) {
  const { locale } = useI18n();
  const s = distroStrings(locale);
  const [baseUrl, setBaseUrl] = useState(status.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [useNpmMirror, setUseNpmMirror] = useState(status.npmMirror);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  useEffect(() => setBaseUrl(status.baseUrl), [status.baseUrl]);
  useEffect(() => setUseNpmMirror(status.npmMirror), [status.npmMirror]);

  const canSave = !busy && baseUrl.trim() !== "" && (apiKey.trim() !== "" || status.hasApiKey);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/distro", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey, useNpmMirror }),
      });
      const data = (await response.json()) as DistroServiceStatus & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      setApiKey("");
      setMessage({ error: false, text: s.saved });
      onSaved(data);
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) void save();
      }}
    >
      <ConfigField label={s.baseUrl}>
        <input
          style={inputStyle}
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://"
          spellCheck={false}
          autoComplete="off"
        />
      </ConfigField>
      <ConfigField label={s.apiKey}>
        <input
          style={inputStyle}
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={status.hasApiKey ? s.apiKeyKeep : "sk-..."}
          spellCheck={false}
          autoComplete="off"
        />
      </ConfigField>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontSize: 12,
          color: "var(--text-muted)",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <input
          type="checkbox"
          checked={useNpmMirror}
          onChange={(event) => setUseNpmMirror(event.target.checked)}
        />
        {s.npmMirrorLabel}
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{ flex: 1, fontSize: 12, color: message?.error ? "var(--color-danger, #e5484d)" : "var(--text-muted)" }}
          role={message?.error ? "alert" : undefined}
        >
          {message?.text}
        </span>
        {secondaryAction}
        <button type="submit" hidden aria-hidden />
        <ConfigButton variant="primary" disabled={!canSave} onClick={() => void save()}>
          {busy ? s.saving : s.save}
        </ConfigButton>
      </div>
    </form>
  );
}
