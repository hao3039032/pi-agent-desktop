import assert from "node:assert/strict";
import test from "node:test";
import { applyUpstreamWebUpdateSkip } from "./runtime-env.ts";

const FLAG = "PI_WEB_SKIP_VERSION_CHECK";

test("the packaged distro suppresses the upstream pi-web update prompt", () => {
  const saved = process.env[FLAG];
  try {
    // Unset → the distro runtime turns the npm version check off.
    delete process.env[FLAG];
    applyUpstreamWebUpdateSkip();
    assert.equal(process.env[FLAG], "1");

    // An operator's explicit choice wins: "0" keeps upstream's check on.
    process.env[FLAG] = "0";
    applyUpstreamWebUpdateSkip();
    assert.equal(process.env[FLAG], "0");

    // Idempotent once set.
    process.env[FLAG] = "1";
    applyUpstreamWebUpdateSkip();
    assert.equal(process.env[FLAG], "1");
  } finally {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  }
});
