#!/usr/bin/env node
/**
 * Fork: rewrite the updater feed's api.github.com download URLs.
 *
 *   node scripts/rewrite-updater-json.mjs \
 *     --latest-json <file> --assets <file> --repository <owner>/<repo> --tag <tag>
 *
 * tauri-apps/tauri-action writes latest.json with every platforms.*.url
 * pointing at the release-asset *API* endpoint
 * (https://api.github.com/repos/<repo>/releases/assets/<id> — hardcoded in
 * its src/upload-version-json.ts, no input changes it). Checking for updates
 * only needs the JSON, but the download itself then goes through
 * api.github.com, which some networks block while github.com stays reachable:
 * the in-app check succeeds and the download fails. The release workflow
 * therefore rewrites those URLs to github.com download URLs before publishing
 * the draft release.
 *
 * The rewrite runs while the release is still a draft, and GitHub serves a
 * draft's assets from https://github.com/<repo>/releases/download/
 * untagged-<hash>/<file>: that path segment only becomes the tag once the
 * draft is published, at which point every untagged- URL 404s. Copying the
 * draft's browser_download_url verbatim therefore ships a broken feed (that
 * is exactly how v0.6.0-rev.1 broke) — the script rebuilds each URL with the
 * tag the release *will* be published under (the same `v$version` the
 * publish step uses), keeping the file-name segment untouched.
 *
 * The minisign signatures cover the artifacts, not latest.json, so moving the
 * pointer cannot forge an update. Safe to re-run: URLs that do not match the
 * API pattern (an already-rewritten feed) are left untouched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// tauri-action's asset-API form, with the owner/repo it belongs to.
const ASSET_API_URL = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/(\d+)$/;

// GitHub's browser download form. The path segment between "download" and
// the file name is the tag for a published release, or "untagged-<hash>"
// for a draft.
const BROWSER_DOWNLOAD_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/;

/**
 * Rewrite `platforms.*.url` from the asset-API URL tauri-action writes to the
 * asset's github.com download URL under `tag` — a draft's untagged-<hash>
 * browser_download_url would 404 once the release is published.
 *
 * `latestJson` is the parsed latest.json, `assets` the parsed GitHub
 * release-assets array ({id, name, browser_download_url}), `repository` the
 * "<owner>/<repo>" slug the feed must belong to, `tag` the git tag the
 * release will be published under. Returns the rewritten object (the input
 * is not mutated), whether anything changed, and the platform keys that were
 * rewritten. Throws when a URL names an asset that is not in `assets`, when
 * an asset's browser_download_url is not a github.com download URL of
 * `repository`, or when `tag` is missing.
 */
export function rewriteUpdaterJson(latestJson, assets, repository, tag) {
  if (typeof tag !== "string" || tag.trim() === "") {
    throw new Error(
      `the tag the release will be published under is required, got ${JSON.stringify(tag)}`,
    );
  }
  const byId = new Map();
  for (const asset of assets ?? []) {
    const url = asset?.browser_download_url;
    const match = typeof url === "string" ? BROWSER_DOWNLOAD_URL.exec(url) : null;
    if (!match) {
      throw new Error(
        `release asset ${JSON.stringify(asset?.name ?? asset?.id)} has an unexpected ` +
          `browser_download_url (${JSON.stringify(url)}); expected an ` +
          `https://github.com/<owner>/<repo>/releases/download/... URL`,
      );
    }
    if (`${match[1]}/${match[2]}` !== repository) {
      throw new Error(
        `release asset ${JSON.stringify(asset?.name ?? asset?.id)} is served from ` +
          `${match[1]}/${match[2]}, not from ${repository}`,
      );
    }
    if (asset.id != null) {
      // A draft serves the file under untagged-<hash>; substitute the tag the
      // release will be published under (a no-op for a published URL whose
      // segment already equals the tag). The file-name segment is preserved
      // exactly as GitHub encodes it.
      byId.set(
        String(asset.id),
        match[3] === tag
          ? url
          : `https://github.com/${match[1]}/${match[2]}/releases/download/${encodeURIComponent(tag)}/${match[4]}`,
      );
    }
  }

  const platforms = latestJson?.platforms;
  if (!platforms || typeof platforms !== "object") {
    return { latestJson, changed: false, rewrittenPlatforms: [] };
  }

  const rewrittenPlatforms = [];
  const nextPlatforms = {};
  for (const [platform, entry] of Object.entries(platforms)) {
    const url = entry?.url;
    const match = typeof url === "string" ? ASSET_API_URL.exec(url) : null;
    // Not the asset-API form (already rewritten, or hand-edited), or a
    // different repository's release: leave it alone.
    if (!match || `${match[1]}/${match[2]}` !== repository) {
      nextPlatforms[platform] = entry;
      continue;
    }
    const downloadUrl = byId.get(match[3]);
    if (downloadUrl === undefined) {
      throw new Error(
        `latest.json points ${JSON.stringify(platform)} at release asset ${match[3]}, ` +
          `which is not among the release's assets ` +
          `(have: ${[...byId.keys()].sort((a, b) => a - b).join(", ") || "none"})`,
      );
    }
    nextPlatforms[platform] = { ...entry, url: downloadUrl };
    rewrittenPlatforms.push(platform);
  }

  return {
    latestJson: { ...latestJson, platforms: nextPlatforms },
    changed: rewrittenPlatforms.length > 0,
    rewrittenPlatforms,
  };
}

function readFlag(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= argv.length) {
    throw new Error(
      `usage: rewrite-updater-json.mjs --latest-json <file> --assets <file> --repository <owner>/<repo> --tag <tag> ` +
        `(missing --${name})`,
    );
  }
  return argv[index + 1];
}

function main() {
  const argv = process.argv.slice(2);
  const latestJsonPath = readFlag(argv, "latest-json");
  const assetsPath = readFlag(argv, "assets");
  const repository = readFlag(argv, "repository");
  const tag = readFlag(argv, "tag");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`--repository must be an "<owner>/<repo>" slug, got ${JSON.stringify(repository)}`);
  }
  if (!tag.trim()) {
    throw new Error(`--tag (the tag the release will be published under) must not be empty`);
  }

  const latestJson = JSON.parse(readFileSync(latestJsonPath, "utf8"));
  const assets = JSON.parse(readFileSync(assetsPath, "utf8"));
  if (!Array.isArray(assets)) {
    throw new Error(`${assetsPath} does not contain a JSON array of release assets`);
  }

  const { latestJson: rewritten, changed, rewrittenPlatforms } =
    rewriteUpdaterJson(latestJson, assets, repository, tag);
  writeFileSync(latestJsonPath, `${JSON.stringify(rewritten, null, 2)}\n`);
  console.log(
    changed
      ? `${latestJsonPath}: rewrote ${rewrittenPlatforms.length} platform URL(s) to github.com download URLs under tag ${tag} (${rewrittenPlatforms.join(", ")})`
      : `${latestJsonPath}: no ${repository} asset-API URLs found; left unchanged`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
