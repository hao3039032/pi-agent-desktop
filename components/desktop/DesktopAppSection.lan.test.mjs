import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./DesktopAppSection.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Run the real component and its event handlers with controlled hook state and
// native promises. No DOM/WebView is needed to verify the async confirmation
// and save ordering; the native capability/bridge wiring is pinned separately.
function harness({ initial = false, confirm = async () => true, save = async () => {} } = {}) {
  const states = [];
  const effects = [];
  const calls = [];
  let cursor = 0;
  let mounted = false;
  const ConfigSwitch = () => null;
  const native = {
    getLanAccessNative: async () => initial,
    isAutostartEnabledNative: async () => false,
    confirmLanAccessNative: async (...args) => { calls.push(["confirm", ...args]); return confirm(); },
    setLanAccessNative: async (next) => { calls.push(["save", next]); await save(next); },
  };
  const mocks = {
    react: {
      useState(value) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof value === "function" ? value() : value;
        return [states[index], (next) => { states[index] = next; }];
      },
      useEffect(effect) { if (!mounted) effects.push(effect); },
    },
    "@/lib/app-prefs": { APP_PREF_KEYS: {}, getPrefBool: (_, fallback) => fallback },
    "@/lib/desktop-native": native,
    "@/hooks/useI18n": { useI18n: () => ({ t: (key) => key }) },
    "@/components/SettingsUi": { ConfigSwitch, ConfigButton: () => null },
    "./useDesktopChrome": { useDesktopChrome: () => ({ isDesktop: true }) },
    "./BrowserPasswordSection": { BrowserPasswordSection: () => null },
  };
  const compiledModule = { exports: {} };
  vm.runInNewContext(compiled, { exports: compiledModule.exports, module: compiledModule, require: (name) => mocks[name] ?? require(name) });
  function render() {
    cursor = 0;
    const tree = compiledModule.exports.DesktopAppSection();
    if (!mounted) { mounted = true; effects.forEach((effect) => effect()); }
    return tree;
  }
  function elements(node) {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!node || typeof node !== "object") return [];
    return [node, ...elements(node.props?.children)];
  }
  function view() {
    const nodes = elements(render());
    const control = nodes.find((node) => node.type === ConfigSwitch && node.props.label === "appSettings.lanAccess");
    const status = nodes.find((node) => node.props?.role === "status");
    return { ...control.props, status: status.props.children };
  }
  return { calls, view };
}

test("LAN enabling waits for native confirmation, then waits for save before changing state", async () => {
  let resolveConfirm;
  let resolveSave;
  const h = harness({
    confirm: () => new Promise((resolve) => { resolveConfirm = resolve; }),
    save: () => new Promise((resolve) => { resolveSave = resolve; }),
  });
  assert.equal(h.view().disabled, true);
  await flush();
  h.view().onChange(true);
  assert.equal(h.view().disabled, true);
  assert.equal(h.view().checked, false);
  assert.deepEqual(h.calls.map(([kind]) => kind), ["confirm"]);
  resolveConfirm(true);
  await flush();
  assert.deepEqual(h.calls.map(([kind]) => kind), ["confirm", "save"]);
  assert.equal(h.view().checked, false);
  assert.equal(h.view().disabled, true);
  resolveSave();
  await flush();
  assert.equal(h.view().checked, true);
  assert.equal(h.view().disabled, false);
  assert.equal(h.view().status, "appSettings.lanRestart");
});

test("cancelled native confirmation never writes the preference", async () => {
  const h = harness({ confirm: async () => false });
  h.view();
  await flush();
  h.view().onChange(true);
  await flush();
  assert.deepEqual(h.calls.map(([kind]) => kind), ["confirm"]);
  assert.equal(h.view().checked, false);
  assert.equal(h.view().disabled, false);
  assert.equal(h.view().status, "appSettings.lanHint");
});

for (const failure of ["confirm", "save"]) {
  test(`LAN ${failure} error retains the old value and releases busy state`, async () => {
    const h = harness({ [failure]: async () => { throw new Error("failed"); } });
    h.view();
    await flush();
    h.view().onChange(true);
    await flush();
    assert.equal(h.view().checked, false);
    assert.equal(h.view().disabled, false);
    assert.equal(h.view().status, "appSettings.lanError");
    if (failure === "confirm") assert.deepEqual(h.calls.map(([kind]) => kind), ["confirm"]);
  });
}

test("disabling LAN saves without a risk-confirmation prompt", async () => {
  const h = harness({ initial: true });
  h.view();
  await flush();
  h.view().onChange(false);
  await flush();
  assert.deepEqual(h.calls, [["save", false]]);
  assert.equal(h.view().checked, false);
  assert.equal(h.view().disabled, false);
  assert.equal(h.view().status, "appSettings.lanRestart");
});
