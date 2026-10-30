import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  distroResources,
  distroVersion,
  isMirrorHost,
  updateMirrorEndpoints,
  updateMirrorEnv,
  updateMirrorList,
} from "./distro-build-config.mjs";
import { compareVersions } from "./release-components.mjs";
import { seedRelativePath } from "./distro-seed.mjs";

test("distro versions sort between upstream releases", () => {
  assert.equal(distroVersion("0.4.8", 1), "0.4.801");
  assert.equal(distroVersion("0.4.8", 0), "0.4.800");
  assert.equal(distroVersion("0.4.10", 3), "0.4.1003");
  // after upstream 0.4.8 + any revision, before upstream 0.4.9
  assert.ok(Number(distroVersion("0.4.8", 99).split(".")[2]) < Number(distroVersion("0.4.9", 0).split(".")[2]));
  assert.throws(() => distroVersion("0.4.8", 100));
  assert.throws(() => distroVersion("0.4.8-beta.1", 1));
});

test("a .0 base encodes its revision as a prerelease suffix", () => {
  // X.Y.(0*100+R) would collide with upstream's own patch space.
  assert.equal(distroVersion("0.5.0", 1), "0.5.0-rev.1");
  assert.equal(distroVersion("0.5.0", 12), "0.5.0-rev.12");
  assert.equal(distroVersion("0.5.0", 0), "0.5.0-rev.0");
  // The suffix must keep the distro stream monotonic for the updater:
  // entering a .0 base from an older stable,
  assert.ok(compareVersions(distroVersion("0.6.0", 1), "0.5.209") > 0);
  // rebuilds on the same base (numeric identifiers: rev.10 > rev.9),
  assert.ok(compareVersions(distroVersion("0.6.0", 10), distroVersion("0.6.0", 9)) > 0);
  // and leaving it for the next upstream patch's first distro release.
  assert.ok(compareVersions(distroVersion("0.6.1", 1), distroVersion("0.6.0", 99)) > 0);
  // It also never equals an upstream tag.
  assert.ok(compareVersions(distroVersion("0.5.0", 0), "0.5.0") !== 0);
});

test("distro resources extend the upstream list per platform", () => {
  assert.deepEqual(distroResources("windows", ["resources/server", "resources/node"]),
    ["resources/server", "resources/node", "resources/pi-seed", "resources/pi", "resources/git"]);
  assert.deepEqual(distroResources("macos", ["resources/server"]),
    ["resources/server", "resources/pi-seed", "resources/pi", "resources/node"]);
  assert.deepEqual(distroResources("linux", ["resources/server", "resources/node"]),
    ["resources/server", "resources/node", "resources/pi-seed", "resources/pi"]);
});

test("seed paths match where pi installs each source", () => {
  assert.equal(seedRelativePath("npm:pi-subagents"), "npm/node_modules/pi-subagents");
  assert.equal(seedRelativePath("npm:@scope/pkg@^1"), "npm/node_modules/@scope/pkg");
  assert.equal(seedRelativePath("git:github.com/o/repo@v1"), "git/github.com/o/repo");
  assert.throws(() => seedRelativePath("./local"));
});

test("distro.json updateMirrors is the one list, validated at build time", () => {
  assert.deepEqual(updateMirrorList(["gh-proxy.com", "https://ghproxy.cn/"]), ["gh-proxy.com", "ghproxy.cn"]);
  assert.deepEqual(updateMirrorList(undefined), []);
  assert.deepEqual(updateMirrorList([]), []);
  // The value the native installer compiles in must match the manifest
  // endpoints, so both legs of an update name the same hosts.
  assert.equal(updateMirrorEnv(["gh-proxy.com", "ghproxy.cn"]), "gh-proxy.com,ghproxy.cn");
  assert.throws(() => updateMirrorList(["https://evil.example/path"]), /not a host/);
  assert.throws(() => updateMirrorList(["localhost"]), /not a host/);
  assert.throws(() => updateMirrorList([42]), /strings/);
  assert.throws(() => updateMirrorList("gh-proxy.com"), /must be an array/);
});

