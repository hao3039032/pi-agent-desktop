import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  DEFAULT_UPDATE_SOURCE_ID,
  DesktopUpgradeError,
  resolveDesktopUpdateSourceId,
  toDesktopUpgradeError,
  toDesktopUpdateSources,
} = await jiti.import("./desktop-updater.ts");
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

test("the webview may name a route id, never a URL or signature", () => {
  // The native command's contract: one payload key, a route id the shell
  // compiled in and re-validates. A compromised page cannot point the
  // installer at its own host, name a mirror host, or supply bytes metadata.
  const call = source.match(/invoke<NativeOutcome>\(\s*"install_available_update"[\s\S]*?\);/)?.[0] ?? "";
  assert.ok(call.includes("install_available_update"), "the install command must be invoked");
  const payload = call.slice(call.indexOf("{"), call.lastIndexOf("}") + 1);
  assert.ok(
    /source:\s*options\.sourceId\s*\?\?\s*DEFAULT_UPDATE_SOURCE_ID/.test(payload),
    "the payload must be exactly the resolved route id: " + payload,
  );
  assert.equal(payload.split(":").length, 2, "no second payload key may appear: " + payload);
  assert.ok(!/(url|host|signature|target|mirror)\s*:/i.test(payload), payload);
});

test("a route id the shell does not know is its own failure kind", () => {
  // A stale saved id (a mirror removed from a newer build) must surface the
  // shell's own words, not be relabelled as a network or install problem.
  const error = toDesktopUpgradeError({
    kind: "source",
    message: "update source is not configured in this build: mirror:old.example",
    attemptedHosts: [],
  });
  assert.equal(error.kind, "source");
  assert.match(error.message, /mirror:old\.example/);
});

test("only well-formed route entries are offered to the picker", () => {
  const routes = toDesktopUpdateSources([
    { id: "auto", kind: "auto" },
    { id: "direct", kind: "direct" },
    { id: "mirror:gh-proxy.com", kind: "mirror", host: "gh-proxy.com" },
    { id: "junk", kind: "mirror", host: 42 },
    { id: "", kind: "auto" },
    "auto",
    null,
  ]);
  assert.deepEqual(
    routes.map((route) => route.id),
    ["auto", "direct", "mirror:gh-proxy.com"],
  );
  assert.equal(routes[2].host, "gh-proxy.com");
  assert.equal("host" in routes[0], false);
  assert.deepEqual(toDesktopUpdateSources("nope"), []);
  assert.deepEqual(toDesktopUpdateSources(null), []);
});

test("a saved route survives only while the build still lists it", () => {
  const sources = [
    { id: "auto", kind: "auto" },
    { id: "direct", kind: "direct" },
    { id: "mirror:gh-proxy.com", kind: "mirror", host: "gh-proxy.com" },
  ];
  assert.equal(resolveDesktopUpdateSourceId("mirror:gh-proxy.com", sources), "mirror:gh-proxy.com");
  assert.equal(resolveDesktopUpdateSourceId("direct", sources), "direct");
  // A mirror removed from a newer build — the automatic route is used instead.
  assert.equal(resolveDesktopUpdateSourceId("mirror:gone.example", sources), DEFAULT_UPDATE_SOURCE_ID);
  assert.equal(resolveDesktopUpdateSourceId(null, sources), DEFAULT_UPDATE_SOURCE_ID);
  assert.equal(resolveDesktopUpdateSourceId("https://evil.example", sources), DEFAULT_UPDATE_SOURCE_ID);
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

test("the route list comes from the shell's own command, empty off-desktop", () => {
  // Only the shell knows which routes it compiled in; the page never invents a
  // mirror host, and a browser has nothing to route so the picker stays hidden.
  assert.match(source, /invoke<unknown>\("list_update_sources"\)/);
  const body = source.slice(source.indexOf("export async function listDesktopUpdateSources"));
  const guard = body.indexOf("if (!isTauriDesktop()) return");
  const invokeAt = body.indexOf("list_update_sources");
  assert.ok(guard > -1 && guard < invokeAt, "the guard must precede the invoke");
});
