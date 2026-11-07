import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const section = await readFile(new URL("./AppUpdatesSection.tsx", import.meta.url), "utf8");
const updater = await readFile(new URL("../lib/desktop-updater.ts", import.meta.url), "utf8");
const locales = await readFile(new URL("../lib/i18n/locale-plugins.ts", import.meta.url), "utf8");

test("the download route picker is the shared AppSelect, labelled for screen readers", () => {
  // One spelling per concept: the aria-label and the visible label are the same
  // translated word, and the picker is the shared form component so the popup
  // matches every other application menu.
  assert.match(section, /<AppSelect\s+aria-label=\{t\("appSettings\.downloadRoute"\)\}/);
  assert.match(section, /id="settings-update-route-label">\s*\{t\("appSettings\.downloadRoute"\)\}/);
  assert.doesNotMatch(section, /<select[\s>]/i);
});

test("a route choice persists through APP_PREF_KEYS, never a free-text field", () => {
  // The preference store owns every fork localStorage key; the picker itself is
  // the only way to set one, so no arbitrary URL can be typed or pasted.
  assert.match(section, /APP_PREF_KEYS\.updateDownloadSource/);
  assert.match(section, /setPref\(APP_PREF_KEYS\.updateDownloadSource, next\)/);
  assert.match(section, /getPref\(APP_PREF_KEYS\.updateDownloadSource\) \|\| DEFAULT_UPDATE_SOURCE_ID/);
  assert.doesNotMatch(section, /updateDownloadSource[^\n]*JSON/);
});

test("the picker locks while an update is downloading and never unlocks the dialog", () => {
  // The route cannot change mid-download (the shell holds one install at a
  // time), and the busy state that keeps Settings open is driven by
  // upgradeProgress alone — the picker adds no second busy source.
  const picker = section.slice(section.indexOf("<AppSelect"), section.indexOf("</section>"));
  assert.match(picker, /disabled=\{Boolean\(upgradeProgress\)\}/);
  assert.match(section, /onBusyChange\?\.\(busy\)/);
});

test("a saved route missing from the build's list falls back to automatic, visibly", () => {
  // A mirror removed from a newer build must not silently reroute and must not
  // be sent to the shell (which would reject the unknown id).
  assert.match(section, /const staleRoute = routeId !== effectiveRouteId/);
  assert.match(section, /sourceId: effectiveRouteId/);
  assert.match(section, /appSettings\.downloadRouteStale/);
});

test("the picker only appears when the shell offered routes, with its own retry", () => {
  // Hidden in a browser and while the list is loading or failed; a failed list
  // shows an error and a retry, and installing then uses the automatic route.
  assert.match(section, /const showRoutePicker = \(updateSources\?\.length \?\? 0\) > 0/);
  assert.match(section, /appSettings\.downloadRouteLoadFailed/);
  assert.match(section, /setSourcesAttempt\(\(attempt\) => attempt \+ 1\)/);
  assert.match(section, /t\("common\.retry"\)/);
  assert.match(section, /isTauriDesktop\(\)/);
});

test("the hint states the option's scope instead of implying the notice above followed it", () => {
  // The server-side version notice still checks automatically; only the app's
  // own update check and installer download follow the picked route.
  assert.match(section, /appSettings\.downloadRouteHint/);
  const hints = locales.match(/appSettings\.downloadRouteHint": "([^"]+)"/g) ?? [];
  assert.equal(hints.length, 3, "en, zh-CN and zh-TW must all name the scope");
});

test("every route word exists in all three locales", () => {
  for (const key of [
    "appSettings.downloadRoute",
    "appSettings.downloadRouteAuto",
    "appSettings.downloadRouteDirect",
    "appSettings.downloadRouteHint",
    "appSettings.downloadRouteStale",
    "appSettings.downloadRouteLoadFailed",
  ]) {
    const occurrences = locales.split(`"${key}"`).length - 1;
    assert.equal(occurrences, 3, `${key} must exist in en, zh-CN and zh-TW`);
  }
});

test("mirror choices are named by the shell, not composed in the page", () => {
  // The page echoes the host the shell listed; it never assembles a mirror URL
  // or a host of its own.
  assert.match(section, /: source\.host \?\? source\.id/);
  assert.doesNotMatch(section, /https:\/\/\$\{/);
  assert.match(updater, /mirror:<host>/);
});
