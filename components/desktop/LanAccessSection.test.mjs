import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./LanAccessSection.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Run the real component with controlled hook state and native promises. No
// DOM/WebView is needed: the in-app confirmation is a mock component whose
// props are asserted, and the switch/status/URL list come from the tree.
function harness({
  read = async () => false,
  status = async () => ({ port: 30141, lanListening: false, addresses: [{ address: "192.168.1.20", interface: "en0" }] }),
  save = async () => {},
  copy = async () => {},
  password = async () => ({ enabled: true, managed: false, corrupt: false }),
} = {}) {
  const states = [], effects = [], dependencies = [], calls = [];
  let cursor = 0, effectCursor = 0;
  const ConfigSwitch = () => null;
  const ConfigButton = () => null;
  const ChatConfirmDialog = () => null;
  const native = {
    getLanAccessNative: async () => read(),
    lanAddressesNative: async () => status(),
    setLanAccessNative: async (next) => { calls.push(["save", next]); await save(next); },
    browserPasswordNative: async () => { calls.push(["password"]); return password(); },
    isBrowserPasswordUsable: (s) => Boolean(s && (s.managed || (s.enabled && !s.corrupt))),
    handleExternalLinkClick: () => {},
  };
  const mocks = {
    react: {
      useState(value) {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof value === "function" ? value() : value;
        return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
      },
      useRef(value) {
        const index = cursor++;
        if (!(index in states)) states[index] = { current: value };
        return states[index];
      },
      useEffect(fn, deps) {
        const index = effectCursor++;
        if (!dependencies[index] || deps.some((value, n) => value !== dependencies[index][n])) {
          dependencies[index] = deps;
          effects.push(fn);
        }
      },
      useId: () => "lan-status",
    },
    "@/components/SettingsUi": { ConfigSwitch, ConfigButton },
    "@/components/ChatConfirmDialog": { ChatConfirmDialog },
    "@/hooks/useI18n": { useI18n: () => ({ t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) }) },
    "@/lib/clipboard": { copyText: async (text) => { calls.push(["copy", text]); await copy(text); } },
    "@/lib/desktop-native": native,
  };
  const compiledModule = { exports: {} };
  vm.runInNewContext(compiled, {
    window: { setTimeout: () => 0 },
    exports: compiledModule.exports,
    module: compiledModule,
    require: (name) => mocks[name] ?? require(name),
  });

  function render() {
    cursor = 0;
    effectCursor = 0;
    const tree = compiledModule.exports.LanAccessSection(currentProps);
    effects.splice(0).forEach((effect) => effect());
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
    const status = nodes.find((node) => node.props?.id === "lan-status");
    const dialog = nodes.find((node) => node.type === ChatConfirmDialog);
    return { switchProps: control?.props ?? {}, statusText: status?.props.children ?? null, nodes, dialog };
  }
  function currentDialog() {
    // Render first: a click may have changed state since the last render.
    return view().dialog ?? null;
  }
  // The parent's wiring (DesktopAppSection): the shared status starts unknown,
  // and every report from this section or its sibling updates it.
  const reported = [];
  const currentProps = {
    passwordStatus: null,
    onPasswordStatusChange: (next) => { reported.push(next); currentProps.passwordStatus = next; },
  };
  const setPasswordStatus = (next) => { currentProps.passwordStatus = next; };
  return { calls, view, currentDialog, reported, setPasswordStatus };
}

test("switch stays disabled until the preference is read, then reflects it", async () => {
  let resolveRead;
  const h = harness({ read: () => new Promise((resolve) => { resolveRead = resolve; }) });
  assert.equal(h.view().switchProps.disabled, true);
  resolveRead(true);
  await flush();
  assert.equal(h.view().switchProps.checked, true);
  assert.equal(h.view().switchProps.disabled, false);
});

