import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  GENERATIVE_UI_EXTENSION_NAME,
  createGenerativeUiExtension,
  generativeUiPackageDir,
  isGenerativeUiExtensionPath,
  loadAvailableModules,
  loadGuidelinesFn,
  preferBuiltinGenerativeUiExtension,
  widgetInlineResultText,
} = await createJiti(import.meta.url).import("./generative-ui.ts");

const INLINE_PATH = `<inline:${GENERATIVE_UI_EXTENSION_NAME}>`;

function extensionAt(path, tools = ["show_widget", "visualize_read_me"]) {
  return { path, tools: new Map(tools.map((name) => [name, {}])) };
}

/** Loads the factory into a stub pi and returns the registered tools by name. */
function makePi(overrides = {}) {
  const tools = new Map();
  const handlers = new Map();
  const activeTools = ["read"];
  return {
    __tools: tools,
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, handler),
    getAllTools: () => [{ name: "tool_search", reachesTools: () => "all" }],
    getActiveTools: () => activeTools.slice(),
    setActiveTools: (names) => activeTools.splice(0, activeTools.length, ...names),
    __handlers: handlers,
    __activeTools: activeTools,
    ...overrides,
  };
}

/** The registered tools of a factory, keyed by name. */
async function registerTools(extension) {
  const pi = makePi();
  await extension.factory(pi);
  return pi;
}


test("the dependency ships and resolves from this checkout", () => {
  const dir = generativeUiPackageDir();
  assert.ok(dir, "the app's generative-ui copy must resolve when the dependency is installed");
  assert.ok(dir.endsWith("pi-extension-generative-ui"));
});

test("the factory registers both tools with the package's schema", async () => {
  const pi = await registerTools(createGenerativeUiExtension());
  assert.deepEqual([...pi.__tools.keys()].sort(), ["show_widget", "visualize_read_me"]);

  const schema = pi.__tools.get("show_widget").parameters;
  assert.ok(Array.isArray(schema.required) && schema.required.includes("i_have_seen_read_me"), "the read_me gate stays required");
  for (const property of ["i_have_seen_read_me", "title", "widget_code", "width", "height", "floating"]) {
    assert.ok(schema.properties?.[property], `${property} is part of the schema (floating kept for compatibility)`);
  }

  const readMe = pi.__tools.get("visualize_read_me");
  assert.ok(readMe.parameters.properties?.modules, "modules parameter present");
  const modules = await loadAvailableModules();
  assert.deepEqual(
    [...readMe.parameters.properties.modules.items.enum],
    [...modules],
    "the modules enum matches the package's AVAILABLE_MODULES",
  );
});

test("visualize_read_me returns the package guidelines text", async () => {
  const pi = await registerTools(createGenerativeUiExtension());
  const result = await pi.__tools.get("visualize_read_me").execute("call-1", { modules: ["chart"] });
  const text = result.content[0].text;
  // Integration assertion: the text is the package's guidelines, not a stub.
  assert.ok(text.length > 5000, `guidelines text is substantial (${text.length} chars)`);
  assert.match(text, /Chart\.js/);
  assert.deepEqual(result.details, { modules: ["chart"] });
});

test("show_widget keeps the read_me gate, renders inline and never touches glimpse", async () => {
  const pi = await registerTools(createGenerativeUiExtension());
  const widget = pi.__tools.get("show_widget");

  await assert.rejects(
    () => widget.execute("call-1", { i_have_seen_read_me: false, title: "t", widget_code: "<b>x</b>" }),
    /must call visualize_read_me/,
  );

  const result = await widget.execute("call-2", {
    i_have_seen_read_me: true,
    title: "sales_dashboard",
    widget_code: "<svg viewBox='0 0 10 10'><circle cx='5' cy='5' r='4'/></svg>",
    width: 640,
    height: 480,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content, [{
    type: "text",
    text: widgetInlineResultText("sales dashboard", 640, 480),
  }]);
  assert.match(result.content[0].text, /rendered inline in the conversation/);
  assert.deepEqual(result.details, { title: "sales_dashboard", width: 640, height: 480, isSVG: true });
  // Structurally: the factory registers no commands, and execute touches
  // nothing but its arguments — nothing in the session process opens a window.
});

test("the tools are deferred and the factory keeps tool_search active", async () => {
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, handler),
    getAllTools: () => [{ name: "tool_search", reachesTools: () => "all" }],
    getActiveTools: () => activeTools.slice(),
    setActiveTools: (names) => activeTools.splice(0, activeTools.length, ...names),
  };
  const activeTools = ["read", "bash"];
  await createGenerativeUiExtension().factory(pi);

  // Deferred: not declared per request — tool_search discovers them on demand.
  assert.equal(tools.get("show_widget").exposure, "deferred");
  assert.equal(tools.get("visualize_read_me").exposure, "deferred");

  const beforeAgentStart = handlers.get("before_agent_start");
  assert.ok(beforeAgentStart, "the factory registers before_agent_start");
  beforeAgentStart();
  assert.deepEqual(activeTools, ["read", "bash", "tool_search"], "tool_search joins the active set");
  // Idempotent: a second run does not duplicate it.
  beforeAgentStart();
  assert.deepEqual(activeTools, ["read", "bash", "tool_search"]);
});

