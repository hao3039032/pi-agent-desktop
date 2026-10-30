"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import { findConversationRanges, isConversationFindActive } from "@/lib/conversation-find";

type HighlightAPI = { set(name: string, value: unknown): void; delete(name: string): void };

/** Search only the conversation, not the sidebar, composer or file workspace. */
export function ConversationFind({ contentRef, scopeKey, onReveal, hasEarlier, onLoadEarlier, busy }: {
  contentRef: RefObject<HTMLDivElement | null>;
  scopeKey: string | null;
  onReveal: () => void;
  hasEarlier: boolean;
  onLoadEarlier: () => Promise<void>;
  busy: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  // Separate navigation intent from match-list updates: streaming may replace
  // every Range without the reader requesting a viewport jump.
  const [navigation, setNavigation] = useState(0);
  const matchesRef = useRef<Range[]>([]);
  const indexRef = useRef(0);
  const queryRef = useRef("");
  // The navigation effect reads the latest committed selection but deliberately
  // does not depend on matches/index, which also change during passive refreshes.
  const stateRef = useRef({ matches, index });
  stateRef.current = { matches, index };
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;
  const close = useCallback(() => {
    setOpen(false);
    previousFocus.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    setOpen(false); setQuery(""); setMatches([]); setIndex(0);
    matchesRef.current = []; indexRef.current = 0; queryRef.current = "";
  }, [scopeKey]);
  useEffect(() => {
    // ChatWindow stays mounted behind Scheduled and full-width workspaces.
    // Check its owning surface on every key, not only the event's target: the
    // target may be an overlay outside this component's inert ancestor.
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !isConversationFindActive(contentRef.current)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && !event.altKey && !event.shiftKey) {
        // Modal dialogs and the file workspace keep their own find behavior.
        if (document.querySelector('[aria-modal="true"]') || (event.target as HTMLElement)?.closest?.('#file-panel')) return;
        event.preventDefault();
        if (!open) previousFocus.current = document.activeElement as HTMLElement;
        revealRef.current();
        setOpen(true);
        requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
      } else if (open && event.key === "Escape") {
        if (document.querySelector('[aria-modal="true"]')) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [close, contentRef, open]);

  useEffect(() => {
    const root = contentRef.current;
    if (!open || !root) return;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      const next = findConversationRanges(root, query);
      const queryChanged = queryRef.current !== query;
      // Range endpoints survive an append/prepend when React reuses the text
      // nodes. If a renderer replaces them, retain the nearest valid ordinal
      // instead of resetting to the first result. Neither path scrolls.
      const current = matchesRef.current[indexRef.current];
      let nextIndex = queryChanged ? 0 : next.findIndex((range) => current
        && range.startContainer === current.startContainer && range.startOffset === current.startOffset
        && range.endContainer === current.endContainer && range.endOffset === current.endOffset);
      if (nextIndex < 0) nextIndex = Math.min(indexRef.current, Math.max(0, next.length - 1));
      matchesRef.current = next;
      indexRef.current = nextIndex;
      queryRef.current = query;
      setMatches(next);
      setIndex(nextIndex);
      // DOM refreshes update highlights/counts only. Never navigate on streaming.
      if (queryChanged) setNavigation((value) => value + 1);
    };
    refresh();
    // Observe rendered text, not messages: expanding details and paced Markdown
    // can change searchable content without changing the message array. Debounce
    // streamed mutations and release the observer/timer when closed or switched.
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(refresh, 100); });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "aria-expanded", "style", "data-conversation-find-exclude"] });
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [contentRef, open, query]);

  useEffect(() => {
    // Browser-owned highlights leave React/syntax-highlighter text nodes intact.
    // Older WebViews retain counting/navigation if Custom Highlights is absent.
    // Delete only our named entries; other app highlights must remain untouched.
    const highlights = (CSS as unknown as { highlights?: HighlightAPI }).highlights;
    const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!highlights || !Highlight) return;
    if (open) {
      highlights.set("conversation-find", new Highlight(...matches));
      highlights.set("conversation-find-active", new Highlight(...(matches[index] ? [matches[index]] : [])));
    }
    return () => { highlights.delete("conversation-find"); highlights.delete("conversation-find-active"); };
  }, [index, matches, open]);

  const move = (delta: number) => {
    if (matches.length) {
      const next = (indexRef.current + delta + matches.length) % matches.length;
      indexRef.current = next;
      setIndex(next);
      setNavigation((value) => value + 1);
    }
  };
  useEffect(() => {
    const range = stateRef.current.matches[stateRef.current.index];
    const root = contentRef.current;
    const scrollport = root?.closest<HTMLElement>(".chat-scroll-container");
    if (!open || !range || !scrollport) return;
    const rect = range.getBoundingClientRect();
    const container = scrollport.getBoundingClientRect();
    scrollport.scrollTop += rect.top - container.top - container.height / 2;
  }, [contentRef, navigation, open]);

  if (!open) return null;
  return (
    <div className="conversation-find" role="search" aria-label={t("chat.findTitle")}>
      <div className="conversation-find-row">
        <input ref={inputRef} value={query} placeholder={t("chat.findTitle")} aria-label={t("chat.findTitle")}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); move(event.shiftKey ? -1 : 1); }
          }} />
        <span className="conversation-find-count" role="status">{query ? `${matches.length ? index + 1 : 0} / ${matches.length}` : ""}</span>
        <button type="button" disabled={!matches.length} onClick={() => move(-1)} aria-label={t("chat.findPrevious")} title={t("chat.findPrevious")}>↑</button>
        <button type="button" disabled={!matches.length} onClick={() => move(1)} aria-label={t("chat.findNext")} title={t("chat.findNext")}>↓</button>
        <button type="button" onClick={close} aria-label={t("chat.findClose")} title={t("chat.findClose")}>×</button>
      </div>
      <div className="conversation-find-hint">
        {t("chat.findScope")}
        {hasEarlier && <button type="button" disabled={busy || loading} onClick={async () => {
          setLoading(true);
          try { await onLoadEarlier(); } finally { setLoading(false); }
        }}>{t(loading ? "chat.loadingSession" : "chat.findEarlier")}</button>}
      </div>
    </div>
  );
}
