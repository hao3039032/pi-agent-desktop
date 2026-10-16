"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { downloadUrlAsFile } from "@/lib/desktop-native";
import {
  HTML_PREVIEW_MIN_HEIGHT,
  HTML_PREVIEW_SANDBOX,
  buildHtmlPreviewDocument,
  htmlPreviewFileName,
  htmlPreviewFollowsTheme,
  htmlPreviewHasActiveContent,
  type HtmlPreviewKind,
} from "@/lib/html-preview";
import { useHtmlPreviewErrors, useHtmlPreviewFrameMessages, useHtmlPreviewOptions } from "@/hooks/useHtmlPreviewFrame";
import { CodeBlock } from "./MermaidBlock";
import { HtmlPreviewDialog } from "./HtmlPreviewBlock";
import { HtmlPreviewErrorBar } from "./HtmlPreviewErrorBar";
import type { ToolCallContent, ToolResultMessage } from "@/lib/types";
import { streamingWidgetBytes, streamingWidgetTitle, widgetPreviewKind, type WidgetBlockView } from "@/lib/widget-tool";

/** Inline frames cap a bit above the chat previews: the widget is the message. */
const WIDGET_FRAME_MAX_HEIGHT = 720;
const WIDGET_FRAME_DEFAULT_HEIGHT = 480;

function clampWidgetFrameHeight(height: number): number {
  if (!Number.isFinite(height)) return WIDGET_FRAME_DEFAULT_HEIGHT;
  return Math.min(WIDGET_FRAME_MAX_HEIGHT, Math.max(HTML_PREVIEW_MIN_HEIGHT, Math.ceil(height)));
}

// Blocks seen streaming in this page, keyed by their opening text — the same
// mechanism HtmlPreviewBlock uses, so a scripted widget auto-runs only when
// this page watched it being generated (macOS sandboxed frames share the
// window process; a looping page from history must not freeze the app).
const STREAMED_KEY_LENGTH = 256;
const MAX_STREAMED = 100;
const streamedWidgets = new Set<string>();

function rememberStreamedWidget(code: string): void {
  const key = code.slice(0, STREAMED_KEY_LENGTH);
  if (key.length < 32 || streamedWidgets.has(key)) return;
  streamedWidgets.add(key);
  if (streamedWidgets.size > MAX_STREAMED) streamedWidgets.delete(streamedWidgets.values().next().value!);
}

function wasWidgetStreamedHere(code: string): boolean {
  return streamedWidgets.has(code.slice(0, STREAMED_KEY_LENGTH));
}

const KIND_MIME: Record<string, string> = {
  html: "text/html;charset=utf-8",
  svg: "image/svg+xml;charset=utf-8",
};

function formatWidgetBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function resultText(result: ToolResultMessage | undefined): string | null {
  if (!result) return null;
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Opens one external window per click; failures surface in the card. */
async function popOutWidget(view: Exclude<WidgetBlockView, "streaming">): Promise<void> {
  const response = await fetch("/api/widgets/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: view.code,
      title: view.title,
      width: view.width,
      height: view.height,
      isSVG: view.isSVG,
    }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? `HTTP ${response.status}`);
  }
}

function WidgetIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent, currentColor)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M9 21h6M12 18v3" />
    </svg>
  );
}

export interface WidgetToolViewProps {
  block: ToolCallContent;
  /** Precomputed by widgetBlockView() in MessageView's BlockView. */
  view: WidgetBlockView;
  result?: ToolResultMessage;
  isStreaming?: boolean;
}

/**
 * The inline card for a show_widget call — rendered for the whole tool-call
 * block, deliberately outside ToolCallBlock's collapse mechanism: the widget
 * stays visible after the tool finishes. While the input streams it shows a
 * placeholder (re-mounting an iframe per delta would re-run its scripts);
 * once complete it renders the sandboxed frame plus a pop-out button backed
 * by /api/widgets/open.
 */
export function WidgetToolView({ block, view, result, isStreaming }: WidgetToolViewProps) {
  const { t } = useI18n();
  const [popState, setPopState] = useState<"idle" | "opening" | "opened" | "failed">("idle");
  const [popError, setPopError] = useState<string | null>(null);
  const popTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (popTimerRef.current) clearTimeout(popTimerRef.current);
  }, []);

  if (view === "streaming") {
    const bytes = streamingWidgetBytes(block.rawInput);
    const title = streamingWidgetTitle(block.rawInput);
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 8, minWidth: 0,
        border: "var(--hairline) solid var(--border)", borderRadius: 7,
        padding: "8px 12px", background: "var(--bg)",
        fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)",
      }}>
        <WidgetIcon />
        <span style={{ color: "var(--text)", fontWeight: 600, flexShrink: 0 }}>{title ?? t("widget.cardTitle")}</span>
        <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("widget.generating")}
          {bytes > 0 ? ` · ${formatWidgetBytes(bytes)}` : ""}
        </span>
      </div>
    );
  }

  return (
    <WidgetCard
      view={view}
      result={result}
      isStreaming={isStreaming}
      popState={popState}
      popError={popError}
      onPopOut={() => {
        setPopState("opening");
        setPopError(null);
        void popOutWidget(view).then(() => {
          setPopState("opened");
          if (popTimerRef.current) clearTimeout(popTimerRef.current);
          popTimerRef.current = setTimeout(() => setPopState("idle"), 2000);
        }, (error: unknown) => {
          setPopState("failed");
          setPopError(error instanceof Error ? error.message : String(error));
        });
      }}
    />
  );
}

