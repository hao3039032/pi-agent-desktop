"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AppSelect } from "./AppSelect";
import type {
  PiSubagentRunRow,
  PiSubagentsStatusView,
  PiSubagentsUnavailable,
} from "@/lib/pi-subagents-view";

/**
 * Expanded content of pi-subagents' composer widget tag. Async run rows and
 * the separate display-only fleet summary share the four actions the restricted API
 * allows (`app/api/agent/[id]/subagents`). Built-in sub-agent sessions have
 * their own surface (AgentSessionPanel); this panel is package runs only.
 */

const POLL_INTERVAL_MS = 2_500;

/** A stop of a row that carries a child identity needs one extra click. */
type PendingStop = { row: PiSubagentRunRow } | null;

interface InspectState {
  runId: string;
  text: string;
  truncated: boolean;
  loading: boolean;
}

type SteerState = { row: PiSubagentRunRow; message: string; mode: "steer" | "follow_up" | "auto" } | null;

interface Props {
  sessionId: string;
}

function statusDotClass(status: PiSubagentRunRow["status"]): string {
  if (status === "running" || status === "queued") return " is-running";
  if (status === "complete") return " is-complete";
  if (status === "failed") return " is-failed";
  if (status === "stopped" || status === "rejected") return " is-stopped";
  if (status === "paused" || status === "partial") return " is-paused";
  return "";
}

function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
  return String(total);
}

