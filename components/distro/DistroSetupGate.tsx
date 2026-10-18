"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton } from "@/components/SettingsUi";
import { DistroServiceForm, fetchDistroStatus, type DistroServiceStatus } from "./DistroServiceForm";
import { distroStrings } from "./strings";

/**
 * First-run prompt for the service address and API key. Shown until the
 * distro provider is configured; "Later" hides it for the rest of this app run.
 */
export function DistroSetupGate() {
  const { locale } = useI18n();
  const s = distroStrings(locale);
  const [status, setStatus] = useState<DistroServiceStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchDistroStatus()
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { /* server not ready or route missing: stay hidden */ });
    return () => { cancelled = true; };
  }, []);

  if (!status || status.configured || dismissed) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={s.setupTitle}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        background: "rgba(0, 0, 0, 0.45)",
        padding: 16,
      }}
    >
      <div
        style={{
          width: "min(460px, 100%)",
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 18px 48px rgba(0, 0, 0, 0.3)",
          padding: "20px 22px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{s.setupTitle}</h2>
          <p style={{ margin: "6px 0 0", fontSize: 12, lineHeight: 1.5, color: "var(--text-muted)" }}>{s.setupIntro}</p>
        </div>
        <DistroServiceForm
          status={status}
          onSaved={setStatus}
          secondaryAction={<ConfigButton variant="ghost" onClick={() => setDismissed(true)}>{s.later}</ConfigButton>}
        />
      </div>
    </div>
  );
}
