import assert from "node:assert/strict";
import test from "node:test";
import { distroResources, distroVersion } from "./distro-build-config.mjs";
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
    ["resources/server", "resources/node", "resources/pi-seed", "resources/git"]);
  assert.deepEqual(distroResources("macos", ["resources/server"]),
    ["resources/server", "resources/pi-seed", "resources/node"]);
  assert.deepEqual(distroResources("linux", ["resources/server", "resources/node"]),
    ["resources/server", "resources/node", "resources/pi-seed"]);
});

test("seed paths match where pi installs each source", () => {
  assert.equal(seedRelativePath("npm:pi-subagents"), "npm/node_modules/pi-subagents");
  assert.equal(seedRelativePath("npm:@scope/pkg@^1"), "npm/node_modules/@scope/pkg");
  assert.equal(seedRelativePath("git:github.com/o/repo@v1"), "git/github.com/o/repo");
  assert.throws(() => seedRelativePath("./local"));
});
