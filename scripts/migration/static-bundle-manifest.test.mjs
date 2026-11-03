import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundleFiles, managementRuntimeDescription, verifyBundle } from "./static-bundle-manifest.mjs";

test("manifest checks all files, mutations, additions and links", () => {
  const root = mkdtempSync(join(tmpdir(), "static-bundle-manifest-"));
  const put = (name, content) => { const p = join(root, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); };
  try {
    put("pi/pi", "binary");
    put("pi/pi-distribution.json", JSON.stringify({ complete: true, binary: "pi", files: ["pi"] }));
    put("node/node", "node");
    put("managed/pi-web-session-projection.mjs", "projection");
    put("managed/pi-web-session-title.mjs", "title");
    put("server/lib/pi-rpc/assets/pi-web-management.mjs", "extension");
    put("frontend/index.html", "page");
    const manifest = { version: 1, files: bundleFiles(root) };
    verifyBundle(root, manifest);
    rmSync(join(root, "managed/pi-web-session-title.mjs"));
    assert.throws(() => verifyBundle(root, manifest), /differ/);
    put("managed/pi-web-session-title.mjs", "title");
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

function sdkFixture(windows = false) {
  const root = mkdtempSync(join(tmpdir(), "management-bundle-"));
  const put = (name, content) => { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content)); };
  const pkg = (name, dependencies = {}) => put(`managed/node_modules/@earendil-works/${name}/package.json`, { name: `@earendil-works/${name}`, version: "1.4.0", dependencies });
  const binary = windows ? "pi.exe" : "pi";
  const node = windows ? "node/node.exe" : "node/node";
  put(`pi/${binary}`, "binary");
  put("pi/pi-distribution.json", { complete: true, binary, files: [binary] });
  put(node, "node");
  put("managed/pi-web-session-projection.mjs", "projection");
  put("managed/pi-web-session-title.mjs", "title");
  put("server/lib/pi-rpc/assets/pi-web-management.mjs", "extension");
  put("server/lib/pi-rpc/assets/management-sdk-entry.mjs", "entry");
  put("server/lib/pi-rpc/assets/management-stdio.mjs", "stdio");
  put("frontend/index.html", "page");
  pkg("pi-coding-agent", { "@earendil-works/pi-ai": "1.4.0", "@earendil-works/pi-mcp": "1.4.0" });
  pkg("pi-ai");
  pkg("pi-mcp");
  const manifest = { version: 1, piVersion: "1.4.0", managementRuntime: managementRuntimeDescription(binary, node), files: bundleFiles(root) };
  return { root, put, manifest, refresh: () => { manifest.files = bundleFiles(root); }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("management SDK bundle binds roles, graph and distribution to hashed files", () => {
  const f = sdkFixture();
  try {
    verifyBundle(f.root, f.manifest, { requireManagementSdk: true });
    const legacy = { ...f.manifest }; delete legacy.managementRuntime;
    verifyBundle(f.root, legacy);
    assert.throws(() => verifyBundle(f.root, legacy, { requireManagementSdk: true }), /metadata required/);
    for (const [key, value] of [["entry", "../entry"], ["dependencyRoot", "/tmp/node_modules"], ["projectionRoot", "managed/.."], ["cli", "pi/other"], ["version", 2], ["piVersion", "1.3.0"]]) {
      const bad = structuredClone(f.manifest); bad.managementRuntime[key] = value;
      assert.throws(() => verifyBundle(f.root, bad), /invalid management runtime/);
    }
    const badVersion = structuredClone(f.manifest); badVersion.piVersion = "1.3.0";
    assert.throws(() => verifyBundle(f.root, badVersion), /version mismatch/);
    const duplicate = structuredClone(f.manifest); duplicate.files.push(duplicate.files[0]);
    assert.throws(() => verifyBundle(f.root, duplicate), /differ/);
    f.put("server/lib/pi-rpc/assets/management-sdk-entry.mjs", "tampered");
    assert.throws(() => verifyBundle(f.root, f.manifest), /differ/);
    rmSync(join(f.root, "server/lib/pi-rpc/assets/management-sdk-entry.mjs")); f.refresh();
    assert.throws(() => verifyBundle(f.root, f.manifest), /management runtime missing/);
  } finally { f.cleanup(); }
});

test("SDK dependency versions follow each declaring manifest, not the CLI pin", () => {
  const f = sdkFixture();
  try {
    f.put("managed/node_modules/@earendil-works/pi-coding-agent/package.json", { name: "@earendil-works/pi-coding-agent", version: "1.4.0", dependencies: { "@earendil-works/pi-ai": "2.1.0", "@earendil-works/pi-mcp": "1.3.0" } });
    f.put("managed/node_modules/@earendil-works/pi-ai/package.json", { name: "@earendil-works/pi-ai", version: "2.1.0", dependencies: { "@earendil-works/pi-mcp": "1.3.0" } });
    f.put("managed/node_modules/@earendil-works/pi-mcp/package.json", { name: "@earendil-works/pi-mcp", version: "1.3.0" });
    f.refresh(); verifyBundle(f.root, f.manifest, { requireManagementSdk: true });
    f.put("managed/node_modules/@earendil-works/pi-ai/package.json", { name: "@earendil-works/pi-ai", version: "2.1.0", dependencies: { "@earendil-works/pi-mcp": "1.2.0" } });
    f.refresh(); assert.throws(() => verifyBundle(f.root, f.manifest), /conflicting management SDK dependency|package mismatch/);
  } finally { f.cleanup(); }
});

test("Windows resources use exact role spelling and reject Windows path aliases", () => {
  const f = sdkFixture(true);
  try {
    verifyBundle(f.root, f.manifest, { requireManagementSdk: true });
    if (process.platform !== "win32") {
      f.put("frontend/INDEX.html", "collision"); f.refresh();
      // A case-insensitive volume (the default APFS/HFS+ layout on macOS) folds
      // the two names into one file, so the collision cannot be expressed
      // there. The check stays covered on case-sensitive filesystems instead of
      // being skipped by platform name.
      if (f.manifest.files.some((file) => file.path === "frontend/INDEX.html")) {
        assert.throws(() => verifyBundle(f.root, f.manifest), /case-colliding/);
        rmSync(join(f.root, "frontend/INDEX.html")); f.refresh();
      }
    }
    for (const [key, value] of [["node", "node/Node.exe"], ["node", "node\\\\node.exe"], ["entry", "C:/resources/entry.mjs"], ["entry", "\\\\\\\\server\\\\share\\\\entry.mjs"], ["dependencyRoot", "managed\\\\node_modules"], ["cli", "pi/PI.exe"]]) {
      const bad = structuredClone(f.manifest); bad.managementRuntime[key] = value;
      assert.throws(() => verifyBundle(f.root, bad));
    }
    for (const file of ["C:/evil", "C:evil", "\\\\\\\\server\\\\share", "theme\\\\theme.json", "../outside"]) {
      f.put("pi/pi-distribution.json", { complete: true, binary: "pi.exe", files: ["pi.exe", file] }); f.refresh();
      assert.throws(() => verifyBundle(f.root, f.manifest));
    }
  } finally { f.cleanup(); }
});

test("verification CLI requires SDK metadata under an NSIS-shaped resources directory", () => {
  const f = sdkFixture(true);
  const install = mkdtempSync(join(tmpdir(), "nsis-install-"));
  try {
    const resources = join(install, "Program Files", "Pi Agent", "resources");
    mkdirSync(dirname(resources), { recursive: true });
    renameSync(f.root, resources);
    const manifestPath = join(resources, "bundle-manifest.json");
    const cli = fileURLToPath(new URL("./verify-static-bundle.mjs", import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [cli, resources, ...args], { encoding: "utf8" });
    writeFileSync(manifestPath, JSON.stringify(f.manifest));
    assert.equal(run("--management-sdk").status, 0);
    const legacy = { ...f.manifest }; delete legacy.managementRuntime;
    writeFileSync(manifestPath, JSON.stringify(legacy));
    assert.equal(run().status, 0);
    assert.notEqual(run("--management-sdk").status, 0);
    assert.notEqual(run("--unknown").status, 0);
  } finally { f.cleanup(); rmSync(install, { recursive: true, force: true }); }
});

test("management SDK rejects malformed distribution and dependency manifests even when rehashed", () => {
  const f = sdkFixture();
  try {
    for (const files of [["pi", "pi"], ["pi", "../escape"], ["pi", "/absolute"], ["pi", "C:/escape"]]) {
      f.put("pi/pi-distribution.json", { complete: true, binary: "pi", files }); f.refresh();
      assert.throws(() => verifyBundle(f.root, f.manifest));
    }
    f.put("pi/pi-distribution.json", { complete: false, binary: "pi", files: ["pi"] }); f.refresh();
    assert.throws(() => verifyBundle(f.root, f.manifest), /incomplete/);
    f.put("pi/pi-distribution.json", { complete: true, binary: "pi", files: ["pi"] });
    f.put("pi/extra", "extra"); f.refresh();
    assert.throws(() => verifyBundle(f.root, f.manifest), /distribution files differ/);
    rmSync(join(f.root, "pi/extra"));
    f.put("managed/node_modules/@earendil-works/pi-ai/package.json", { name: "@earendil-works/pi-ai", version: "1.3.0" }); f.refresh();
    assert.throws(() => verifyBundle(f.root, f.manifest), /package mismatch/);
    f.put("managed/node_modules/@earendil-works/pi-ai/package.json", { name: "wrong", version: "1.4.0" }); f.refresh();
    assert.throws(() => verifyBundle(f.root, f.manifest), /package mismatch/);
    rmSync(join(f.root, "managed/node_modules/@earendil-works/pi-ai/package.json")); f.refresh();
    assert.throws(() => verifyBundle(f.root, f.manifest), /runtime missing/);
    f.put("managed/node_modules/@earendil-works/pi-ai/package.json", { name: "@earendil-works/pi-ai", version: "1.4.0", dependencies: { "@earendil-works/pi-mcp": "1.3.0" } }); f.refresh();
    assert.throws(() => verifyBundle(f.root, f.manifest), /conflicting management SDK dependency|package mismatch/);
    if (process.platform !== "win32") {
      rmSync(join(f.root, "managed/node_modules/@earendil-works/pi-ai/package.json"));
      symlinkSync("/outside", join(f.root, "managed/node_modules/@earendil-works/pi-ai/package.json"));
      assert.throws(() => verifyBundle(f.root, f.manifest), /symlink/);
    }
  } finally { f.cleanup(); }
});
