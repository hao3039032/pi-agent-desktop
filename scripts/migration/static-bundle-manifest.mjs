import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// The manifest covers regular files only. Never follow a link back into the
// build machine: that would turn a successful staging into a false standalone.
export function bundleFiles(root) {
  if (lstatSync(root).isSymbolicLink()) throw new Error("bundle root is a symlink");
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`bundle contains symlink: ${relative(root, path)}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        const rel = relative(root, path).split(sep).join("/");
        if (rel !== "bundle-manifest.json") files.push({ path: rel, size: stat.size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
      } else throw new Error(`unsupported bundle entry: ${relative(root, path)}`);
    }
  }
  walk(root);
  return files;
}

// This describes roles, not a source-authentication assertion. The caller must
// select the bundle root and trust the manifest independently of the WebView.
export function managementRuntimeDescription(binary, node) {
  return {
    version: 1,
    piVersion: "1.4.0",
    node,
    entry: "server/lib/pi-rpc/assets/management-sdk-entry.mjs",
    dependencyRoot: "managed/node_modules",
    projectionRoot: "managed",
    cli: `pi/${binary}`,
  };
}

function verifyManagementRuntime(root, manifest, actual, pi) {
  const runtime = manifest.managementRuntime;
  if (!runtime || typeof runtime !== "object") throw new Error("management-sdk metadata required");
  if (!((pi.binary === "pi" && runtime.node === "node/node") || (pi.binary === "pi.exe" && runtime.node === "node/node.exe"))) throw new Error("invalid management runtime executable");
  const expected = managementRuntimeDescription(pi.binary, runtime.node);
  if (Object.keys(runtime).length !== Object.keys(expected).length || Object.keys(expected).some((key) => runtime[key] !== expected[key])) throw new Error("invalid management runtime metadata");
  if (manifest.piVersion !== expected.piVersion) throw new Error("management runtime version mismatch");
  const paths = new Set(actual.map((file) => file.path));
  if (pi.binary === "pi.exe") {
    const folded = new Set();
    for (const path of paths) {
      if (/[\\\\:]/.test(path) || path.split("/").some((part) => /[. ]$/.test(part))) throw new Error("invalid Windows bundle path");
      const key = path.toLowerCase();
      if (folded.has(key)) throw new Error("case-colliding Windows bundle paths");
      folded.add(key);
    }
  }
  for (const path of [runtime.node, runtime.entry, runtime.cli, "server/lib/pi-rpc/assets/management-stdio.mjs", "managed/pi-web-session-projection.mjs"]) {
    if (!paths.has(path)) throw new Error(`management runtime missing ${path}`);
  }
  if (!Array.isArray(pi.files) || pi.files.some((p) => typeof p !== "string" || !/^[^/\\\\]+(?:\/[^/\\\\]+)*$/.test(p) || p.split("/").some((part) => part === "." || part === "..") || /^[A-Za-z]:/.test(p)) || new Set(pi.files).size !== pi.files.length) throw new Error("invalid pi distribution files");
  const distributionFiles = actual.filter((file) => file.path.startsWith("pi/") && file.path !== "pi/pi-distribution.json").map((file) => file.path.slice(3));
  if (pi.files.includes("pi-distribution.json") || distributionFiles.length !== pi.files.length || pi.files.some((path) => !distributionFiles.includes(path))) throw new Error("pi distribution files differ");

  // Match the SDK entry's pinned @earendil-works graph, including the two
  // packages imported directly by the management projection.
  const seen = new Map();
  function checkPackage(name, version) {
    if (!/^@earendil-works\/pi-[a-z0-9-]+$/.test(name) || typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("invalid management SDK dependency");
    if (seen.has(name)) {
      if (seen.get(name) !== version) throw new Error("conflicting management SDK dependency");
      return;
    }
    seen.set(name, version);
    const path = `${runtime.dependencyRoot}/${name}/package.json`;
    if (!paths.has(path)) throw new Error(`management runtime missing ${path}`);
    const pkg = JSON.parse(readFileSync(join(root, ...path.split("/")), "utf8"));
    if (pkg.name !== name || pkg.version !== version || (pkg.dependencies !== undefined && (!pkg.dependencies || typeof pkg.dependencies !== "object" || Array.isArray(pkg.dependencies)))) throw new Error(`management SDK package mismatch: ${name}`);
    for (const [dependency, required] of Object.entries(pkg.dependencies ?? {})) {
      if (dependency.startsWith("@earendil-works/")) checkPackage(dependency, required);
    }
  }
  checkPackage("@earendil-works/pi-coding-agent", expected.piVersion);
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-mcp"]) {
    if (!seen.has(name)) throw new Error(`management SDK graph missing ${name}`);
  }
}

export function verifyBundle(root, manifest, { requireManagementSdk = false } = {}) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.files)) throw new Error("invalid bundle manifest");
  const actual = bundleFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error("bundle files differ from manifest");
  for (const path of ["pi/pi-distribution.json", "managed/pi-web-session-projection.mjs", "managed/pi-web-session-title.mjs", "server/lib/pi-rpc/assets/pi-web-management.mjs", "frontend/index.html"]) {
    if (!actual.some((file) => file.path === path)) throw new Error(`bundle missing ${path}`);
  }
  if (!actual.some((file) => file.path === "node/node" || file.path === "node/node.exe")) throw new Error("bundle missing node runtime");
  const pi = JSON.parse(readFileSync(join(root, "pi", "pi-distribution.json"), "utf8"));
  if (pi.complete !== true || !pi.files.includes(pi.binary) || !actual.some((file) => file.path === `pi/${pi.binary}`)) throw new Error("incomplete pi distribution");
  for (const file of pi.files) if (!actual.some((entry) => entry.path === `pi/${file}`)) throw new Error(`missing pi distribution file: ${file}`);
  if (requireManagementSdk || manifest.managementRuntime !== undefined) verifyManagementRuntime(root, manifest, actual, pi);
  return actual;
}
