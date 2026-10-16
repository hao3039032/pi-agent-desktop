import { existsSync, realpathSync } from "fs";
import { createRequire } from "module";
import path from "path";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi Web's own `show_widget` / `visualize_read_me` extension.
 *
 * The tools are registered by an inline factory instead of loading the
 * generative-ui package as an extension: the frontend renders `show_widget`
 * calls inline in the conversation (see components/WidgetToolView.tsx), and
 * popping a native window is a user action served by /api/widgets/open, so
 * nothing in the session process should open windows on its own. The package
 * itself stays a dependency — the guidelines, the document wrapper, and the
 * glimpseui window host are jiti-loaded from it at runtime, so their versions
 * track the package — but its extension file is no longer loaded, and any
 * user-installed copy of it is dropped from the session (see
 * preferBuiltinGenerativeUiExtension) so the two never fight over the tool
 * names and no second window ever opens.
 */

/** npm package name of the generative-ui package. */
const GENERATIVE_UI_PACKAGE_NAME = "@ryan_nookpi/pi-extension-generative-ui";

export const GENERATIVE_UI_EXTENSION_NAME = "pi-web-generative-ui";
const GENERATIVE_UI_EXTENSION_PATH = `<inline:${GENERATIVE_UI_EXTENSION_NAME}>`;

let resolvedPackageDir: string | null | undefined;

/** Resolve the package against one anchor; undefined when it does not land. */
function resolveFromAnchor(anchor: string): string | undefined {
  try {
    // createRequire from a directory anchor — not from this module's URL
    // alone, which inside the Next server bundle is a chunk under .next and
    // need not sit inside a resolvable node_modules layout. Both anchors are
    // tried: the working directory (the project root in dev and `next start`,
    // the staged server root in the desktop app) and this module's own
    // location, which covers servers launched from another directory.
    const requireFromAnchor = createRequire(anchor);
    const manifest = requireFromAnchor.resolve(`${GENERATIVE_UI_PACKAGE_NAME}/package.json`);
    const dir = path.dirname(realpathSync(manifest));
    if (existsSync(path.join(dir, "guidelines.ts"))) return dir;
  } catch {
    // Not resolvable from this anchor.
  }
  return undefined;
}

/**
 * This app's installed copy of the generative-ui package, or undefined when it
 * is not installed (dev checkout without `npm install`, or a staged server
 * built from a tree that predates the dependency). The builtin tools then run
 * with a static module list and refuse guideline loads with a clear error;
 * a user-level extension copy still loads on its own (the pi CLI keeps it).
 */
export function generativeUiPackageDir(): string | undefined {
  if (resolvedPackageDir === undefined) {
    resolvedPackageDir = resolveFromAnchor(path.join(process.cwd(), "package.json"))
      ?? resolveFromAnchor(import.meta.url)
      ?? null;
  }
  return resolvedPackageDir ?? undefined;
}

/** Whether an extension path belongs to the generative-ui package. */
export function isGenerativeUiExtensionPath(extensionPath: string): boolean {
  const segments = extensionPath.replaceAll("\\", "/").split("/");
  return segments.some((segment) => segment === "pi-extension-generative-ui");
}

// ---------------------------------------------------------------------------
// jiti loading of the package's TypeScript sources
// ---------------------------------------------------------------------------

/**
 * The module list of the installed package, kept in sync with it. Only used
 * to build the tool schema when the package itself cannot be loaded; the
 * package's own list (modules.ts) stays authoritative whenever it resolves.
 */
const FALLBACK_MODULES = ["art", "mockup", "interactive", "chart", "diagram"] as const;

type GuidelinesFn = (modules: string[]) => string;
type WrapHtmlFn = (code: string, isSVG?: boolean) => string;

interface JitiInstance {
  import(id: string, opts?: { default?: boolean }): Promise<unknown>;
}
type JitiFactory = (id: string, opts?: Record<string, unknown>) => JitiInstance;

let jitiFactory: JitiFactory | null | undefined;

/**
 * jiti is loaded through createRequire at call time — the same trick the pi
 * SDK's jiti-static loader uses — so neither webpack nor Next's file tracer
 * inlines it into a server chunk: jiti's lazy babel transform resolves
 * relative to the real package, and a bundled copy would break TS loading.
 */
function getJitiFactory(): JitiFactory | undefined {
  if (jitiFactory === undefined) {
    jitiFactory = null;
    const anchors = [path.join(process.cwd(), "package.json"), import.meta.url];
    for (const anchor of anchors) {
      try {
        const requireFromAnchor = createRequire(anchor);
        const mod = requireFromAnchor("jiti") as { createJiti?: JitiFactory };
        if (typeof mod?.createJiti === "function") {
          jitiFactory = mod.createJiti;
          break;
        }
      } catch {
        // Try the next anchor.
      }
    }
  }
  return jitiFactory ?? undefined;
}

let jitiInstance: JitiInstance | null | undefined;

