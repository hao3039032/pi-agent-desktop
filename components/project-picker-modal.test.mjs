import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const AnimatedDropdown = () => null;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// The project-picker dialog regressed into a ~30px strip: ProjectPicker's
// "block" dropdown is absolutely positioned, which neither sizes nor fits the
// `overflow:hidden` dialog shell. The modal variant must render the list in
// normal flow inside the shell, keep the >7-project filter, and stay a plain
// trigger dropdown everywhere else.
function harness() {
  const states = [], effects = [], layoutEffects = [], dependencies = [];
  let cursor = 0, effectCursor = 0, layoutCursor = 0;
  const mocks = {
    react: {
      useState(value) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof value === "function" ? value() : value;
        return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
      },
      useEffect(fn, deps) {
        const index = effectCursor++;
        if (!dependencies["e" + index] || deps.some((v, n) => v !== dependencies["e" + index][n])) {
          dependencies["e" + index] = deps; effects.push(fn);
        }
      },
      useLayoutEffect(fn, deps) {
        const index = layoutCursor++;
        if (!dependencies["l" + index] || deps.some((v, n) => v !== dependencies["l" + index][n])) {
          dependencies["l" + index] = deps; layoutEffects.push(fn);
        }
      },
      useCallback(fn) { return fn; },
      useRef: () => ({ current: null }),
    },
    "./DirectoryPicker": { DirectoryPicker: () => null },
    "./path-ui": { AnimatedDropdown, PathLabel: ({ text }) => text, displayCwd: (p) => p },
    "@/lib/desktop-updater": { isTauriDesktop: () => true },
    "@/lib/desktop-window": { selectDirectoryNative: async () => null },
    "@/lib/ime": { isImeComposing: () => false },
  };
  const source = readFileSync(new URL("./ProjectPicker.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiledModule = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: compiledModule.exports, module: compiledModule,
    require: (name) => name === "react" ? mocks.react : mocks[name] ?? require(name),
  });
  function flatten(node) {
    if (Array.isArray(node)) return node.flatMap(flatten);
    if (!node || typeof node !== "object") return [];
    return [node, ...flatten(node.props?.children)];
  }
  return (props) => {
    cursor = 0; effectCursor = 0; layoutCursor = 0;
    const tree = compiledModule.exports.ProjectPicker({
      homeDir: "C:\\Users\\u", onSelectCwd: () => {}, ...props,
    });
    effects.splice(0).forEach((fn) => fn());
    layoutEffects.splice(0).forEach((fn) => fn());
    return flatten(tree);
  };
}

const PROJECTS = Array.from({ length: 9 }, (_, i) => `C:\\projects\\p${i + 1}`);

test("modal variant renders the open list in normal flow with no trigger button", () => {
  const view = harness();
  const nodes = view({ recentProjects: PROJECTS, selectedCwd: null, selectedProject: null, variant: "modal" });
  assert.equal(nodes.some((n) => typeof n.props?.className === "string" && /sidebar-header-row|native-toolbar-button/.test(n.props.className)), false,
    "no dropdown trigger inside the dialog shell");
  const panel = nodes.find((n) => n.type === AnimatedDropdown);
  assert.ok(panel, "the list panel is mounted");
  assert.equal(panel.props.open, true, "the panel is open without a click");
  assert.equal(panel.props.style.position, "static", "normal flow, not absolute, so the shell gets its height");
  assert.equal(panel.props.style.display, "flex");
  const list = nodes.find((n) => n.props?.style?.overflowY === "auto");
  assert.ok(list, "the scroll area is there");
  assert.equal(list.props.style.flex, "1 1 auto", "the list shrinks and scrolls on short screens");
  assert.equal(list.props.style.minHeight, 0);
});

test("modal keeps the >7-project filter and the full matching list", () => {
  const view = harness();
  const rows = (nodes) => nodes.filter((n) => n.type === "button" && typeof n.props?.title === "string" && n.props.title.includes("projects"));
  let nodes = view({ recentProjects: PROJECTS, selectedCwd: null, selectedProject: null, variant: "modal" });
  const filter = nodes.find((n) => n.type === "input" && n.props?.["aria-label"] === "Filter projects");
  assert.ok(filter, "the filter box shows beyond the 7-entry cap");
  assert.equal(rows(nodes).length, 7, "unfiltered list keeps the cap");
  filter.props.onChange({ target: { value: "p" } });
  nodes = view({ recentProjects: PROJECTS, selectedCwd: null, selectedProject: null, variant: "modal" });
  assert.equal(rows(nodes).length, PROJECTS.length,
    "filtering searches the whole list, not the capped slice");
});

test("block variant keeps its trigger button and a closed dropdown", () => {
  const view = harness();
  const nodes = view({ recentProjects: PROJECTS.slice(0, 3), selectedCwd: null, selectedProject: null, variant: "block" });
  assert.ok(nodes.some((n) => typeof n.props?.className === "string" && n.props.className.includes("sidebar-header-row")),
    "the sidebar empty state keeps its trigger");
  const panel = nodes.find((n) => n.type === AnimatedDropdown);
  assert.equal(panel?.props.open, false, "the dropdown still waits for a click");
  assert.equal(panel?.props.style.position, "absolute");
});

test("both dialog entries use the modal variant and wire Escape/focus through the shared helpers", () => {
  const sidebar = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  const modalEntries = sidebar.match(/variant="modal"/g) ?? [];
  assert.equal(modalEntries.length, 2, "continue-in-project and the + button both use the modal presentation");
  assert.match(sidebar, /focusModalPanel\(document, shellRef\.current\)/);
  assert.match(sidebar, /listenForPanelEscape\(document/);
  assert.match(sidebar, /ProjectPickerOverlay/);
  const css = readFileSync(new URL("../app/native-theme.css", import.meta.url), "utf8");
  assert.match(css, /\.project-picker-modal-shell \.app-menu\s*{\s*border: none !important;/,
    "the nested menu surface is cancelled inside the shell");
});