function WidgetCard({ view, result, isStreaming, popState, popError, onPopOut }: {
  view: Exclude<WidgetBlockView, "streaming">;
  result?: ToolResultMessage;
  isStreaming?: boolean;
  popState: "idle" | "opening" | "opened" | "failed";
  popError: string | null;
  onPopOut: () => void;
}) {
  const { t } = useI18n();
  const kind: HtmlPreviewKind = widgetPreviewKind(view.isSVG);
  const hasActiveContent = htmlPreviewHasActiveContent(view.code);
  // While the message still streams with a complete widget call, remember it:
  // the finished message is a different component, and this is what lets its
  // scripts run without asking (the user watched this page generate them).
  if (isStreaming) rememberStreamedWidget(view.code);
  const [showPreview, setShowPreview] = useState(() => !hasActiveContent || wasWidgetStreamedHere(view.code));
  const [fullscreen, setFullscreen] = useState(false);
  const [height, setHeight] = useState(() => clampWidgetFrameHeight(view.height));
  const frameRef = useRef<HTMLIFrameElement>(null);
  const options = useHtmlPreviewOptions();

  const srcDoc = useMemo(() => buildHtmlPreviewDocument(kind, view.code, options), [kind, view.code, options]);
  const themed = htmlPreviewFollowsTheme(kind, view.code);
  const { errors, addError, dismiss } = useHtmlPreviewErrors(view.code);
  useHtmlPreviewFrameMessages(frameRef, {
    onSize: (value) => setHeight(clampWidgetFrameHeight(value)),
    onError: addError,
  }, showPreview && !fullscreen);

  const lang = kind === "svg" ? "svg" : "html";
  const sizeLabel = `${view.width}×${view.height}`;

  const download = () => {
    const url = URL.createObjectURL(new Blob([view.code], { type: KIND_MIME[kind] }));
    void downloadUrlAsFile(url, htmlPreviewFileName(kind))
      .catch(() => {})
      .finally(() => setTimeout(() => URL.revokeObjectURL(url), 0));
  };

  const headerButton = (label: string, title: string, onClick: () => void, opts: { disabled?: boolean; active?: boolean } = {}) => (
    <button
      type="button"
      className={["markdown-code-action", opts.active ? "is-active" : ""].filter(Boolean).join(" ")}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={opts.disabled}
    >
      {label}
    </button>
  );

  const text = resultText(result);
  const isError = result?.isError ?? false;
  const popLabel = popState === "opening" ? t("widget.opening") : popState === "opened" ? t("widget.opened") : t("widget.openExternal");

  return (
    <div
      className="markdown-code-block html-preview-block"
      style={{
        borderRadius: 7,
        border: isError
          ? "1px solid rgba(248,113,113,0.45)"
          : "var(--hairline) solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <div className="markdown-code-header">
        <span className="markdown-code-lang" style={{ display: "inline-flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
          <WidgetIcon />
          <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{view.title}</span>
          <span style={{ color: "var(--text-dim)", fontWeight: 400, flexShrink: 0 }}>{sizeLabel}</span>
        </span>
        <div className="markdown-code-actions">
          {headerButton(popLabel, t("widget.openExternalTitle"), onPopOut, { disabled: popState === "opening" })}
          {headerButton(t("preview.download"), `${t("i18n.downloadFile")} · ${htmlPreviewFileName(kind)}`, download)}
          {headerButton(t("i18n.fullscreen"), t("i18n.openFullscreen"), () => setFullscreen(true), { disabled: !showPreview })}
          {headerButton(
            showPreview ? t("i18n.source") : t("i18n.preview"),
            showPreview ? t("i18n.source") : t("i18n.preview"),
            () => setShowPreview((v) => !v),
            { active: showPreview },
          )}
        </div>
      </div>
      {showPreview ? (
        fullscreen ? (
          <>
            <div className="html-preview-placeholder" style={{ height }} />
            <HtmlPreviewDialog title={view.title} srcDoc={srcDoc} themed={themed} onClose={() => setFullscreen(false)} />
          </>
        ) : (
          <iframe
            ref={frameRef}
            className={`html-preview-frame${themed ? " is-themed" : ""}`}
            srcDoc={srcDoc}
            sandbox={HTML_PREVIEW_SANDBOX}
            loading="lazy"
            title={view.title}
            style={{ height }}
          />
        )
      ) : (
        <CodeBlock code={view.code} lang={lang} />
      )}
      {popError && (
        <div style={{ padding: "6px 12px", fontSize: 11, color: "var(--danger, #dc2626)", fontFamily: "var(--font-mono)" }} role="alert">
          {t("widget.openFailed", { error: popError })}
        </div>
      )}
      {text !== null && text.trim() !== "" && !popError && (
        <div style={{
          padding: "5px 12px", fontSize: 11, fontFamily: "var(--font-mono)",
          color: isError ? "var(--danger, #dc2626)" : "var(--text-dim)",
          borderTop: "var(--hairline) solid var(--border)",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
          maxHeight: 84, overflow: "auto",
        }}>
          {text}
        </div>
      )}
      <HtmlPreviewErrorBar errors={errors} onDismiss={dismiss} />
    </div>
  );
}
