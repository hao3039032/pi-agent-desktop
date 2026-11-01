#!/usr/bin/env node
// Fixed management-only entry. All paths are supplied by the trusted Rust
// launcher, never by management requests or the WebView.
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serveManagementStdio } from "./management-stdio.mjs";

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

try {
  const root = realpathSync(process.env.PI_WEB_MANAGEMENT_SDK_ROOT);
  const projection = realpathSync(process.env.PI_WEB_MANAGED_MODULES);
  const expected = process.env.PI_WEB_MANAGEMENT_CLI_VERSION;
  if (basename(root) !== "node_modules" || expected !== "1.4.0" || !process.env.PI_WEB_MGMT_NONCE || process.env.PI_PACKAGE_DIR) throw new Error("invalid management configuration");
  const packageDirs = new Map();
  const packageVersions = new Map();
  function validatePackage(name, version) {
    if (packageVersions.has(name) && packageVersions.get(name) !== version) throw new Error("conflicting SDK dependencies");
    const dir = realpathSync(join(root, name));
    if (!inside(root, dir)) throw new Error("package outside management root");
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (manifest.name !== name || manifest.version !== version) throw new Error("management package version mismatch");
    packageDirs.set(name, dir);
    packageVersions.set(name, version);
    return manifest;
  }
  const queue = [validatePackage("@earendil-works/pi-coding-agent", expected)];
  while (queue.length) {
    const manifest = queue.shift();
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!name.startsWith("@earendil-works/")) continue;
      const seen = packageDirs.has(name);
      const dependency = validatePackage(name, version);
      if (!seen) queue.push(dependency);
    }
  }
  const projectionFile = realpathSync(join(projection, "pi-web-session-projection.mjs"));
  if (!inside(projection, projectionFile)) throw new Error("projection outside managed root");
  const parentURL = pathToFileURL(join(dirname(root), "__pi_web_management__.mjs")).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    let packageDir;
    if (specifier.startsWith("@earendil-works/")) {
      const name = specifier.split("/").slice(0, 2).join("/");
      packageDir = packageDirs.get(name);
      if (!packageDir) throw new Error("unexpected management SDK package");
      context = { ...context, parentURL };
    }
    const result = nextResolve(specifier, context);
    if (result.url.startsWith("file:")) {
      const resolved = realpathSync(fileURLToPath(result.url));
      if (packageDir && !inside(packageDir, resolved)) throw new Error("management SDK import outside package");
      if (context.parentURL?.startsWith("file:") && inside(root, fileURLToPath(context.parentURL)) && !inside(root, resolved)) throw new Error("management dependency outside root");
    }
    return result;
  } });
  const { default: register } = await import("./pi-web-management.mjs");
  serveManagementStdio(register);
} catch {
  // Never echo configured paths, input, credentials or tokens.
  console.error("management SDK initialization failed");
  process.exitCode = 1;
}
