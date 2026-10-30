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
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
  const extra = ["resources/pi-seed", "resources/pi"];
  // macOS bundles node inside "Pi Agent Server.app"; the distro adds the npm
  // CLI next to it under resources/node (see prepare-desktop.mjs).
  if (platform === "macos") extra.push("resources/node");
  if (platform === "windows") extra.push("resources/git");
  return [...new Set([...upstreamResources, ...extra])];
}

/**
 * The validated mirror origins from `distro.json`, in try order.
 *
 * `updateMirrors` is the ONLY place a mirror is configured. It is baked into
 * the desktop shell at build time (as `PI_AGENT_DESKTOP_UPDATE_MIRRORS`, see
 * `updateMirrorEnv`) and read at runtime by this repository's server, so the
 * manifest fetch and the installer download can never disagree about which
 * mirrors exist. Invalid entries fail the build instead of shipping an
 * endpoint nobody can use.
 */
/** The retry budget the server and the shell both enforce. */
export const MAX_UPDATE_MIRRORS = 3;

/**
 * `host` or `host:port`, nothing else. These are the same rules as
 * `lib/update-mirrors.ts` (`isMirrorHost`) and
 * `src-tauri/src/update_install.rs` (`is_valid_mirror_host`); the three
 * accept/reject lists are kept identical by tests, because a value this build
 * accepts must not be silently dropped by either runtime.
 */
export function isMirrorHost(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const separator = value.lastIndexOf(":");
  const name = separator === -1 ? value : value.slice(0, separator);
  const port = separator === -1 ? undefined : value.slice(separator + 1);
  if (!name || name.length > 253) return false;
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port)) return false;
    const number = Number(port);
    if (number < 1 || number > 65535) return false;
  }
  const labels = name.split(".");
  // A single label would resolve through a search domain.
  if (labels.length < 2) return false;
  return labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9-]+$/i.test(label)
    && !label.startsWith("-")
    && !label.endsWith("-")
  ));
}

/**
 * The validated mirror origins from `distro.json`, in try order.
 *
 * Rejections are loud: a mirror that the shell would drop must fail the build
 * instead of shipping an endpoint nobody uses.
 */
export function updateMirrorList(mirrors) {
  if (mirrors === undefined) return [];
  if (!Array.isArray(mirrors)) {
    throw new Error(`distro.json updateMirrors must be an array, got ${JSON.stringify(mirrors)}`);
  }
  const hosts = mirrors.map((mirror) => {
    if (typeof mirror !== "string") throw new Error(`distro.json updateMirrors entries must be strings, got ${JSON.stringify(mirror)}`);
    const host = mirror.trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    if (!isMirrorHost(host)) {
      throw new Error(`distro.json updateMirrors entry is not a host: ${JSON.stringify(mirror)}`);
    }
    return host;
  });
  if (new Set(hosts).size !== hosts.length) {
    throw new Error(`distro.json updateMirrors repeats a mirror: ${JSON.stringify(hosts)}`);
  }
  if (hosts.length > MAX_UPDATE_MIRRORS) {
    throw new Error(`distro.json updateMirrors lists ${hosts.length} mirrors; at most ${MAX_UPDATE_MIRRORS} are used`);
  }
  return hosts;
}

/**
 * Accelerator endpoints for the updater manifest, each the mirror-prefixed
 * form of the direct github.com latest.json URL. Mirrors must proxy release
 * downloads, not just raw files.
 */
export function updateMirrorEndpoints(mirrors, repository) {
  return updateMirrorList(mirrors).map(
    (host) => `https://${host}/https://github.com/${repository}/releases/latest/download/latest.json`,
  );
}

/** The `PI_AGENT_DESKTOP_UPDATE_MIRRORS` value the native installer compiles in. */
export function updateMirrorEnv(mirrors) {
  return updateMirrorList(mirrors).join(",");
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

  // `src-tauri/src/update_install.rs` pins REPOSITORY: the installer will only
  // accept assets under it, so a renamed distribution must fail here instead of
  // shipping a shell that rejects its own releases.
  const installerSource = readFileSync(join(tauriDir, "src", "update_install.rs"), "utf8");
  const pinned = /const REPOSITORY: &str = "([^"]+)";/.exec(installerSource);
  if (!pinned || pinned[1] !== branding.repository) {
    throw new Error(
      `update_install.rs REPOSITORY (${pinned?.[1] ?? "missing"}) must match distro.json app.repository (${branding.repository})`,
    );
  }

  const overlay = {
    productName: branding.productName,
    identifier: branding.identifier,
    bundle: { resources: distroResources(platform, upstreamResources) },
    plugins: {
      updater: {
        // The direct github.com manifest comes first and public accelerator
        // mirrors follow for networks where github.com is unreachable. The
        // manifest is NOT signed, so `update_install.rs` also checks every
        // asset URL against this repository and the announced version before
        // requesting it, and verifies the downloaded bytes. `update_install.rs`
        // fetches these endpoints one at a time (the plugin's own loop stops
        // at the first candidate that answers with non-JSON). Set distro.json's
        // "updateMirrors" to [] to ship direct-only.
        endpoints: [
          `https://github.com/${branding.repository}/releases/latest/download/latest.json`,
          ...updateMirrorEndpoints(distro.updateMirrors, branding.repository),
        ],
      },
    },
  };
  writeFileSync(join(tauriDir, "tauri.distro.conf.json"), `${JSON.stringify(overlay, null, 2)}\n`);

  // The native installer reads the same list through `option_env!`, which means
  // it must reach the `tauri build` environment. Writing it to $GITHUB_ENV is
  // what carries it from this configuration step to the build step.
  const mirrors = updateMirrorEnv(distro.updateMirrors);
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `PI_AGENT_DESKTOP_UPDATE_MIRRORS=${mirrors}\n`);
  }
  if (mirrors) console.error(`installer mirrors: ${mirrors}`);
  console.log(version);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