function formatElapsed(startedAt: number | undefined, endedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return "";
  const end = endedAt ?? now;
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

export function SubagentFleetPanel({ sessionId }: Props) {
  const { t } = useI18n();
  const [view, setView] = useState<PiSubagentsStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingStop, setPendingStop] = useState<PendingStop>(null);
  const [inspect, setInspect] = useState<InspectState | null>(null);
  const [steer, setSteer] = useState<SteerState>(null);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef<AbortController | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const id = ++requestId.current;
    const controller = inFlight.current;
    if (!controller || controller.signal.aborted) return;
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/subagents`, {
        cache: "no-store",
        signal: signal ?? controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as PiSubagentsStatusView;
      if (id !== requestId.current || controller.signal.aborted) return;
      setView(data);
      setError(null);
    } catch (cause) {
      if (id !== requestId.current || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId]);

  // Set up cancellation before the first poll, including Strict Mode's remount.
  // Collapsing the tag or changing session cancels reads and action receipts.
  useEffect(() => {
    const controller = new AbortController();
    inFlight.current = controller;
    setView(null);
    setError(null);
    setActionError(null);
    setBusy(null);
    setPendingStop(null);
    setInspect(null);
    setSteer(null);
    return () => {
      controller.abort();
      requestId.current += 1;
    };
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      setNow(Date.now());
      await refresh();
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [refresh]);

  const runAction = useCallback(async (action: string, body: Record<string, unknown>) => {
    const controller = inFlight.current;
    if (!controller || controller.signal.aborted) return null;
    setBusy(action);
    setActionError(null);
    let succeeded = false;
    try {
      const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/subagents`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json() as { error?: string; reason?: string };
      if (controller.signal.aborted) return null;
      if (!response.ok || data.error) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      succeeded = true;
      return data;
    } catch (cause) {
      if (!controller.signal.aborted) setActionError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      if (!controller.signal.aborted) setBusy(null);
      // A successful action changes the run state, so refresh instead of leaving
      // stale rows until the next poll tick. Safe because the controller above
      // lives for the whole mount (only unmount/session change aborts it) and the
      // monotonic requestId drops an out-of-order reply.
      if (succeeded) void refresh();
    }
  }, [sessionId, refresh]);

  const openInspect = useCallback(async (row: PiSubagentRunRow) => {
    if (!row.runId) return;
    const runId = row.runId;
    setPendingStop(null);
    setSteer(null);
    setInspect({ runId, text: "", truncated: false, loading: true });
    const data = await runAction("inspect", { action: "inspect", runId });
    setInspect((current) => current && current.runId === runId
      ? {
        runId,
        text: (data as { view?: { text?: string } } | null)?.view?.text ?? "",
        truncated: (data as { view?: { truncated?: boolean } } | null)?.view?.truncated === true,
        loading: false,
      }
      : current);
  }, [runAction]);

  const unavailableReasonText = useCallback((reason: PiSubagentsUnavailable["reason"]): string => {
    switch (reason) {
      case "chat-workspace": return t("subagentFleet.unavailable.chat");
      case "not-loaded": return t("subagentFleet.unavailable.notLoaded");
      case "no-bus": return t("subagentFleet.unavailable.noBus");
      case "unknown": return t("subagentFleet.unavailable.unknown");
      case "unresponsive": return t("subagentFleet.unavailable.unresponsive");
      case "incompatible": return t("subagentFleet.unavailable.incompatible");
      case "session-closed": return t("subagentFleet.unavailable.closed");
      case "status-failed": return t("subagentFleet.unavailable.statusFailed");
      default: return t("subagentFleet.unavailable.generic");
    }
  }, [t]);

  const snapshot = view?.available === true ? view : null;
  const unavailable = view !== null && view.available === false ? view : null;
  const fleetEntries = snapshot?.fleetSummary?.entries ?? [];
  const rows = useMemo(() => snapshot?.runs ?? [], [snapshot]);

  return (
    <div className="subagent-fleet-panel">
      <div className="subagent-fleet-body">
        {!view && !error && <div role="status">{t("subagentFleet.loading")}</div>}
        {error && (
          <div className="subagent-fleet-notice" role="alert">
            <span>{t("subagentFleet.loadFailed")}</span>
            <small>{error}</small>
          </div>
        )}
        {unavailable && (
          <div className="subagent-fleet-unavailable">
            <p>{unavailableReasonText(unavailable.reason)}</p>
            {unavailable.error && <small>{unavailable.error}</small>}
          </div>
        )}
        {snapshot && (
          <>
            <div className="subagent-fleet-summary">
              <span>{t("subagentFleet.activeCount", { count: String(snapshot.activeCount) })}</span>

              <small>{new Date(snapshot.generatedAt).toLocaleTimeString()}</small>
            </div>

            {rows.length === 0 && fleetEntries.length === 0 && (
              <div className="subagent-fleet-empty">{t("subagentFleet.noRuns")}</div>
            )}

            <ul className="subagent-fleet-list" role="list">
              {rows.map((row) => {
                // The projection's walk depth (0 = root). Indentation is display
                // only; targets always come from row.operations.
                const depth = row.depth;
                const stopKey = row.childId ?? row.runId ?? row.key;
                const inspecting = inspect !== null && inspect.runId === row.runId;
                return (
                  <li
                    key={row.key}
                    className={`subagent-fleet-row${row.active ? " is-active" : ""}`}
                    style={{ paddingLeft: 8 + depth * 18 }}
                  >
                    <div className="subagent-fleet-row-main">
                      <span className={`subagent-fleet-status${statusDotClass(row.status)}`} aria-hidden="true" />
                      <span className="subagent-fleet-name" title={row.task ?? row.name}>{row.name}</span>
                      <span className="subagent-fleet-state">{t(`subagentFleet.status.${row.status}`)}</span>
                    </div>
                    <div className="subagent-fleet-row-meta">
                      {row.model && <span>{row.model}</span>}
                      {row.currentTool && <span>{row.currentTool}</span>}
                      {row.tokens !== undefined && <span>{formatTokens(row.tokens.total)} tok</span>}
                      <span>{formatElapsed(row.startedAt, row.endedAt, now)}</span>
                    </div>
                    <div className="subagent-fleet-row-actions" role="group" aria-label={row.name}>
                      {row.operations.inspect && (
                        <button
                          type="button"
                          className="subagent-fleet-action"
                          disabled={busy !== null}
                          onClick={() => (inspecting ? setInspect(null) : void openInspect(row))}
                          aria-expanded={inspecting}
                        >
                          {t("subagentFleet.inspect")}
                        </button>
                      )}
                      {row.operations.steer && (
                        <button
                          type="button"
                          className="subagent-fleet-action"
                          disabled={busy !== null}
                          onClick={() => {
                            setPendingStop(null);
                            setInspect(null);
                            setSteer((current) => current?.row.key === row.key ? null : { row, message: "", mode: "steer" });
                          }}
                          aria-expanded={steer?.row.key === row.key}
                        >
                          {t("subagentFleet.steer")}
                        </button>
                      )}
                      {row.operations.stop && (
                        <button
                          type="button"
                          className="subagent-fleet-action is-danger"
                          disabled={busy !== null}
                          onClick={() => {
                            setSteer(null);
                            setInspect(null);
                            if (row.childId !== undefined && row.parentRunId !== undefined) {
                              setPendingStop((current) => current?.row.key === row.key ? null : { row });
                              return;
                            }
                            void runAction(`stop:${stopKey}`, {
                              action: "stop",
                              runId: row.runId,
                            });
                          }}
                        >
                          {t("subagentFleet.stop")}
                        </button>
                      )}
                      {row.operations.interrupt && (
                        <button
                          type="button"
                          className="subagent-fleet-action is-danger"
                          disabled={busy !== null}
                          onClick={() => {
                            setPendingStop(null);
                            void runAction(`interrupt:${stopKey}`, { action: "interrupt", runId: row.runId });
                          }}
                        >
                          {t("subagentFleet.interrupt")}
                        </button>
                      )}
                    </div>

                    {pendingStop?.row.key === row.key && (
                      <div className="subagent-fleet-confirm">
                        <span>{t("subagentFleet.stopChildConfirm", { name: row.name })}</span>
                        <button
                          type="button"
                          className="subagent-fleet-action is-danger"
                          disabled={busy !== null}
                          onClick={() => void runAction(`stop:${stopKey}`, {
                            action: "stop",
                            runId: row.parentRunId,
                            childId: row.childId,
                          })}
                        >
                          {t("subagentFleet.stopChild")}
                        </button>
                        <button
                          type="button"
                          className="subagent-fleet-action"
                          onClick={() => setPendingStop(null)}
                        >
                          {t("i18n.cancel")}
                        </button>
                      </div>
                    )}

                    {steer?.row.key === row.key && row.runId && (
                      <form
                        className="subagent-fleet-steer"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!steer.message.trim() || busy !== null) return;
                          void runAction(`steer:${row.key}`, {
                            action: "steer",
                            runId: row.runId,
                            message: steer.message.trim(),
                            ...(steer.mode !== "steer" ? { mode: steer.mode } : {}),
                          });
                          setSteer(null);
                        }}
                      >
                        <textarea
                          value={steer.message}
                          onChange={(event) => setSteer((current) => current ? { ...current, message: event.target.value } : current)}
                          placeholder={t("subagentFleet.steerPlaceholder")}
                          rows={2}
                          maxLength={8000}
                          aria-label={t("subagentFleet.steerPlaceholder")}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                              event.currentTarget.form?.requestSubmit();
                            }
                          }}
                        />
                        <div className="subagent-fleet-steer-controls">
                          <AppSelect
                            aria-label={t("subagentFleet.steerMode")}
                            value={steer.mode}
                            onValueChange={(value) => setSteer((current) => current
                              ? { ...current, mode: value as "steer" | "follow_up" | "auto" }
                              : current)}
                            options={[
                              { value: "steer", label: t("subagentFleet.mode.steer") },
                              { value: "follow_up", label: t("subagentFleet.mode.followUp") },
                              { value: "auto", label: t("subagentFleet.mode.auto") },
                            ]}
                          />
                          <button type="submit" className="subagent-fleet-action" disabled={busy !== null || !steer.message.trim()}>
                            {t("subagentFleet.steerSend")}
                          </button>
                          <button type="button" className="subagent-fleet-action" onClick={() => setSteer(null)}>
                            {t("i18n.cancel")}
                          </button>
                        </div>
                      </form>
                    )}

                    {(() => {
                      const detail = inspecting ? inspect : null;
                      return detail ? (
                        <div className="subagent-fleet-inspect">
                          {detail.loading
                            ? <span className="subagent-fleet-inspect-loading">{t("subagentFleet.inspectLoading")}</span>
                            : (
                              <pre className="subagent-fleet-transcript">
                                {detail.text || t("subagentFleet.inspectEmpty")}
                              </pre>
                            )}
                          {detail.truncated && <small>{t("subagentFleet.inspectTruncated")}</small>}
                        </div>
                      ) : null;
                    })()}
                  </li>
                );
              })}
            </ul>

            {fleetEntries.length > 0 && (
              <div className="subagent-fleet-foreground">
                <p className="subagent-fleet-foreground-title">{t("subagentFleet.currentTurn")}</p>
                <ul className="subagent-fleet-list" role="list">
                  {fleetEntries.map((entry) => (
                    <li key={entry.key} className="subagent-fleet-row">
                      <div className="subagent-fleet-row-main">
                        <span className="subagent-fleet-status is-running" aria-hidden="true" />
                        <span className="subagent-fleet-name">{entry.agent}</span>
                        {entry.role && <span className="subagent-fleet-state">{entry.role}</span>}
                      </div>
                      <div className="subagent-fleet-row-meta">
                        {entry.model && <span>{entry.model}</span>}
                        {entry.tokens !== undefined && <span>{formatTokens(entry.tokens.total)} tok</span>}
                        <span>{formatElapsed(entry.startedAt, undefined, now)}</span>
                      </div>
                      {entry.goal && <div className="subagent-fleet-goal" title={entry.goal}>{entry.goal}</div>}
                    </li>
                  ))}
                </ul>
                {snapshot.fleetSummary !== undefined && snapshot.fleetSummary.omitted > 0 && (
                  <small>{t("subagentFleet.omitted", { count: String(snapshot.fleetSummary.omitted) })}</small>
                )}
              </div>
            )}

            {(snapshot.omitted.rows > 0 || snapshot.omitted.children > 0) && (
              <small className="subagent-fleet-omitted">
                {t("subagentFleet.omittedRows", {
                  rows: String(snapshot.omitted.rows),
                  children: String(snapshot.omitted.children),
                })}
              </small>
            )}
          </>
        )}
        {actionError && (
          <div className="subagent-fleet-notice" role="alert">
            <span>{t("subagentFleet.actionFailed")}</span>
            <small>{actionError}</small>
          </div>
        )}
      </div>
    </div>
  );
}