test("tool_search is not activated when it is absent or not a discovery tool", async () => {
  const handlers = new Map();
  const activeTools = ["read"];
  const pi = {
    registerTool: () => {},
    on: (event, handler) => handlers.set(event, handler),
    getAllTools: () => [],
    getActiveTools: () => activeTools.slice(),
    setActiveTools: (names) => activeTools.splice(0, activeTools.length, ...names),
  };
  await createGenerativeUiExtension().factory(pi);
  handlers.get("before_agent_start")();
  assert.deepEqual(activeTools, ["read"]);

  // A same-named tool without reachesTools is not the discovery tool.
  const lookalike = {
    registerTool: () => {},
    on: (event, handler) => handlers.set(event, handler),
    getAllTools: () => [{ name: "tool_search" }],
    getActiveTools: () => activeTools.slice(),
    setActiveTools: (names) => activeTools.splice(0, activeTools.length, ...names),
  };
  await createGenerativeUiExtension().factory(lookalike);
  handlers.get("before_agent_start")();
  assert.deepEqual(activeTools, ["read"]);
});

test("the factory registers no commands (no gallery, no auto-popups)", async () => {
  const commands = [];
  const pi = makePi({ registerCommand: (name) => commands.push(name) });
  await createGenerativeUiExtension().factory(pi);
  assert.deepEqual(commands, []);
});

test("guidelines load through the package's own getGuidelines", async () => {
  const getGuidelines = await loadGuidelinesFn();
  assert.ok(getGuidelines, "the package's guidelines must load from an installed checkout");
  const all = getGuidelines([...await loadAvailableModules()]);
  assert.ok(all.length > 20_000, "all modules together produce the full guidelines");
});

test("preferBuiltinGenerativeUiExtension drops package copies and dissolves both conflict directions", () => {
  const builtin = extensionAt(INLINE_PATH);
  const userCopy = extensionAt("/home/u/.pi/agent/npm/node_modules/@ryan_nookpi/pi-extension-generative-ui/index.ts");
  const unrelated = { path: "/tmp/other.ts", tools: new Map([["search", {}]]) };
  const base = {
    extensions: [userCopy, builtin, unrelated],
    errors: [
      // Inline loads after files: the builtin carries the conflict error.
      { path: INLINE_PATH, error: `Tool "show_widget" conflicts with ${userCopy.path}` },
      // Defensive: the other direction dissolves too.
      { path: userCopy.path, error: `Tool "visualize_read_me" conflicts with ${INLINE_PATH}` },
      { path: userCopy.path, error: "failed to load skill" },
      { path: unrelated.path, error: "boom" },
    ],
  };

  const result = preferBuiltinGenerativeUiExtension(base);
  assert.deepEqual(result.extensions.map((extension) => extension.path), [INLINE_PATH, "/tmp/other.ts"]);
  assert.deepEqual(result.errors, [{ path: unrelated.path, error: "boom" }]);
});

test("without the builtin, package copies stay exactly as loaded", () => {
  const a = extensionAt("/opt/a/node_modules/@ryan_nookpi/pi-extension-generative-ui/index.ts");
  const b = extensionAt("/opt/b/node_modules/@ryan_nookpi/pi-extension-generative-ui/index.ts");
  const base = { extensions: [a, b], errors: [{ path: a.path, error: "boom" }] };
  assert.equal(preferBuiltinGenerativeUiExtension(base), base);
});

test("with the builtin and no package copies, nothing changes", () => {
  const base = { extensions: [extensionAt(INLINE_PATH)], errors: [] };
  assert.equal(preferBuiltinGenerativeUiExtension(base), base);
});

test("extension paths are recognized by package name segment", () => {
  assert.equal(isGenerativeUiExtensionPath("/home/u/.pi/agent/npm/node_modules/@ryan_nookpi/pi-extension-generative-ui/index.ts"), true);
  assert.equal(isGenerativeUiExtensionPath("C:\\pi\\node_modules\\@ryan_nookpi\\pi-extension-generative-ui\\index.ts"), true);
  assert.equal(isGenerativeUiExtensionPath("/tmp/other/index.ts"), false);
  assert.equal(isGenerativeUiExtensionPath("/tmp/pi-extension-generative-ui-lookalike/index.ts"), false);
  assert.equal(isGenerativeUiExtensionPath(INLINE_PATH), false);
});