function packageJiti(): JitiInstance | undefined {
  if (jitiInstance === undefined) {
    jitiInstance = null;
    const factory = getJitiFactory();
    const dir = generativeUiPackageDir();
    if (factory && dir) {
      try {
        jitiInstance = factory(path.join(dir, "package.json"));
      } catch {
        // Leave null; loads below report the failure.
      }
    }
  }
  return jitiInstance ?? undefined;
}

const packageModuleCache = new Map<string, unknown>();

async function importPackageModule(file: string): Promise<Record<string, unknown> | undefined> {
  const dir = generativeUiPackageDir();
  if (!dir) return undefined;
  const entry = path.join(dir, file);
  if (!packageModuleCache.has(entry)) {
    const jiti = packageJiti();
    if (!jiti) return undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      packageModuleCache.set(entry, (await jiti.import(entry) as any) ?? {});
    } catch {
      packageModuleCache.set(entry, {});
    }
  }
  return packageModuleCache.get(entry) as Record<string, unknown> | undefined;
}

let availableModules: readonly string[] | undefined;

/** The module enum for the read_me schema, from the package when it loads. */
export async function loadAvailableModules(): Promise<readonly string[]> {
  if (availableModules === undefined) {
    try {
      const mod = await importPackageModule("modules.ts");
      const value = mod?.AVAILABLE_MODULES;
      availableModules = Array.isArray(value) && value.every((name): name is string => typeof name === "string") && value.length > 0
        ? value
        : FALLBACK_MODULES;
    } catch {
      availableModules = FALLBACK_MODULES;
    }
  }
  return availableModules;
}

/** The package's getGuidelines(); undefined when the package is unavailable. */
export async function loadGuidelinesFn(): Promise<GuidelinesFn | undefined> {
  const mod = await importPackageModule("guidelines.ts");
  return typeof mod?.getGuidelines === "function" ? mod.getGuidelines as GuidelinesFn : undefined;
}

/** The package's wrapHTML(); undefined when the package is unavailable. */
export async function loadWrapHtmlFn(): Promise<WrapHtmlFn | undefined> {
  const mod = await importPackageModule("html-utils.ts");
  return typeof mod?.wrapHTML === "function" ? mod.wrapHTML as WrapHtmlFn : undefined;
}

// ---------------------------------------------------------------------------
// The builtin extension
// ---------------------------------------------------------------------------

/** What show_widget reports to the model: the render happens in the chat. */
export function widgetInlineResultText(title: string, width: number, height: number): string {
  return `Widget "${title}" rendered inline in the conversation (${width}×${height}). `
    + "The user can open it in an external window from the chat.";
}

/**
 * Registers Pi Web's generative-ui tools. `show_widget` does not open a
 * window: the frontend renders the widget inline and offers an external
 * window button, so the tool only acknowledges the render. The wording sent
 * to the model ("rendered inline") keeps it from telling the user a window
 * opened.
 *
 * Both tools are `deferred`: most tasks never need a widget, so they stay out
 * of every request's tool declarations and prompt snippets until the model
 * discovers them with `tool_search` (BM25 over name + description). The
 * factory therefore also keeps `tool_search` active — the same thing the MCP
 * extension does for servers with deferred tools. Once loaded, the tools stay
 * active for the session (the activation is recorded in the transcript).
 */
