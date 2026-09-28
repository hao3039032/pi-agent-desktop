"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { DistroServiceForm, fetchDistroStatus, type DistroServiceStatus } from "./DistroServiceForm";
import { distroStrings } from "./strings";

/** Settings → General: change the service address / API key later. */
export function DistroSettingsSection() {
  const { locale } = useI18n();
  const s = distroStrings(locale);
  const [status, setStatus] = useState<DistroServiceStatus | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchDistroStatus()
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{s.sectionTitle}</h3>
      <p className="settings-general-description">{s.sectionHint}</p>
      {status && <DistroServiceForm status={status} onSaved={setStatus} />}
      {error && <p className="settings-general-description">{s.loadError}</p>}
    </section>
  );
}