test("enabling opens the shared in-app dialog first; cancel writes nothing", async () => {
  const h = harness();
  h.view();
  await flush();
  h.view().switchProps.onChange(true);
  const dialog = h.currentDialog();
  assert.ok(dialog, "the in-app confirmation opened");
  assert.equal(dialog.props.title, "appSettings.lanConfirmTitle");
  assert.equal(dialog.props.body, "appSettings.lanConfirm");
  assert.equal(dialog.props.danger, true);
  assert.equal(dialog.props.cancelLabel, "common.cancel");
  assert.deepEqual(h.calls.filter(([kind]) => kind === "save"), []);
  assert.equal(h.view().switchProps.checked, false);
  dialog.props.onCancel();
  await flush();
  assert.deepEqual(h.calls.filter(([kind]) => kind === "save"), []);
  assert.equal(h.currentDialog(), null, "cancel closes the dialog");
});

test("confirming the dialog waits for the save before the switch flips", async () => {
  let resolveSave;
  const h = harness({ save: () => new Promise((resolve) => { resolveSave = resolve; }) });
  h.view();
  await flush();
  h.view().switchProps.onChange(true);
  h.currentDialog().props.onConfirm();
  await flush();
  assert.deepEqual(h.calls.filter(([kind]) => kind === "save"), [["save", true]]);
  assert.equal(h.view().switchProps.checked, false);
  assert.equal(h.view().switchProps.disabled, true);
  resolveSave();
  await flush();
  assert.equal(h.view().switchProps.checked, true);
  assert.equal(h.view().switchProps.disabled, false);
});

test("disabling saves directly without any confirmation", async () => {
  const h = harness({
    read: async () => true,
    status: async () => ({ port: 30141, lanListening: true, addresses: [] }),
  });
  h.view();
  await flush();
  h.view().switchProps.onChange(false);
  await flush();
  assert.deepEqual(h.calls.filter(([kind]) => kind === "save"), [["save", false]]);
  assert.equal(h.currentDialog(), null);
});

test("a failing save keeps the old value, shows the error, and releases busy state", async () => {
  const h = harness({ save: async () => { throw new Error("failed"); } });
  h.view();
  await flush();
  h.view().switchProps.onChange(false);
  await flush();
  assert.equal(h.view().switchProps.checked, false);
  assert.equal(h.view().switchProps.disabled, false);
  assert.equal(h.view().statusText, "appSettings.lanError");
});

test("a failed preference read keeps the switch disabled but recoverable, and an unknown state is never claimed as pending", async () => {
  let failRead = true;
  const h = harness({
    read: () => (failRead ? Promise.reject(new Error("down")) : Promise.resolve(true)),
    status: () => new Promise(() => {}), // never answers: the state stays unknown
  });
  h.view();
  await flush();
  assert.equal(h.view().switchProps.disabled, true);
  assert.equal(h.view().statusText, "appSettings.lanError", "the failed read says so");
  const retry = h.view().nodes.find((n) => n.props?.children === "common.retry");
  assert.ok(retry, "the retry is visible even while the preference is unknown");
  failRead = false;
  retry.props.onClick();
  h.view();
  await flush();
  assert.equal(h.view().switchProps.disabled, false, "retry re-reads the preference");
  assert.equal(h.view().statusText, "appSettings.lanStatusLoading",
    "an unanswered status is loading, not \"restart pending\" or \"off\"");
});

test("a listening server lists real adapter URLs that are clickable and copyable", async () => {
  const h = harness({
    read: async () => true,
    status: async () => ({
      port: 41234,
      lanListening: true,
      addresses: [
        { address: "10.0.0.5", interface: "vEthernet (Hyper-V)" },
        { address: "192.168.1.20", interface: "en0" },
      ],
    }),
  });
  h.view();
  await flush();
  const { nodes, statusText } = h.view();
  assert.equal(statusText, "appSettings.lanActive");
  assert.deepEqual(
    nodes.filter((node) => node.type === "a").map((node) => node.props.href),
    ["http://10.0.0.5:41234", "http://192.168.1.20:41234"],
  );
  assert.deepEqual(
    nodes.filter((node) => node.props?.className === "lan-address-adapter").map((node) => node.props.children),
    ["vEthernet (Hyper-V)", "en0"],
  );
  const copyLabel = 'appSettings.lanCopyAria:{"url":"http://192.168.1.20:41234"}';
  const copyButton = h.view().nodes.find((node) => node.props?.["aria-label"] === copyLabel);
  assert.ok(copyButton, "each address has a copy control");
  copyButton.props.onClick();
  await flush();
  assert.deepEqual(h.calls.filter(([kind]) => kind === "copy"), [["copy", "http://192.168.1.20:41234"]]);
  assert.equal(
    h.view().nodes.find((node) => node.props?.["aria-label"] === copyLabel).props.children,
    "i18n.copied",
  );
});

