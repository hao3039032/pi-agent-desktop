import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  parseUpstreamBaselineRev,
  readForkOwnership,
} from "./fork-ownership.mjs";

const manifest = await readForkOwnership();

test("the manifest's upstreamBaseline parses into a usable git rev", () => {
  // The drift script hands its no-remote fallback baseline to `git diff`,
  // which rejects the human-readable label as an ambiguous argument. This
  // pins that the recorded label always yields a rev git can resolve.
  const rev = parseUpstreamBaselineRev(manifest.upstreamBaseline);
  assert.match(rev, /^[0-9a-f]{7,40}$/);
  assert.ok(manifest.upstreamBaseline.includes(rev));
});

test("the rev parser accepts only main@<7-40 hex>", () => {
  assert.equal(parseUpstreamBaselineRev("main@6fcd7d4 (v0.10.0)"), "6fcd7d4");
  assert.equal(
    parseUpstreamBaselineRev("main@0123456789abcdef0123456789abcdef01234567 (v0.11.0)"),
    "0123456789abcdef0123456789abcdef01234567",
  );
  // Too short, non-hex, or absent — none of these may reach `git diff`.
  for (const bad of ["main@6fcd74", "main@zzzzzzz", "v0.10.0", "", undefined]) {
    assert.throws(() => parseUpstreamBaselineRev(bad), /cannot parse a git rev/);
  }
});

test("the drift script routes the no-remote fallback through the parser", async () => {
  // Importing measure-fork-drift.mjs itself would run its git commands, so
  // the wiring is pinned on the source instead: the fallback must return the
  // parsed rev, never the raw manifest label.
  const source = await readFile(new URL("./measure-fork-drift.mjs", import.meta.url), "utf8");
  assert.match(source, /parseUpstreamBaselineRev\(baselineFromManifest\(\)\)/);
  assert.doesNotMatch(source, /return manifest;/);
});
