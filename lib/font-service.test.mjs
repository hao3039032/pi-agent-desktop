/**
 * Tests for the font service seam (lib/font-service.ts):
 * - isFontServiceBound returns false in Next mode
 * - listInstalledFontsFromService throws in Next mode
 * - HTTP fetch / save roundtrips when fetch is present
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  fetchFontPreferences,
  saveFontPreferences,
  isFontServiceBound,
  listInstalledFontsFromService,
} = await jiti.import("./font-service.ts");

test("font service seam is not bound in Next.js mode", () => {
  assert.equal(isFontServiceBound(), false);
});

test("listInstalledFontsFromService throws when called in Next.js mode", async () => {
  await assert.rejects(
    () => listInstalledFontsFromService(),
    /Font service IPC bridge is only available in the static build/,
  );
});

test("fetchFontPreferences handles HTTP success and null", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ fonts: { ui: "Microsoft YaHei", mono: "Consolas" } }), { status: 200 });

    const fonts = await fetchFontPreferences();
    assert.deepEqual(fonts, { ui: "Microsoft YaHei", mono: "Consolas" });

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ fonts: null }), { status: 200 });

    const nullFonts = await fetchFontPreferences();
    assert.equal(nullFonts, null);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "failed" }), { status: 500 });

    await assert.rejects(() => fetchFontPreferences(), /Could not read fonts/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("saveFontPreferences posts JSON and handles error", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let capturedBody = null;
    globalThis.fetch = async (_url, options) => {
      capturedBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ fonts: capturedBody.fonts }), { status: 200 });
    };

    const draft = { ui: "Segoe UI", mono: "Fira Code" };
    await saveFontPreferences(draft);
    assert.deepEqual(capturedBody, { fonts: draft });

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "failed" }), { status: 500 });

    await assert.rejects(() => saveFontPreferences(draft), /Could not save fonts/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
