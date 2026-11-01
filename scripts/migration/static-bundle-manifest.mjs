import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// The manifest covers regular files only. Never follow a link back into the
// build machine: that would turn a successful staging into a false standalone.
export function bundleFiles(root) {
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

export function verifyBundle(root, manifest) {
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
  return actual;
}
