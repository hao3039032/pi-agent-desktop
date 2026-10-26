type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  prompt: string | null;
  /**
   * Which truth `prompt` is: "recorded" (replayed from the system messages
   * this session's file records — the SDK's own transcript replay, not a
   * live reading of what a provider received), "configured" (an exact
   * prompt fixed when the session started), "none" (no record yet — only the
   * base configuration exists) or "unknown" (no get_state answered yet).
   * See lib/system-prompt-snapshot.ts for the honesty contract.
   */
  status?: "recorded" | "configured" | "none" | "unknown";
  translate: Translate;
}

export function SystemPromptPanel({ loading, prompt, status, translate }: Props) {
  const notRecorded = status === "none";
  return (
    <section className="system-prompt-panel" aria-label={translate("system.prompt")}>
      <div className="system-prompt-scroll">
        {prompt ? (
          <>
            <div className="system-prompt-heading">{status === "configured" ? translate("system.configuredHeading") : translate("system.recordedHeading")}</div>
            <div className="system-prompt-text">{prompt}</div>
            <div className="system-prompt-note">
              {status === "configured" ? translate("system.noteConfigured") : translate("system.noteRecorded")}
            </div>
          </>
        ) : (
          <div className="system-prompt-empty">
            {loading
              ? translate("system.loading")
              : status === "unknown"
                ? translate("system.unavailable")
                : notRecorded
              ? translate("system.notSent")
              : prompt === ""
                ? translate("system.empty")
                : loading
                  ? translate("system.loading")
                  : translate("system.load")}
            {notRecorded && <div className="system-prompt-note">{translate("system.noteNotSent")}</div>}
          </div>
        )}
      </div>

      <style>{`
        .system-prompt-panel {
          display: flex;
          height: min(600px, 75dvh);
          min-height: 220px;
          flex-direction: column;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
        }
        .system-prompt-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 12px 16px;
        }
        .system-prompt-heading {
          color: var(--text);
          font-size: 12px;
          font-weight: 600;
          margin-bottom: 8px;
        }
        .system-prompt-text {
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.6;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }
        .system-prompt-note {
          color: var(--text-dim);
          font-size: 11px;
          line-height: 1.5;
          margin-top: 10px;
        }
        .system-prompt-empty {
          padding: 10px 0;
          color: var(--text-muted);
          font-size: 12px;
          font-style: italic;
        }
      `}</style>
    </section>
  );
}
