import assert from "node:assert/strict";
import test from "node:test";
import { applyAutoReviewWorkspaceOptOut, applyUpstreamWebUpdateSkip } from "./runtime-env.ts";

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

const AUTO_REVIEW_FLAG = "PI_AUTO_REVIEW_ALLOW_UNTRUSTED_DEV";

test("the packaged distro opts the security reviewer out of workspace containment", () => {
  const saved = process.env[AUTO_REVIEW_FLAG];
  try {
    // Unset → the distro sets the opt-out: on Windows the pi-seed install
    // lives under the user profile, so home-directory and drive-root
    // workspaces would otherwise disable the reviewer entirely.
    delete process.env[AUTO_REVIEW_FLAG];
    applyAutoReviewWorkspaceOptOut();
    assert.equal(process.env[AUTO_REVIEW_FLAG], "1");

    // An operator's explicit choice wins: "0" keeps the strict check.
    process.env[AUTO_REVIEW_FLAG] = "0";
    applyAutoReviewWorkspaceOptOut();
    assert.equal(process.env[AUTO_REVIEW_FLAG], "0");

    // Idempotent once set.
    process.env[AUTO_REVIEW_FLAG] = "1";
    applyAutoReviewWorkspaceOptOut();
    assert.equal(process.env[AUTO_REVIEW_FLAG], "1");
  } finally {
    if (saved === undefined) delete process.env[AUTO_REVIEW_FLAG];
    else process.env[AUTO_REVIEW_FLAG] = saved;
  }
});
