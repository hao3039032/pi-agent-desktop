/**
 * Stage the vendored management tree (the desktop:prepare shape) into a
 * directory: croner + the pi SDK graph with its dependency closure + the
 * session-view projection bundle compiled from THIS repo's lib/ source.
 *
 * The tree root holds node_modules/ so dependency resolution from the
 * vendored packages finds their closure. Used by:
 * - desktop:prepare (the packaged <resources>/managed directory);
 * - the Rust host's real-pi tests (a temp tree + PI_WEB_MANAGED_MODULES);
 * - scripts/migration/management-extension.test.mjs (stageVendoredTree).
 *
 * Usage: node scripts/migration/stage-managed-tree.mjs --out <dir>
 */

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProjectionInto } from "./build-management-modules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

function vendorClosure(entryPackage) {
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const dir = join(ROOT, "node_modules", ...name.split("/"));
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) return;
    let deps = {};
    try {
      deps = JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {};
    } catch {}
    for (const dep of Object.keys(deps)) walk(dep);
  };
  walk(entryPackage);
  return [...seen];
}

/**
 * Stage the vendored tree into `managed` (a directory path; created).
 * Returns the path. Throws when a required package is missing from this
 * checkout's node_modules — a staged tree is never partial.
 */
export async function stageManagedTree(managed) {
  mkdirSync(managed, { recursive: true });
  const copyPackage = (name) => {
    const from = join(ROOT, "node_modules", ...name.split("/"));
    if (!existsSync(join(from, "package.json"))) {
      throw new Error(`stage-managed-tree: ${name} is missing from node_modules`);
    }
    cpSync(from, join(managed, ...name.split("/")), { recursive: true });
  };
  copyPackage("croner");
  copyPackage("mammoth");
  for (const pkg of vendorClosure("mammoth")) {
    const from = join(ROOT, "node_modules", ...pkg.split("/"));
    if (!existsSync(join(from, "package.json"))) continue;
    const target = join(managed, ...pkg.split("/"));
    if (!existsSync(join(target, "package.json"))) {
      cpSync(from, target, { recursive: true });
    }
  }
  // The pi SDK and both closure walks (its own imports and pi-ai's) — the
  // session-manager's module graph must resolve entirely inside this tree.
  for (const pkg of vendorClosure("@earendil-works/pi-ai")) {
    if (existsSync(join(ROOT, "node_modules", ...pkg.split("/"), "package.json"))) {
      cpSync(
        join(ROOT, "node_modules", ...pkg.split("/")),
        join(managed, ...pkg.split("/")),
        { recursive: true },
      );
    }
  }
  copyPackage("@earendil-works/pi-coding-agent");
  for (const pkg of vendorClosure("@earendil-works/pi-coding-agent")) {
    const from = join(ROOT, "node_modules", ...pkg.split("/"));
    if (!existsSync(join(from, "package.json"))) continue;
    const target = join(managed, ...pkg.split("/"));
    if (!existsSync(join(target, "package.json"))) {
      cpSync(from, target, { recursive: true });
    }
  }
  // The projection bundle: compiled from this checkout's lib/ source — the
  // same code the Next server runs (never a hand-maintained copy).
  await buildProjectionInto(managed);
  return managed;
}

// --- CLI ---------------------------------------------------------------------

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = outIndex >= 0 ? args[outIndex + 1] : null;
  if (!outDir) {
    console.error("usage: node scripts/migration/stage-managed-tree.mjs --out <dir>");
    process.exit(2);
  }
  const staged = await stageManagedTree(outDir);
  console.error(`[stage-managed-tree] staged ${staged}`);
}
