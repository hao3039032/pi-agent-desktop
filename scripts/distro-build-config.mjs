#!/usr/bin/env node
/**
 * Fork: release-time configuration for the distribution build.
 *
 *   node scripts/distro-build-config.mjs <macos|windows|linux>
 *
 * 1. Version: the distro version is derived from the upstream version so it
 *    never collides with an upstream release tag and always decodes back to
 *    the base: upstream X.Y.Z + distro revision R → X.Y.(Z*100+R), or
 *    X.Y.0-rev.R for a .0 base (X.Y.(0*100+R) would collide with upstream's
 *    own patch space). R counts per upstream version —
 *    scripts/distro-reset-revision.mjs resets it to 1 whenever a sync changes
 *    the upstream version. Written into
 *    src-tauri/pi-agent-desktop-package.json (read by Tauri and lib/branding.ts)
 *    in the CI checkout only — the committed file stays upstream's, so merges
 *    never conflict on it.
 * 2. Tauri overlay: writes src-tauri/tauri.distro.conf.json, passed to
 *    `tauri build --config`. It renames/re-identifies the app, points the
 *    updater at this fork, and adds the distro resources on top of the
 *    platform's upstream resource list (merge-patch replaces arrays, so the
 *    upstream list is read and extended rather than copied by hand).
 *
 * Prints the version on stdout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tauriDir = join(rootDir, "src-tauri");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export function distroVersion(upstreamVersion, revision) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(upstreamVersion);
  if (!match) throw new Error(`Unexpected upstream version: ${upstreamVersion}`);
  if (!Number.isInteger(revision) || revision < 0 || revision > 99) {
    throw new Error(`distro revision must be an integer 0..99, got ${revision}`);
  }
  // A .0 base has no patch room: X.Y.(0*100+R) is X.Y.R itself, i.e.
  // upstream's own patch space, and any higher patch would collide with the
  // next base's X.Y.(1*100+R). A semver prerelease suffix keeps the base
  // readable, never collides with an upstream tag, and still sorts correctly:
  // 0.6.0-rev.1 > 0.5.209, 0.6.0-rev.10 > 0.6.0-rev.9, and the first distro
  // release on upstream 0.6.1 (0.6.101) tops any 0.6.0-rev.R.
  if (Number(match[3]) === 0) {
    return `${upstreamVersion}-rev.${revision}`;
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) * 100 + revision}`;
}

export function distroResources(platform, upstreamResources) {
  const extra = ["resources/pi-seed"];
  // macOS bundles node inside "Pi Agent Server.app"; the distro adds the npm
  // CLI next to it under resources/node (see prepare-desktop.mjs).
  if (platform === "macos") extra.push("resources/node");
  if (platform === "windows") extra.push("resources/git");
  return [...new Set([...upstreamResources, ...extra])];
}

function main() {
  const platform = process.argv[2];
  if (!["macos", "windows", "linux"].includes(platform)) {
    throw new Error("usage: distro-build-config.mjs <macos|windows|linux>");
  }
  const distro = readJson(join(rootDir, "distro", "distro.json"));
  const branding = distro.app;

  const packagePath = join(tauriDir, "pi-agent-desktop-package.json");
  const pkg = readJson(packagePath);
  const upstreamVersion = pkg.upstreamVersion ?? pkg.version;
  const version = distroVersion(upstreamVersion, distro.revision);
  writeFileSync(packagePath, `${JSON.stringify({ ...pkg, version, upstreamVersion }, null, 2)}\n`);

  // src-tauri/Cargo.toml carries the same version; release-components.mjs
  // requires the two to agree. The pattern must accept prerelease suffixes
  // (.0 bases produce X.Y.0-rev.R) and must never silently fail to match.
  const cargoPath = join(tauriDir, "Cargo.toml");
  const cargoVersionLine = /^(version\s*=\s*")[^"]+(")/m;
  const cargo = readFileSync(cargoPath, "utf8");
  if (!cargoVersionLine.test(cargo)) {
    throw new Error(`Could not find the version line in ${cargoPath}.`);
  }
  writeFileSync(cargoPath, cargo.replace(cargoVersionLine, `$1${version}$2`));

  const base = readJson(join(tauriDir, "tauri.conf.json"));
  const platformFile = { macos: null, windows: "tauri.windows.conf.json", linux: "tauri.linux.conf.json" }[platform];
  const upstreamResources = (platformFile ? readJson(join(tauriDir, platformFile)).bundle?.resources : null)
    ?? base.bundle.resources;

  const overlay = {
    productName: branding.productName,
    identifier: branding.identifier,
    bundle: { resources: distroResources(platform, upstreamResources) },
    plugins: {
      updater: {
        endpoints: [`https://github.com/${branding.repository}/releases/latest/download/latest.json`],
      },
    },
  };
  writeFileSync(join(tauriDir, "tauri.distro.conf.json"), `${JSON.stringify(overlay, null, 2)}\n`);
  console.log(version);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
