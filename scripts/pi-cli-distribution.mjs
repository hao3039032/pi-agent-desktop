/**
 * Stage the pi CLI's whole distribution directory beside the server, not just
 * the executable (docs/distro.md).
 *
 * The upstream archives ship more than the binary: darwin/linux tarballs carry
 * `photon_rs_bg.wasm` (the image runtime) and the TUI theme files next to
 * `pi/pi`, and the Windows zips are a flat `pi.exe` + `theme/`. Copying only
 * the executable silently dropped those files, so this module copies the
 * archive's tree verbatim and records exactly what it copied in a manifest.
 * `verify-packaged-frontend.mjs` then checks every listed file is still in the
 * packaged resources — a pruned or partially copied tree fails the release.
 *
 * It never walks the host: the source is the directory the release download
 * step extracted (`PI_CLI_DISTRIBUTION_DIR`), never a PATH lookup or a
 * developer checkout.
 */

import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const PI_DISTRIBUTION_MANIFEST = "pi-distribution.json";

/** The executable name `resolvePiExecutable()` probes for on this platform. */
export function piExecutableName(platform = process.platform) {
  return platform === "win32" ? "pi.exe" : "pi";
}

function walk(sourceDir, current, files) {
  for (const name of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, name.name);
    const stats = lstatSync(path);
    // A symlink from a downloaded archive is never followed: it could point
    // anywhere, and the packaged app must not inherit that.
    if (stats.isSymbolicLink()) throw new Error(`pi distribution contains a symlink: ${relative(sourceDir, path)}`);
    if (stats.isDirectory()) walk(sourceDir, path, files);
    else if (stats.isFile()) files.push(relative(sourceDir, path).split(sep).join("/"));
    else throw new Error(`pi distribution contains an unsupported file type: ${relative(sourceDir, path)}`);
  }
}

/**
 * Copy a pi distribution tree into `destDir` and write its manifest.
 * Returns the manifest (`{ binary, files }`), with paths relative to `destDir`.
 */
export function stagePiDistribution({ sourceDir, destDir, binaryName = piExecutableName(), platform = process.platform }) {
  const binary = binaryName;
  const sourceBinary = join(sourceDir, binary);
  const sourceStats = (() => {
    try {
      return lstatSync(sourceBinary);
    } catch {
      throw new Error(`pi distribution has no ${binary}: ${sourceDir} (expected the archive's own layout)`);
    }
  })();
  if (!sourceStats.isFile()) throw new Error(`pi distribution's ${binary} is not a regular file`);

  const files = [];
  walk(sourceDir, sourceDir, files);
  files.sort();

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  for (const relativePath of files) {
    const target = join(destDir, ...relativePath.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(join(sourceDir, ...relativePath.split("/")), target);
  }
  // The engine spawns this path directly on Unix.
  if (platform !== "win32") chmodSync(join(destDir, binary), 0o755);

  const manifest = { binary, files, complete: true };
  writeFileSync(join(destDir, PI_DISTRIBUTION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** A single-executable staging (PI_CLI_SOURCE without a distribution dir). */
export function stagePiExecutableOnly({ sourcePath, destDir, platform = process.platform }) {
  const binary = sourcePath.split(/[\\/]/).at(-1);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  copyFileSync(sourcePath, join(destDir, binary));
  if (platform !== "win32") chmodSync(join(destDir, binary), 0o755);
  const manifest = { binary, files: [binary], complete: false };
  writeFileSync(join(destDir, PI_DISTRIBUTION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Read a staged manifest; undefined when the resources were never staged. */
export function readPiDistributionManifest(destDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(destDir, PI_DISTRIBUTION_MANIFEST), "utf8"));
    if (typeof parsed?.binary !== "string" || !Array.isArray(parsed.files)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