test("updater mirror endpoints are the prefixed latest.json URLs", () => {
  assert.deepEqual(updateMirrorEndpoints(["gh-proxy.com", "ghproxy.cn/"], "hao3039032/pi-agent-desktop"), [
    "https://gh-proxy.com/https://github.com/hao3039032/pi-agent-desktop/releases/latest/download/latest.json",
    "https://ghproxy.cn/https://github.com/hao3039032/pi-agent-desktop/releases/latest/download/latest.json",
  ]);
  // No mirrors configured → direct-only, unchanged release feed.
  assert.deepEqual(updateMirrorEndpoints(undefined, "hao3039032/pi-agent-desktop"), []);
  assert.deepEqual(updateMirrorEndpoints([], "hao3039032/pi-agent-desktop"), []);
  // A non-host entry fails the build loudly instead of shipping a broken endpoint.
  assert.throws(() => updateMirrorEndpoints(["https://evil.example/path"], "r"), /not a host/);
  assert.throws(() => updateMirrorEndpoints([42], "r"), /strings/);
});

test("the same distro.json list reaches both the manifest and the shell", async () => {
  // The build step hands the shell its mirrors through $GITHUB_ENV, and the
  // shell reads exactly that variable name at compile time. Asserting both
  // sides here keeps the two legs of an update from drifting apart.
  const buildConfig = await readFile(new URL("./distro-build-config.mjs", import.meta.url), "utf8");
  const installer = await readFile(
    new URL("../src-tauri/src/update_install.rs", import.meta.url),
    "utf8",
  );
  assert.match(buildConfig, /appendFileSync\(process\.env\.GITHUB_ENV, `PI_AGENT_DESKTOP_UPDATE_MIRRORS=/);
  assert.match(installer, /option_env!\("PI_AGENT_DESKTOP_UPDATE_MIRRORS"\)/);
  // Both read the field from the distribution config, not a second list.
  assert.match(buildConfig, /updateMirrorEnv\(distro\.updateMirrors\)/);
  assert.match(buildConfig, /updateMirrorEndpoints\(distro\.updateMirrors, branding\.repository\)/);
  // The packaged server gets the file itself, so it resolves the same list.
  const prepare = await readFile(new URL("./prepare-desktop.mjs", import.meta.url), "utf8");
  assert.match(prepare, /copyFile\(join\(rootDir, "distro", "distro\.json"\), join\(serverResourcesDir, "distro\.json"\)\)/);
});

// The release build, the server and the shell each validate `updateMirrors`
// with their own copy of the rules. These cases are duplicated verbatim in
// lib/update-mirrors.test.mjs and src-tauri/src/update_install.rs so a value
// one side accepts cannot be silently dropped by another.
const ACCEPTED_MIRRORS = ["gh-proxy.com", "ghproxy.cn", "mirror.example.org:8443", "a-b.c-d.example"];
const REJECTED_MIRRORS = [
  "", "localhost", "gh-proxy.com/", "https://gh-proxy.com", "gh-proxy.com/https://github.com",
  "user:pass@gh-proxy.com", "-bad.example.com", "bad-.example.com", "bad..example.com",
  "gh-proxy.com:abc", "gh-proxy.com:123456", "gh-proxy.com:0", "gh-proxy.com:65536",
  "with space.example.com",
];

test("mirror hosts use the same accept/reject rules as the server and the shell", () => {
  for (const host of ACCEPTED_MIRRORS) assert.equal(isMirrorHost(host), true, host);
  for (const host of REJECTED_MIRRORS) assert.equal(isMirrorHost(host), false, host);
});

test("a mirror list is normalized, but duplicates and overflow fail the build", () => {
  assert.deepEqual(updateMirrorList(["https://GH-Proxy.com/", " ghproxy.cn "]), ["gh-proxy.com", "ghproxy.cn"]);
  assert.deepEqual(updateMirrorList(undefined), []);
  assert.throws(() => updateMirrorList(["a.com", "a.com"]), /repeats a mirror/);
  assert.throws(() => updateMirrorList(["a.com", "b.com", "c.com", "d.com"]), /at most 3/);
  assert.throws(() => updateMirrorList(["gh-proxy.com:0"]), /not a host/);
});

test("the shell pins the repository this build releases from", async () => {
  const { readFile } = await import("node:fs/promises");
  const distro = JSON.parse(await readFile(new URL("../distro/distro.json", import.meta.url), "utf8"));
  const installer = await readFile(new URL("../src-tauri/src/update_install.rs", import.meta.url), "utf8");
  const pinned = /const REPOSITORY: &str = "([^"]+)";/.exec(installer);
  assert.equal(pinned?.[1], distro.app.repository);
  const branding = await readFile(new URL("../lib/branding.ts", import.meta.url), "utf8");
  assert.match(branding, new RegExp(`APP_REPOSITORY = "${distro.app.repository}"`));
});
