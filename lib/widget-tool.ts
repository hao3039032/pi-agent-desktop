/**
 * Pure helpers for rendering show_widget tool calls inline. The tool input is
 * persisted in the session file, so widget calls made by the old package
 * extension render the same way as builtin ones.
 */

export const WIDGET_TOOL_NAME = "show_widget";

export const WIDGET_DEFAULT_WIDTH = 800;
export const WIDGET_DEFAULT_HEIGHT = 600;

export interface WidgetCallInfo {
  code: string;
  /** snake_case identifier with underscores spelled as spaces. */
  title: string;
  width: number;
  height: number;
  isSVG: boolean;
}

export function widgetPreviewKind(isSVG: boolean): "svg" | "html" {
  return isSVG ? "svg" : "html";
}

/**
 * The renderable shape of a show_widget call, or null when the input is not
 * usable (a malformed or foreign call falls back to the generic tool view).
 */
export function extractWidgetCall(input: Record<string, unknown> | null | undefined): WidgetCallInfo | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const code = input.widget_code;
  if (typeof code !== "string" || code.trim() === "") return null;
  const title = typeof input.title === "string" && input.title.trim() !== ""
    ? input.title.replace(/_/g, " ")
    : "Widget";
  const width = typeof input.width === "number" && Number.isFinite(input.width) && input.width > 0
    ? input.width
    : WIDGET_DEFAULT_WIDTH;
  const height = typeof input.height === "number" && Number.isFinite(input.height) && input.height > 0
    ? input.height
    : WIDGET_DEFAULT_HEIGHT;
  const isSVG = typeof input.isSVG === "boolean" ? input.isSVG : code.trimStart().startsWith("<svg");
  return { code, title, width, height, isSVG };
}

/** What BlockView should render for a toolCall block. */
export type WidgetBlockView = "streaming" | WidgetCallInfo;

/**
 * Dispatch for the inline widget card: "streaming" while the tool input is
 * still arriving, the extracted call once it is complete, null for anything
 * that is not a renderable show_widget call.
 */
export function widgetBlockView(input: {
  toolName?: string;
  rawInput?: string;
  parsedInput?: Record<string, unknown> | null;
}): WidgetBlockView | null {
  if (input?.toolName !== WIDGET_TOOL_NAME) return null;
  if (input.rawInput !== undefined) return "streaming";
  return extractWidgetCall(input.parsedInput);
}

// ---------------------------------------------------------------------------
// Streaming helpers (rawInput is the partial tool-call JSON)
// ---------------------------------------------------------------------------

const WIDGET_CODE_MARKER = /"widget_code"\s*:\s*"/;

/** Single-pass JSON string unescape (chained replaces would mis-read `\\n`). */
function unescapeJsonBody(body: string): string {
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_whole: string, seq: string) => {
    if (seq[0] === "u") {
      try {
        return String.fromCodePoint(parseInt(seq.slice(1), 16));
      } catch {
        return seq;
      }
    }
    switch (seq) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "b": return "\b";
      case "f": return "\f";
      default: return seq; // \\ \" \/ and anything else passes through
    }
  });
}

/**
 * The widget_code received so far, with JSON escapes undone and a trailing
 * partial escape dropped. Approximate by design: it feeds progress labels and
 * the streamed-here key, never the render itself.
 */
export function partialWidgetCode(rawInput: string | undefined): string {
  if (!rawInput) return "";
  const marker = WIDGET_CODE_MARKER.exec(rawInput);
  if (!marker) return "";
  let body = rawInput.slice(marker.index + marker[0].length);
  // Drop a trailing partial escape (a `\\` cut mid-way, a `\u00e` fragment).
  body = body.replace(/(?:\\u[0-9a-fA-F]{0,3}|\\)$/, "");
  // Everything after the closing quote of the string is not code.
  const end = findJsonStringEnd(body);
  if (end !== null) body = body.slice(0, end);
  return unescapeJsonBody(body);
}

/** Index of the closing quote of a JSON string body, or null while it streams. */
function findJsonStringEnd(body: string): number | null {
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      if (body[i] === '"') return i;
      continue;
    }
    i++; // Skip the escaped character.
  }
  return null;
}

/** Bytes of widget_code received so far. */
export function streamingWidgetBytes(rawInput: string | undefined): number {
  const code = partialWidgetCode(rawInput);
  if (!code) return 0;
  return byteLength(code);
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
  return Buffer.byteLength(value, "utf8");
}

/** The widget title if it has already arrived in the partial JSON. */
export function streamingWidgetTitle(rawInput: string | undefined): string | null {
  if (!rawInput) return null;
  const match = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(rawInput);
  if (!match) return null;
  try {
    const title = JSON.parse(`"${match[1]}"`);
    return typeof title === "string" && title.trim() !== "" ? title.replace(/_/g, " ") : null;
  } catch {
    return null;
  }
}
