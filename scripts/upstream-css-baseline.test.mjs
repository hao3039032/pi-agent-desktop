import assert from "node:assert/strict";
import test from "node:test";

import {
  UPSTREAM_CSS_FILES,
  hashCss,
  hashWorkingCss,
  readUpstreamCssBaseline,
} from "./upstream-css-baseline.mjs";

const baseline = await readUpstreamCssBaseline();

test("the baseline records every upstream stylesheet and nothing else", () => {
  assert.ok(baseline.upstreamRef, "upstreamRef must name the pi-web commit the hashes came from");
  assert.deepEqual(Object.keys(baseline.files).sort(), [...UPSTREAM_CSS_FILES].sort());
});

for (const path of UPSTREAM_CSS_FILES) {
  test(`${path} stays byte-identical to pi-web ${baseline.upstreamRef}`, async () => {
    assert.equal(
      await hashWorkingCss(path),
      baseline.files[path],
      `${path} differs from upstream pi-web ${baseline.upstreamRef}. Fork styling belongs in ` +
        "app/native-theme.css (see docs/native-theme.md): move the rule there and restore " +
        `the file with \`git checkout ${baseline.upstreamRef} -- ${path}\` (fetch the \`upstream\` ` +
        "remote first: it is abcwyc/pi-agent-desktop, and `upstreamRef` records which of its refs " +
        "these hashes came from). " +
        "If you just merged upstream, run `node scripts/upstream-css-baseline.mjs update <upstream-ref>`.",
    );
  });
}

test("hashing ignores CRLF checkouts", () => {
  assert.equal(hashCss("a {\r\n  color: red;\r\n}\r\n"), hashCss("a {\n  color: red;\n}\n"));
});
