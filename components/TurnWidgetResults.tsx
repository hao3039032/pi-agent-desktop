"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AssistantMessage } from "@/lib/types";
import { lastTurnWidgetId, type TurnWidgetEntry } from "@/lib/widget-tool";
import { WidgetIcon, WidgetPreview, WidgetResultCard, widgetStatusKey } from "./WidgetToolView";

export interface TurnWidgetResultsProps {
  entries: TurnWidgetEntry[];
  streamingMessage?: AssistantMessage | null;
  revealToolCallId?: string;
}

export function TurnWidgetResults({ entries, streamingMessage, revealToolCallId }: TurnWidgetResultsProps) {
  const { t } = useI18n();
  // null means follow the newest item; only explicit navigation pins a selection.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const witnessedCalls = useRef(new Set<string>());
  for (const block of streamingMessage?.content ?? []) {
    if (block.type === "toolCall") witnessedCalls.current.add(block.toolCallId);
  }
  const lastId = lastTurnWidgetId(entries);
  const selectionExists = entries.some((entry) => entry.toolCallId === selectedId);
  const revealed = entries.find((entry) => entry.toolCallId === revealToolCallId);
  const effectiveSelectedId = revealed?.toolCallId ?? (selectionExists ? selectedId : lastId);

  useEffect(() => {
    if (revealed) setSelectedId(revealed.toolCallId);
    else if (selectedId !== null && !selectionExists) setSelectedId(lastId);
  }, [revealed, selectedId, selectionExists, lastId]);

  if (entries.length === 0) return null;
  const selectedEntry = entries.find((entry) => entry.toolCallId === effectiveSelectedId)!;

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const currentIndex = entries.findIndex((entry) => entry.toolCallId === effectiveSelectedId);
    let nextIndex: number;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + entries.length) % entries.length;
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % entries.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = entries.length - 1;
    else return;
    event.preventDefault();
    const nextId = entries[nextIndex].toolCallId;
    setSelectedId(nextId);
    tabRefs.current[nextId]?.focus();
  };

  return (
    <section className="turn-widget-results" aria-label={t("widget.resultsTitle")}>
      <header className="turn-widget-header">
        <div className="turn-widget-header-title"><WidgetIcon /><span>{t("widget.resultsTitle")}</span></div>
        {entries.length > 1 && <span className="turn-widget-header-count">{t("widget.resultsCount", { count: entries.length })}</span>}
      </header>
      <nav className="turn-widget-tabs" role="tablist" aria-label={t("widget.select")} onKeyDown={handleKeyDown}>
        {entries.map((entry) => {
          const isSelected = entry.toolCallId === effectiveSelectedId;
          return (
            <button
              key={entry.toolCallId}
              type="button"
              role="tab"
              id={`turn-widget-tab-${entry.toolCallId}`}
              data-entry-id={entry.entryId}
              aria-selected={isSelected}
              aria-controls={`turn-widget-panel-${entry.toolCallId}`}
              tabIndex={isSelected ? 0 : -1}
              className={`turn-widget-tab${isSelected ? " is-selected" : ""}`}
              onClick={() => setSelectedId(entry.toolCallId)}
              ref={(element) => { tabRefs.current[entry.toolCallId] = element; }}
            >
              <span data-search-target={entry.toolCallId === revealToolCallId || undefined} className="turn-widget-tab-content">
                <WidgetResultCard entry={entry} total={entries.length} />
              </span>
            </button>
          );
        })}
      </nav>
      <span className="sr-only" role="status" aria-live="polite">{t(widgetStatusKey(selectedEntry.status))}</span>
      {entries.map((entry) => (
        <div
          key={entry.toolCallId}
          className="turn-widget-preview"
          role="tabpanel"
          hidden={entry.toolCallId !== effectiveSelectedId}
          id={`turn-widget-panel-${entry.toolCallId}`}
          aria-labelledby={`turn-widget-tab-${entry.toolCallId}`}
        >
          {entry.toolCallId === effectiveSelectedId && (
            <WidgetPreview
              block={entry.block}
              view={entry.view}
              result={entry.result}
              status={entry.status}
              isStreaming={witnessedCalls.current.has(entry.toolCallId)}
            />
          )}
        </div>
      ))}
    </section>
  );
}
