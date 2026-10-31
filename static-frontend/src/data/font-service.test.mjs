/**
 * Tests for the static app's IPC font service (static-frontend/src/data/font-service.ts):
 * - appearance.fontsGet: reading font preferences over IPC
 * - appearance.fontsSet: writing font preferences over IPC
 * - desktop.fonts: enumerating native installed fonts over IPC
 * - error surfaces and unbound refusal
 */

import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const jiti = createJiti(import.meta.url, {
  alias: { "@": repoRoot },
  interopDefault: true,
});

const {
  bindFontService,
  fetchFontPreferences,
  saveFontPreferences,
  listInstalledFontsFromService,
  fetchInstalledFonts,
  isFontServiceBound,
} = await jiti.import("./font-service.ts");
const { IpcClient, MockTransport } = await jiti.import("../ipc/client.ts");

function setupBound(handler) {
  const mock = new MockTransport();
  if (handler) {
    for (const [op, impl] of Object.entries(handler)) {
      mock.on(op, impl);
    }
  }
  const client = new IpcClient(mock);
  bindFontService(client);
  return mock;
}

test("isFontServiceBound reports binding state", () => {
  const mock = new MockTransport();
  const client = new IpcClient(mock);
  bindFontService(client);
  assert.equal(isFontServiceBound(), true);
});

test("fetchFontPreferences reads via appearance.fontsGet over IPC", async () => {
  const calls = [];
  setupBound({
    "appearance.fontsGet": () => {
      calls.push("appearance.fontsGet");
      return { fonts: { ui: "Microsoft YaHei", mono: "Consolas" } };
    },
  });

  const fonts = await fetchFontPreferences();
  assert.deepEqual(calls, ["appearance.fontsGet"]);
  assert.deepEqual(fonts, { ui: "Microsoft YaHei", mono: "Consolas" });
});

test("fetchFontPreferences handles null fonts as default/null", async () => {
  setupBound({
    "appearance.fontsGet": () => ({ fonts: null }),
  });

  const fonts = await fetchFontPreferences();
  assert.equal(fonts, null);
});

test("fetchFontPreferences surfaces protocol errors honestly", async () => {
  const mock = new MockTransport();
  // No handler registered: request will fail as unknown_op
  const client = new IpcClient(mock);
  bindFontService(client);

  await assert.rejects(
    () => fetchFontPreferences(),
    /no handler for 'appearance\.fontsGet'/,
  );
});

test("saveFontPreferences writes via appearance.fontsSet over IPC", async () => {
  const calls = [];
  setupBound({
    "appearance.fontsSet": (args) => {
      calls.push(args);
      return { fonts: args.fonts };
    },
  });

  const draft = { ui: "Segoe UI", mono: "Fira Code" };
  await saveFontPreferences(draft);
  assert.deepEqual(calls, [{ fonts: draft }]);
});

test("saveFontPreferences surfaces failure from host", async () => {
  const mock = new MockTransport();
  mock.fail("appearance.fontsSet", { code: "invalid_args", message: "Invalid fonts" });
  const client = new IpcClient(mock);
  bindFontService(client);

  await assert.rejects(
    () => saveFontPreferences({ ui: "bad; style", mono: "Consolas" }),
    /Invalid fonts/,
  );
});

test("listInstalledFontsFromService enumerates native fonts via desktop.fonts", async () => {
  const calls = [];
  setupBound({
    "desktop.fonts": () => {
      calls.push("desktop.fonts");
      return {
        fonts: [
          { family: "Microsoft YaHei", names: [{ lang: "zh-cn", name: "微软雅黑" }] },
          { family: "Consolas" },
          { family: "User Installed UI" },
        ],
      };
    },
  });

  const fonts = await listInstalledFontsFromService();
  assert.deepEqual(calls, ["desktop.fonts"]);
  assert.equal(fonts.length, 3);
  assert.equal(fonts[0].family, "Consolas");
  assert.equal(fonts[1].family, "Microsoft YaHei");
  assert.equal(fonts[2].family, "User Installed UI");
});

test("fetchInstalledFonts routes to listInstalledFontsFromService", async () => {
  setupBound({
    "desktop.fonts": () => ({
      fonts: [{ family: "Consolas" }],
    }),
  });

  const fonts = await fetchInstalledFonts();
  assert.equal(fonts.length, 1);
  assert.equal(fonts[0].family, "Consolas");
});

test("listInstalledFontsFromService rejects when empty fonts returned", async () => {
  setupBound({
    "desktop.fonts": () => ({ fonts: [] }),
  });

  await assert.rejects(
    () => listInstalledFontsFromService(),
    /No installed fonts found/,
  );
});