test("a saved-but-not-restarted switch says pending, never that it is live now", async () => {
  const h = harness({
    read: async () => true,
    status: async () => ({ port: 30141, lanListening: false, addresses: [{ address: "192.168.1.20", interface: "en0" }] }),
  });
  h.view();
  await flush();
  const { nodes, statusText } = h.view();
  assert.equal(statusText, "appSettings.lanRestart");
  assert.ok(nodes.some((node) => node.props?.children === "appSettings.lanAddressesPending"));
  assert.ok(nodes.some((node) => node.type === "a" && node.props.href === "http://192.168.1.20:30141"));
});

test("a still-listening server after turning off says so instead of hiding the exposure", async () => {
  const h = harness({
    read: async () => false,
    status: async () => ({ port: 30141, lanListening: true, addresses: [{ address: "192.168.1.20", interface: "en0" }] }),
  });
  h.view();
  await flush();
  const { nodes, statusText } = h.view();
  assert.equal(statusText, "appSettings.lanStillOpen");
  assert.equal(nodes.some((node) => node.type === "a"), false, "no URL rows while the preference is off");
});

test("address failures explain themselves and offer a retry", async () => {
  const statuses = [
    async () => { throw new Error("down"); },
    async () => ({ port: 30141, lanListening: true, addresses: [] }),
    async () => ({ port: null, lanListening: true, addresses: [{ address: "192.168.1.20", interface: "en0" }] }),
    async () => ({ port: 30141, lanListening: true, addresses: [{ address: "192.168.1.20", interface: "en0" }] }),
  ];
  let read = 0;
  const h = harness({ read: async () => true, status: () => statuses[read++]() });
  // A retry click changes state; the refetch happens on the next render, so
  // every step is: click, render (effect runs), let the answer land.
  const retry = async () => {
    h.view().nodes.find((node) => node.props?.children === "common.retry").props.onClick();
    h.view();
    await flush();
  };
  h.view();
  await flush();
  assert.ok(h.view().nodes.some((node) => node.props?.role === "alert"), "a failed read shows an error");
  assert.ok(h.view().nodes.some((node) => node.props?.children === "appSettings.lanStatusError"));
  await retry();
  assert.ok(h.view().nodes.some((node) => node.props?.children === "appSettings.lanNoAddresses"));
  await retry();
  assert.ok(h.view().nodes.some((node) => node.props?.children === "appSettings.lanPortUnknown"));
  assert.equal(h.view().nodes.some((node) => node.type === "a"), false, "no invented URL without a port");
  await retry();
  assert.ok(h.view().nodes.some((node) => node.type === "a" && node.props.href === "http://192.168.1.20:30141"));
});

// --- Network access requires a usable browser password first ---

test("without a usable password the switch stays disabled and says why", async () => {
  const h = harness({ password: async () => ({ enabled: false, managed: false, corrupt: false }) });
  h.view();
  await flush();
  assert.equal(h.view().switchProps.disabled, true);
  assert.equal(h.view().statusText, "appSettings.lanNeedsPassword");
});

