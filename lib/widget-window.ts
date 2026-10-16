import { createRequire } from "module";
import path from "path";
import { generativeUiPackageDir, loadWrapHtmlFn } from "./generative-ui";

/**
 * Opens a widget in a native window through glimpseui — the "pop out" button
 * of the inline widget card (POST /api/widgets/open). glimpseui is resolved
 * at runtime from the installed packages (createRequire, the same anchors as
 * generativeUiPackageDir) so neither webpack nor the file tracer inlines it,
 * and it is imported through jiti so its ESM entry and platform fallbacks
 * (native binary on macOS/Windows, system Chromium on Linux) load exactly as
 * the package intends.
 */

export interface WidgetWindowRequest {
  code: string;
  title?: string;
  width?: number;
  height?: number;
  isSVG?: boolean;
}

export const WIDGET_WINDOW_MIN_WIDTH = 240;
export const WIDGET_WINDOW_MAX_WIDTH = 2200;
export const WIDGET_WINDOW_MIN_HEIGHT = 160;
export const WIDGET_WINDOW_MAX_HEIGHT = 1600;
export const WIDGET_WINDOW_DEFAULT_WIDTH = 800;
export const WIDGET_WINDOW_DEFAULT_HEIGHT = 600;

export function clampWidgetWindowSize(width: unknown, height: unknown): { width: number; height: number } {
  const nextWidth = typeof width === "number" && Number.isFinite(width) ? width : WIDGET_WINDOW_DEFAULT_WIDTH;
  const nextHeight = typeof height === "number" && Number.isFinite(height) ? height : WIDGET_WINDOW_DEFAULT_HEIGHT;
  return {
    width: Math.min(WIDGET_WINDOW_MAX_WIDTH, Math.max(WIDGET_WINDOW_MIN_WIDTH, Math.round(nextWidth))),
    height: Math.min(WIDGET_WINDOW_MAX_HEIGHT, Math.max(WIDGET_WINDOW_MIN_HEIGHT, Math.round(nextHeight))),
  };
}

/** Window titles spell snake_case identifiers with spaces, like the package. */
export function widgetWindowTitle(title: unknown): string {
  if (typeof title !== "string" || title.trim() === "") return "Widget";
  return title.slice(0, 200).replace(/_/g, " ");
}

export function detectWidgetSVG(code: string, isSVG?: boolean): boolean {
  if (typeof isSVG === "boolean") return isSVG;
  return code.trimStart().startsWith("<svg");
}

interface GlimpseWindowLike {
  on(event: "closed", handler: () => void): void;
}
export type GlimpseOpen = (html: string, options: { width: number; height: number; title: string }) => GlimpseWindowLike;
export type GlimpseModule = { open: GlimpseOpen };

export type GlimpseEntryResolver = (specifier: string, anchor: string) => string;

const GLIMPSE_UNAVAILABLE_HINT =
  "Could not resolve the glimpseui window host. It ships as a dependency of "
  + "@ryan_nookpi/pi-extension-generative-ui — run npm install and try again.";

/** Resolve glimpseui's entry against the runtime anchors; throws with a hint. */
export function resolveGlimpseEntry(resolver?: GlimpseEntryResolver): string {
  const resolve: GlimpseEntryResolver = resolver ?? ((specifier, anchor) => createRequire(anchor).resolve(specifier));
  // glimpseui is a dependency of the generative-ui package, so the package
  // directory is an anchor too: it lands even when npm did not hoist it to
  // the layout root.
  const anchors = [
    path.join(process.cwd(), "package.json"),
    generativeUiPackageDir() ? path.join(generativeUiPackageDir()!, "package.json") : undefined,
    import.meta.url,
  ].filter((anchor): anchor is string => typeof anchor === "string");
  for (const anchor of anchors) {
    try {
      return resolve("glimpseui", anchor);
    } catch {
      // Try the next anchor.
    }
  }
  throw new Error(GLIMPSE_UNAVAILABLE_HINT);
}

// Loaded through the same lazy jiti the generative-ui helpers use.
type JitiImport = (entry: string) => Promise<unknown>;
let glimpseJitiImport: JitiImport | undefined;

async function importGlimpseModule(entry: string): Promise<GlimpseModule> {
  if (!glimpseJitiImport) {
    const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
    const jiti = (requireFromCwd("jiti") as { createJiti?: (id: string) => { import: JitiImport } }).createJiti;
    if (typeof jiti !== "function") throw new Error(GLIMPSE_UNAVAILABLE_HINT);
    glimpseJitiImport = jiti(path.join(process.cwd(), "package.json")).import;
  }
  const mod = await glimpseJitiImport(entry);
  if (!mod || typeof (mod as GlimpseModule).open !== "function") {
    throw new Error("The glimpseui window host did not export open().");
  }
  return mod as GlimpseModule;
}

/** Live widget windows, shared across hot reloads. */
export function getWidgetWindows(): Set<unknown> {
  const holder = globalThis as { __piWidgetWindows?: Set<unknown> };
  if (!holder.__piWidgetWindows) holder.__piWidgetWindows = new Set();
  return holder.__piWidgetWindows;
}

export interface WidgetWindowDeps {
  /** Test seam: resolve the glimpseui entry (defaults to resolveGlimpseEntry). */
  resolveEntry?: () => string;
  /** Test seam: import the glimpseui module for an entry path. */
  importGlimpse?: (entry: string) => Promise<GlimpseModule>;
  /** Test seam: wrap widget code into a document (defaults to the package's wrapHTML). */
  wrapHTML?: (code: string, isSVG: boolean) => string;
}

/**
 * Open one widget window. Every call opens a new window (never focuses an
 * existing one) — the card's button means "show me another copy".
 */
export async function openWidgetWindow(request: WidgetWindowRequest, deps: WidgetWindowDeps = {}): Promise<void> {
  const { code } = request;
  if (typeof code !== "string" || code.length === 0) {
    throw new Error("Widget code must be a non-empty string.");
  }
  const { width, height } = clampWidgetWindowSize(request.width, request.height);
  const title = widgetWindowTitle(request.title);
  const isSVG = detectWidgetSVG(code, request.isSVG);

  let wrap = deps.wrapHTML;
  if (!wrap) {
    const wrapHTML = await loadWrapHtmlFn();
    if (!wrapHTML) {
      throw new Error("Could not load the widget document wrapper — the generative-ui package is unavailable.");
    }
    wrap = (widgetCode, svg) => wrapHTML(widgetCode, svg);
  }

  let open: GlimpseOpen;
  try {
    const entry = deps.resolveEntry ? deps.resolveEntry() : resolveGlimpseEntry();
    const mod = deps.importGlimpse ? await deps.importGlimpse(entry) : await importGlimpseModule(entry);
    open = mod.open;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not open the widget window: ${message}`);
  }

  // open() resolves the platform host and can fail with its own fix hint
  // (e.g. a missing native binary or browser); surface that verbatim.
  const win = open(wrap(code, isSVG), { width, height, title });
  const windows = getWidgetWindows();
  windows.add(win);
  win.on("closed", () => windows.delete(win));
}
