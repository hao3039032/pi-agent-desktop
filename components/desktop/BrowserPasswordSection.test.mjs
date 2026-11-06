import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
const require = createRequire(import.meta.url);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const translate = (key) => key;

function harness(file, exported, mocks, globals = {}) {
  const states = [], effects = [], dependencies = [];
  let cursor = 0, effectCursor = 0;
  const compiledModule = { exports: {} };
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], (v) => { states[i] = typeof v === "function" ? v(states[i]) : v; }]; },
    useEffect(fn, deps) { const i = effectCursor++; if (!dependencies[i] || deps.some((d, n) => d !== dependencies[i][n])) { dependencies[i] = deps; effects.push(fn); } },
  };
  vm.runInNewContext(compiled, { ...globals, exports: compiledModule.exports, module: compiledModule, require: (name) => name === "react" ? react : mocks[name] ?? require(name) });
  function flatten(node) { if (Array.isArray(node)) return node.flatMap(flatten); if (!node || typeof node !== "object") return []; return [node, ...flatten(node.props?.children)]; }
  return () => { cursor = 0; effectCursor = 0; const tree = compiledModule.exports[exported](); effects.splice(0).forEach((fn) => fn()); return flatten(tree); };
}
const ConfigButton = () => null;
const common = { "@/hooks/useI18n": { useI18n: () => ({ t: translate }), I18nProvider: () => null }, "@/components/SettingsUi": { ConfigButton } };

test("password settings require matching new passwords and reset without the old password", async () => {
  const calls = [];
  const view = harness("./BrowserPasswordSection.tsx", "BrowserPasswordSection", { ...common, "@/lib/desktop-native": {
    browserPasswordNative: async (method = "GET", password) => { calls.push([method, password]); return { enabled: true, managed: false, corrupt: false }; },
  } });
  view(); await flush();
  const button = () => view().find((n) => n.type === ConfigButton && n.props.children === "browserPassword.reset");
  assert.equal(button().props.disabled, true);
  let inputs = view().filter((n) => n.type === "input");
  inputs[0].props.onChange({ target: { value: "a long new password" } });
  inputs[1].props.onChange({ target: { value: "does not match" } });
  assert.equal(button().props.disabled, true);
  inputs = view().filter((n) => n.type === "input");
  inputs[1].props.onChange({ target: { value: "a long new password" } });
  assert.equal(button().props.disabled, false);
  button().props.onClick(); await flush();
  assert.deepEqual(calls, [["GET", undefined], ["PUT", "a long new password"]]);
  assert.ok(view().filter((n) => n.type === "input").every((n) => n.props.value === ""));
});

test("environment-managed password has no edit fields; cancel removal writes nothing", async () => {
  const managedView = harness("./BrowserPasswordSection.tsx", "BrowserPasswordSection", { ...common, "@/lib/desktop-native": { browserPasswordNative: async () => ({ enabled: true, managed: true }) } });
  managedView(); await flush();
  assert.equal(managedView().filter((n) => n.type === "input").length, 0);
  const calls = [];
  const view = harness("./BrowserPasswordSection.tsx", "BrowserPasswordSection", { ...common, "@/lib/desktop-native": {
    browserPasswordNative: async (method = "GET") => { calls.push(method); return { enabled: true, managed: false }; },
    confirmLanAccessNative: async () => false,
  } });
  view(); await flush();
  view().find((n) => n.type === ConfigButton && n.props.children === "browserPassword.remove").props.onClick(); await flush();
  assert.deepEqual(calls, ["GET"]);
});

test("desktop login bootstrap never renders a password input, retries failures, and navigates after authentication", async () => {
  const file = "../../app/login/page.tsx";
  // Expose the real internal LoginForm only in the test compilation.
  const original = readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(original, /authenticateDesktopNative\(\)/);
  // LoginPage returns LoginForm as an element; render that component using the same hooks.
  let calls = 0;
  const destinations = [];
  const mocks = { ...common, "next/image": () => null,
    "@/lib/login-destination": { safeLoginDestination: (value) => value || "/" },
    "@/lib/desktop-native": { isTauriDesktop: () => true, authenticateDesktopNative: async () => { if (++calls === 1) throw new Error("temporary"); } },
  };
  const source = original.replace("function LoginForm()", "export function LoginForm()");
  const compiledModule = { exports: {} };
  const states = []; let cursor = 0; let dependencies;
  const effects = [];
  const react = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], (v) => { states[i] = typeof v === "function" ? v(states[i]) : v; }]; },
    useEffect(fn, deps) { if (!dependencies || deps.some((v, i) => v !== dependencies[i])) { dependencies = deps; effects.push(fn); } },
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: compiledModule.exports, module: compiledModule,
    require: (name) => name === "react" ? react : mocks[name] ?? require(name), URLSearchParams,
    window: { location: { search: "?next=%2F%3Fsession%3Dabc", origin: "http://127.0.0.1:38471", replace: (url) => destinations.push(url) } },
  });
  function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.props?.children)] : []; }
  function view() { cursor = 0; const tree = compiledModule.exports.LoginForm(); effects.splice(0).forEach((fn) => fn()); return nodes(tree); }
  assert.equal(view().some((n) => n.type === "input"), false);
  await flush();
  const retry = view().find((n) => n.type === "button");
  assert.ok(retry);
  assert.equal(view().some((n) => n.type === "input"), false);
  retry.props.onClick(); view(); await flush();
  assert.equal(calls, 2);
  assert.deepEqual(destinations, ["/?session=abc"]);
});
