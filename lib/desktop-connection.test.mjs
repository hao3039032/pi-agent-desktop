import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("the app shell does not probe local-server health or show a global offline banner", async () => {
  const source = await readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /useDesktopConnection|desktop-connection|retryConnection|connectionState/);
  assert.doesNotMatch(source, /connection\.(offline|retry)/);
  await assert.rejects(access(new URL("./desktop-connection.ts", import.meta.url)), { code: "ENOENT" });
});

test("removed offline-banner translations stay absent", async () => {
  const source = await readFile(new URL("./i18n/locale-plugins.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"connection\.(offline|retry)"/);
});
