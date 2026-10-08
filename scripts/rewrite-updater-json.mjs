#!/usr/bin/env node
/**
 * Fork: rewrite the updater feed's api.github.com download URLs.
 *
 *   node scripts/rewrite-updater-json.mjs \
 *     --latest-json <file> --assets <file> --repository <owner>/<repo>
 *
 * tauri-apps/tauri-action writes latest.json with every platforms.*.url
 * pointing at the release-asset *API* endpoint
 * (https://api.github.com/repos/<repo>/releases/assets/<id> — hardcoded in
 * its src/upload-version-json.ts, no input changes it). Checking for updates
 * only needs the JSON, but the download itself then goes through
 * api.github.com, which some networks block while github.com stays reachable:
 * the in-app check succeeds and the download fails. The release workflow
 * therefore rewrites those URLs to the assets' browser_download_url
 * (https://github.com/<repo>/releases/download/...) before publishing the
 * draft release.
 *
 * The minisign signatures cover the artifacts, not latest.json, so moving the
 * pointer cannot forge an update. Safe to re-run: URLs that do not match the
 * API pattern (an already-rewritten feed) are left untouched.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// tauri-action's asset-API form, with the owner/repo it belongs to.
const ASSET_API_URL = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/releases\/assets\/(\d+)$/;

/**
 * Rewrite `platforms.*.url` from the asset-API URL tauri-action writes to the
 * asset's browser_download_url.
 *
 * `latestJson` is the parsed latest.json, `assets` the parsed GitHub
 * release-assets array ({id, name, browser_download_url}), `repository` the
 * "<owner>/<repo>" slug the feed must belong to. Returns the rewritten
 * object (the input is not mutated), whether anything changed, and the
 * platform keys that were rewritten. Throws when a URL names an asset that is
 * not in `assets`, or when an asset's browser_download_url is not on
 * github.com.
 */
export function rewriteUpdaterJson(latestJson, assets, repository) {
  const byId = new Map();
  for (const asset of assets ?? []) {
    const url = asset?.browser_download_url;
    if (typeof url !== "string" || !url.startsWith("https://github.com/")) {
      throw new Error(
        `release asset ${JSON.stringify(asset?.name ?? asset?.id)} has an unexpected ` +
          `browser_download_url (${JSON.stringify(url)}); expected an https://github.com/ URL`,
      );
    }
    if (asset.id != null) byId.set(String(asset.id), url);
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
      `usage: rewrite-updater-json.mjs --latest-json <file> --assets <file> --repository <owner>/<repo> ` +
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
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`--repository must be an "<owner>/<repo>" slug, got ${JSON.stringify(repository)}`);
  }

  const latestJson = JSON.parse(readFileSync(latestJsonPath, "utf8"));
  const assets = JSON.parse(readFileSync(assetsPath, "utf8"));
  if (!Array.isArray(assets)) {
    throw new Error(`${assetsPath} does not contain a JSON array of release assets`);
  }

  const { latestJson: rewritten, changed, rewrittenPlatforms } =
    rewriteUpdaterJson(latestJson, assets, repository);
  writeFileSync(latestJsonPath, `${JSON.stringify(rewritten, null, 2)}\n`);
  console.log(
    changed
      ? `${latestJsonPath}: rewrote ${rewrittenPlatforms.length} platform URL(s) to browser_download_url (${rewrittenPlatforms.join(", ")})`
      : `${latestJsonPath}: no ${repository} asset-API URLs found; left unchanged`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
