import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundleFiles, verifyBundle } from "./static-bundle-manifest.mjs";

test("manifest checks all files, mutations, additions and links", () => {
  const root = mkdtempSync(join(tmpdir(), "static-bundle-manifest-"));
  const put = (name, content) => { const p = join(root, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); };
  try {
    put("pi/pi", "binary");
    put("pi/pi-distribution.json", JSON.stringify({ complete: true, binary: "pi", files: ["pi"] }));
    put("node/node", "node");
    put("managed/pi-web-session-projection.mjs", "projection");
    put("server/lib/pi-rpc/assets/pi-web-management.mjs", "extension");
    put("frontend/index.html", "page");
    const manifest = { version: 1, files: bundleFiles(root) };
    verifyBundle(root, manifest);
    put("frontend/index.html", "changed");
    assert.throws(() => verifyBundle(root, manifest), /differ/);
    put("frontend/index.html", "page");
    put("extra", "extra");
    assert.throws(() => verifyBundle(root, manifest), /differ/);
    rmSync(join(root, "extra"));
    if (process.platform !== "win32") {
      symlinkSync("/outside", join(root, "link"));
      assert.throws(() => bundleFiles(root), /symlink/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
