#!/usr/bin/env node
/**
 * Fork: release-time configuration for the distribution build.
 *
 *   node scripts/distro-build-config.mjs <macos|windows|linux>
 *
 * 1. Version: the distro version is derived from the upstream version so it
 *    always sorts after the upstream release it is built on and before the
 *    next one: upstream X.Y.Z + distro revision R → X.Y.(Z*100+R). Written into
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
