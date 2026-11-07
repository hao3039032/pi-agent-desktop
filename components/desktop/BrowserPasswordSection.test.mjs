import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
const require = createRequire(import.meta.url);
const flush = () => new Promise((resolve) => setImmediate(resolve));
// One stable function per locale mock: components put `t` in effect deps, so a
// fresh closure per render would re-run those effects on every render here.
const translate = (key) => key;

function harness(file, exported, mocks, globals = {}, props) {
  const states = [], effects = [], dependencies = [];
  let cursor = 0, effectCursor = 0;
  const compiledModule = { exports: {} };
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], (v) => { states[i] = typeof v === "function" ? v(states[i]) : v; }]; },
    useRef(value) { const i = cursor++; if (!(i in states)) states[i] = { current: value }; return states[i]; },
    useEffect(fn, deps) { const i = effectCursor++; if (!dependencies[i] || deps.some((d, n) => d !== dependencies[i][n])) { dependencies[i] = deps; effects.push(fn); } },
    useId: () => "pw-validation",
  };
  vm.runInNewContext(compiled, { ...globals, exports: compiledModule.exports, module: compiledModule, require: (name) => name === "react" ? react : mocks[name] ?? require(name) });
  function flatten(node) { if (Array.isArray(node)) return node.flatMap(flatten); if (!node || typeof node !== "object") return []; return [node, ...flatten(node.props?.children)]; }
  return () => { cursor = 0; effectCursor = 0; const tree = compiledModule.exports[exported](props); effects.splice(0).forEach((fn) => fn()); return flatten(tree); };
}
const ConfigButton = () => null;
const ChatConfirmDialog = () => null;
const common = { "@/hooks/useI18n": { useI18n: () => ({ t: translate }), I18nProvider: () => null }, "@/components/SettingsUi": { ConfigButton }, "@/components/ChatConfirmDialog": { ChatConfirmDialog } };

test("password settings show why saving is unavailable and reset without the old password", async () => {
  const calls = [];
  const view = harness("./BrowserPasswordSection.tsx", "BrowserPasswordSection", { ...common, "@/lib/desktop-native": {
    browserPasswordNative: async (method = "GET", password) => { calls.push([method, password]); return { enabled: true, managed: false, corrupt: false }; },
  } });
  view(); await flush();
  const button = () => view().find((n) => n.type === ConfigButton && n.props.children === "browserPassword.reset");
  assert.equal(button().props.disabled, true);
  let inputs = view().filter((n) => n.type === "input");
  inputs[0].props.onChange({ target: { value: "short" } });
  assert.ok(view().some((n) => n.props?.id === "pw-validation" && n.props.children.includes("browserPassword.tooShort")),
    "a too-short password is explained in the form");
  inputs = view().filter((n) => n.type === "input");
  inputs[0].props.onChange({ target: { value: "a long new password" } });
  assert.equal(button().props.disabled, true);
  assert.ok(view().some((n) => n.props?.id === "pw-validation" && n.props.children === "browserPassword.needRepeat"),
    "a valid password with no repeat says why saving is unavailable");
  inputs[1].props.onChange({ target: { value: "does not match" } });
  assert.equal(button().props.disabled, true);
  assert.ok(view().some((n) => n.props?.id === "pw-validation" && n.props.children === "browserPassword.mismatch"),
    "a mismatch is explained in the form");
  inputs = view().filter((n) => n.type === "input");
  inputs[1].props.onChange({ target: { value: "a long new password" } });
  assert.equal(button().props.disabled, false);
  button().props.onClick(); await flush();
  assert.deepEqual(calls, [["GET", undefined], ["PUT", "a long new password"]]);
  assert.ok(view().filter((n) => n.type === "input").every((n) => n.props.value === ""));
});

test("environment-managed password has no edit fields; removal asks in-app and cancel writes nothing", async () => {
  const managedView = harness("./BrowserPasswordSection.tsx", "BrowserPasswordSection", { ...common, "@/lib/desktop-native": { browserPasswordNative: async () => ({ enabled: true, managed: true }) } });
  managedView(); await flush();
  assert.equal(managedView().filter((n) => n.type === "input").length, 0);
  const calls = [];
  const view = harness("./BrowserPasswordSection.tsx", "BrowserPasswordSection", { ...common, "@/lib/desktop-native": {
    browserPasswordNative: async (method = "GET") => { calls.push(method); return { enabled: true, managed: false }; },
  } });
  view(); await flush();
  view().find((n) => n.type === ConfigButton && n.props.children === "browserPassword.remove").props.onClick();
  const dialog = view().find((n) => n.type === ChatConfirmDialog);
  assert.ok(dialog, "removal opens the shared in-app confirmation");
  assert.equal(dialog.props.danger, true);
  assert.equal(dialog.props.cancelLabel, "common.cancel");
  dialog.props.onCancel();
  view();
  assert.deepEqual(calls, ["GET"], "cancel never reaches the API");
  dialog.props.onConfirm();
  await flush();
  assert.deepEqual(calls, ["GET", "DELETE"], "confirm removes the password");
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

test("every learned password status is reported so the sibling network switch can react", async () => {
  const reported = [];
  let saved = false;
  const view = harness("./BrowserPasswordSection.tsx", "BrowserPasswordSection", { ...common, "@/lib/desktop-native": {
    browserPasswordNative: async (method = "GET") => {
      if (method === "PUT") saved = true;
      if (method === "DELETE") saved = false;
      return { enabled: saved, managed: false, corrupt: false };
    },
  } }, {}, { onStatusChange: (status) => reported.push(status) });
  view(); await flush();
  assert.deepEqual(reported, [{ enabled: false, managed: false, corrupt: false }], "the initial read is reported");
  view().filter((n) => n.type === "input")[0].props.onChange({ target: { value: "a long new password" } });
  view().filter((n) => n.type === "input")[1].props.onChange({ target: { value: "a long new password" } });
  view().find((n) => n.type === ConfigButton && n.props.children === "browserPassword.set").props.onClick();
  await flush();
  assert.deepEqual(reported[1], { enabled: true, managed: false, corrupt: false }, "a successful save reports immediately");
  view().find((n) => n.type === ConfigButton && n.props.children === "browserPassword.remove").props.onClick();
  view().find((n) => n.type === ChatConfirmDialog).props.onConfirm();
  await flush();
  assert.deepEqual(reported[2], { enabled: false, managed: false, corrupt: false }, "a removal reports the now-missing password");
});
