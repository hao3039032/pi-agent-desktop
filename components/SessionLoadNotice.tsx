"use client";

import { useI18n } from "@/hooks/useI18n";
import type { SessionLoadPhase } from "@/lib/session-load";

/** Opening failures and background synchronization are different UI states.
 * Raw HTTP/RPC errors belong in opt-in diagnostics, never in place of a chat.
 */
export function SessionLoadNotice({ phase, error, hasContent, stale = false, onRetry }: {
  phase: SessionLoadPhase;
  error: string | null;
  hasContent: boolean;
  stale?: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const failed = phase === "failed";
  if (!failed && phase === "ready") return null;
  if (hasContent && !stale && phase === "opening") return null;
  const title = failed
    ? hasContent ? t("chat.sessionSyncFailed") : t("chat.sessionOpenFailed")
    : hasContent ? t("chat.sessionSyncing") : t("chat.sessionOpening");
  const detail = failed
    ? hasContent ? t("chat.sessionKeptContent") : t("chat.sessionOpenRetryHint")
    : phase === "retrying" ? t("chat.sessionRetrying")
      : phase === "slow" ? t("chat.sessionOpeningSlow")
        : hasContent ? t("chat.sessionCachedContent") : null;
  return (
    <section className={`session-load-notice${hasContent ? " is-inline" : " is-opening"}`} aria-busy={!failed}>
      <div role="status" aria-live="polite">
        <div className="session-load-title">{title}</div>
        {detail && <p>{detail}</p>}
      </div>
      {failed && <button type="button" className="session-load-retry" onClick={onRetry}>
        {hasContent ? t("chat.sessionRetrySync") : t("chat.sessionReopen")}
      </button>}
      {failed && error && <details className="session-load-diagnostics">
        <summary>{t("chat.sessionDiagnostics")}</summary>
        <pre>{error}</pre>
      </details>}
    </section>
  );
}
