import assert from "node:assert/strict";
import test from "node:test";
import { distroResources, distroVersion } from "./distro-build-config.mjs";
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
