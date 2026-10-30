import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { DesktopUpgradeError, toDesktopUpgradeError } = await jiti.import("./desktop-updater.ts");
const source = await readFile(new URL("./desktop-updater.ts", import.meta.url), "utf8");

test("a transport failure keeps every host the shell actually tried", () => {
  const error = toDesktopUpgradeError({
    kind: "transport",
    message: "Download request failed with status: 404",
    attemptedHosts: ["github.com", "gh-proxy.com"],
  });
  assert.ok(error instanceof DesktopUpgradeError);
  assert.equal(error.kind, "transport");
  assert.deepEqual(error.attemptedHosts, ["github.com", "gh-proxy.com"]);
});

test("a signature failure stays a signature failure and keeps its own words", () => {
  // A minisign or signed-version mismatch must never be relabelled as a
  // network problem: the sentence explains that the endpoint may have been
  // tampered with, and there is no "try the network again" remedy for it.
  const error = toDesktopUpgradeError({
    kind: "signature",
    message: "The update was signed for version 0.7.8 but the update endpoint announced version 9.9.9.",
    attemptedHosts: ["github.com", "gh-proxy.com"],
  });
  assert.equal(error.kind, "signature");
  assert.match(error.message, /signed for version 0\.7\.8/);
});

test("unknown or malformed shell failures degrade to a generic error", () => {
  for (const payload of [null, undefined, "boom", { kind: "nonsense" }, {}, 42]) {
    const error = toDesktopUpgradeError(payload);
    assert.equal(error.kind, "other", JSON.stringify(payload));
    assert.ok(error.message.length > 0);
  }
  const hosts = toDesktopUpgradeError({ kind: "transport", message: "x", attemptedHosts: [1, "a.com"] });
  assert.deepEqual(hosts.attemptedHosts, ["a.com"]);
});

test("the busy state is armed before the first await", () => {
  // The native check waits on the network; until it answers, the button must
  // already be disabled and the settings dialog already held open. Anything
  // asynchronous before this call leaves that window open.
  const body = source.slice(source.indexOf("export async function installLatestDesktopRelease"));
  const firstAwait = body.indexOf("await ");
  const armed = body.indexOf('onProgress({ phase: "checking" })');
  assert.ok(armed > 0, "the checking progress must be reported");
  assert.ok(firstAwait > armed, "checking must be reported before any await");
});

test("the webview cannot supply a download URL, mirror or signature", () => {
  // The native command's contract: no arguments at all, so a compromised page
  // cannot point the installer at its own host.
  // Exactly one argument: the command name. No payload object at all.
  assert.match(source, /invoke<NativeOutcome>\("install_available_update"\);/);
  const call = source.match(/invoke<NativeOutcome>\([^)]*\)/)?.[0] ?? "";
  assert.equal(call, 'invoke<NativeOutcome>("install_available_update")');
});

test("an unreadable manifest is neither a network outage nor an install failure", () => {
  // An HTML error page from a mirror is a verdict about the metadata, so the
  // UI must not tell the user to retry later as if the network were down.
  const error = toDesktopUpgradeError({
    kind: "manifest",
    message: "Could not fetch a valid release JSON from the remote",
    attemptedHosts: ["github.com", "gh-proxy.com"],
  });
  assert.equal(error.kind, "manifest");
  assert.match(error.message, /valid release JSON/);
  assert.deepEqual(error.attemptedHosts, ["github.com", "gh-proxy.com"]);
});

test("the progress payload carries the host actually serving the bytes", () => {
  // The renderer names a mirror only while that mirror is downloading, so the
  // progress reset at a source switch is explained rather than surprising.
  assert.match(source, /sourceHost: payload\.sourceHost/);
});