test("a corrupt non-managed verifier fails closed; a managed (env) one satisfies the rule", async () => {
  const corrupt = harness({ password: async () => ({ enabled: true, managed: false, corrupt: true }) });
  corrupt.view();
  await flush();
  assert.equal(corrupt.view().switchProps.disabled, true, "corrupt and not managed is not usable");
  const managed = harness({ password: async () => ({ enabled: true, managed: true, corrupt: true }) });
  managed.view();
  await flush();
  assert.equal(managed.view().switchProps.disabled, false, "PI_WEB_PASSWORD manages the password");
});

test("saving a password in the sibling section enables the switch immediately through the shared status", async () => {
  const h = harness({ password: async () => ({ enabled: false, managed: false, corrupt: false }) });
  h.view();
  await flush();
  assert.equal(h.view().switchProps.disabled, true);
  // The sibling reports the successful save to the same shared status.
  h.setPasswordStatus({ enabled: true, managed: false, corrupt: false });
  h.view();
  assert.equal(h.view().switchProps.disabled, false);
});

test("a password read that fails keeps the switch disabled, and retry recovers it", async () => {
  let fail = true;
  const h = harness({ password: () => (fail ? Promise.reject(new Error("down")) : Promise.resolve({ enabled: true, managed: false, corrupt: false })) });
  h.view();
  await flush();
  assert.equal(h.view().switchProps.disabled, true, "an unknown password status fails closed");
  assert.equal(h.view().statusText, "appSettings.lanNeedsPassword");
  fail = false;
  h.view().nodes.find((node) => node.props?.children === "common.retry").props.onClick();
  h.view();
  await flush();
  assert.equal(h.view().switchProps.disabled, false, "retry re-reads the password status");
});

test("confirming the enable re-verifies the password with the server and refuses without a usable one", async () => {
  let current = { enabled: true, managed: false, corrupt: false };
  const h = harness({ password: async () => current });
  h.view();
  await flush();
  assert.equal(h.view().switchProps.disabled, false);
  h.view().switchProps.onChange(true);
  // The shared status still claims a password (e.g. a stale sibling state);
  // the re-verification at confirmation must be the authority.
  current = { enabled: false, managed: false, corrupt: false };
  h.currentDialog().props.onConfirm();
  await flush();
  assert.deepEqual(h.calls.filter(([kind]) => kind === "save"), [], "the preference is never written");
  assert.equal(h.view().switchProps.checked, false);
  assert.equal(h.view().statusText, "appSettings.lanNeedsPassword");
  assert.equal(h.view().switchProps.disabled, true, "the refreshed status fails closed");
});

test("a failing re-verification shows the error and never writes the preference", async () => {
  let fail = false;
  const h = harness({ password: () => (fail ? Promise.reject(new Error("down")) : Promise.resolve({ enabled: true, managed: false, corrupt: false })) });
  h.view();
  await flush();
  h.view().switchProps.onChange(true);
  fail = true;
  h.currentDialog().props.onConfirm();
  await flush();
  assert.deepEqual(h.calls.filter(([kind]) => kind === "save"), []);
  assert.equal(h.view().statusText, "appSettings.lanError");
});

test("removing the password while the preference is on pauses network access but turning it off stays possible", async () => {
  const h = harness({
    read: async () => true,
    status: async () => ({ port: 30141, lanListening: true, addresses: [{ address: "192.168.1.20", interface: "en0" }] }),
    password: async () => ({ enabled: true, managed: false, corrupt: false }),
  });
  h.view();
  await flush();
  assert.equal(h.view().statusText, "appSettings.lanActive");
  // The sibling removed the password: the shared status updates, the preference stays on.
  h.setPasswordStatus({ enabled: false, managed: false, corrupt: false });
  h.view();
  assert.equal(h.view().statusText, "appSettings.lanPausedNoPassword", "the exposure is shown as paused, not live");
  assert.equal(h.view().switchProps.checked, true);
  assert.equal(h.view().switchProps.disabled, false, "the switch stays operable to turn the network off");
  h.view().switchProps.onChange(false);
  await flush();
  assert.deepEqual(h.calls.filter(([kind]) => kind === "save"), [["save", false]]);
});