export function createGenerativeUiExtension(): InlineExtension {
  return {
    name: GENERATIVE_UI_EXTENSION_NAME,
    hidden: true,
    factory: async (pi) => {
      const modules = await loadAvailableModules();

      pi.registerTool(defineTool({
        name: "visualize_read_me",
        label: "Read Guidelines",
        description:
          "Returns design guidelines for show_widget — CSS patterns, colors, typography, layout rules and examples "
          + "for charts, diagrams, dashboards, mockups and interactive widgets. "
          + "Call once before your first show_widget call. Do NOT mention this call to the user — it is an internal setup step.",
        promptSnippet: "Load design guidelines before creating widgets. Call silently before first show_widget use.",
        promptGuidelines: [
          "Call visualize_read_me once before your first show_widget call to load design guidelines.",
          "Do NOT mention the read_me call to the user — call it silently, then proceed directly to building the widget.",
          "Pick the modules that match your use case: interactive, chart, mockup, art, diagram.",
        ],
        // Not declared per request; tool_search loads it when a task asks for a
        // chart, diagram or widget.
        exposure: "deferred",
        parameters: Type.Object({
          modules: Type.Array(
            Type.Unsafe<string>({
              type: "string",
              enum: modules,
              description: "Which module(s) to load. Pick all that fit.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const requested = params.modules.filter((module): module is string => typeof module === "string");
          const getGuidelines = await loadGuidelinesFn();
          if (!getGuidelines) {
            throw new Error(
              "The design guidelines are unavailable: the generative-ui package could not be loaded. "
              + "Continue with your best judgment and keep widgets self-contained.",
            );
          }
          return {
            content: [{ type: "text" as const, text: getGuidelines(requested) }],
            details: { modules: requested },
          };
        },
      }));

      pi.registerTool(defineTool({
        name: "show_widget",
        label: "Show Widget",
        description:
          "Render a chart, graph, plot, diagram, dashboard, or interactive visualization for the user: "
          + "bar charts, pie charts, flowcharts, SVG graphics and images, HTML widgets, games, calculators, mockups. "
          + "Draws charts with Chart.js or hand-drawn SVG and renders them inline in the conversation with full CSS/JS/Canvas support. "
          + "Use it whenever the user wants a picture, drawing, illustration or interactive app instead of text. "
          + "IMPORTANT: Call visualize_read_me once before your first show_widget call.",
        promptSnippet:
          "Render interactive HTML/SVG widgets inline in the conversation. Supports full CSS, JS, Canvas, Chart.js.",
        promptGuidelines: [
          "Use show_widget when the user asks for visual content: charts, diagrams, interactive explainers, UI mockups, art.",
          "Always call visualize_read_me first to load design guidelines, then set i_have_seen_read_me: true.",
          "The widget renders inline in the conversation — never tell the user you opened a window; they can open one themselves from the widget card.",
          "Structure HTML as fragments: no DOCTYPE/<html>/<head>/<body>. Style first, then HTML, then scripts.",
          "Keep widgets focused and appropriately sized. Default is 800x600 but adjust to fit content.",
          "For interactive explainers: sliders, live calculations, Chart.js charts.",
          "For SVG: start code with <svg> tag, it will be auto-detected.",
          "Be concise in your responses",
        ],
        // Not declared per request; tool_search loads it when a task asks for a
        // chart, diagram or widget.
        exposure: "deferred",
        parameters: Type.Object({
          i_have_seen_read_me: Type.Boolean({
            description: "Confirm you have already called visualize_read_me in this conversation.",
          }),
          title: Type.String({
            description: "Short snake_case identifier for this widget (shown as the widget card title).",
          }),
          widget_code: Type.String({
            description:
              "HTML or SVG code to render. For SVG: raw SVG starting with <svg>. "
              + "For HTML: raw content fragment, no DOCTYPE/<html>/<head>/<body>.",
          }),
          width: Type.Optional(Type.Number({ description: "Widget width in pixels. Default: 800." })),
          height: Type.Optional(Type.Number({ description: "Widget height in pixels. Default: 600." })),
          floating: Type.Optional(Type.Boolean({ description: "Kept for compatibility; inline rendering ignores it." })),
        }),
        async execute(_toolCallId, params) {
          if (!params.i_have_seen_read_me) {
            throw new Error(
              "You must call visualize_read_me before show_widget. Set i_have_seen_read_me: true after doing so.",
            );
          }
          const code = params.widget_code;
          const isSVG = code.trimStart().startsWith("<svg");
          const title = params.title.replace(/_/g, " ");
          const width = params.width ?? 800;
          const height = params.height ?? 600;
          return {
            content: [{ type: "text" as const, text: widgetInlineResultText(title, width, height) }],
            details: { title: params.title, width, height, isSVG },
          };
        },
      }));

      // Deferred tools are reachable only through tool_search, and that tool
      // registers inactive. Activate it before every run (idempotent) so the
      // model can discover the widget tools when a task needs them — the same
      // job the MCP extension does for servers with deferred tools. Only a
      // tool of that name that declares `reachesTools` counts, so a same-named
      // tool from another extension is never activated. When tool_search is
      // absent (removed by -builtin:tool-search or --no-extensions) the widget
      // tools simply stay undiscoverable in that session.
      const TOOL_SEARCH_TOOL_NAME = "tool_search";
      pi.on("before_agent_start", () => {
        const hasToolSearch = pi
          .getAllTools()
          .some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME && tool.reachesTools);
        if (!hasToolSearch) return;
        const active = pi.getActiveTools();
        if (!active.includes(TOOL_SEARCH_TOOL_NAME)) {
          pi.setActiveTools([...active, TOOL_SEARCH_TOOL_NAME]);
        }
      });
    },
  };
}

const TOOL_CONFLICT_MESSAGE = /^Tool "(.+)" conflicts with (.+)$/;

/**
 * The builtin extension owns the generative-ui tools. The loader orders file
 * extensions before inline ones, so an installed copy of the package (a
 * user's global `~/.pi/agent` copy, a project dependency) would otherwise
 * register first and win the tool names while the session records a conflict
 * error — and that copy opens its own native window per call. Keep the
 * builtin and drop every package copy, dissolving the conflict errors both
 * directions. Defensive: when the builtin is absent the package copies stay
 * exactly as loaded (the pi CLI path keeps working on its own).
 */
export function preferBuiltinGenerativeUiExtension(base: LoadExtensionsResult): LoadExtensionsResult {
  const hasBuiltin = base.extensions.some((extension) => extension.path === GENERATIVE_UI_EXTENSION_PATH);
  if (!hasBuiltin) return base;
  const dropped = new Set(base.extensions
    .filter((extension) => isGenerativeUiExtensionPath(extension.path))
    .map((extension) => extension.path));
  if (dropped.size === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !dropped.has(extension.path)),
    errors: base.errors.filter((error) => {
      if (dropped.has(error.path)) return false;
      const conflict = TOOL_CONFLICT_MESSAGE.exec(error.error);
      if (!conflict) return true;
      return !dropped.has(conflict[2]);
    }),
  };
}
