import assert from "node:assert/strict";
import test from "node:test";
import { rewriteUpdaterJson } from "./rewrite-updater-json.mjs";

const repository = "abcwyc/pi-agent-desktop";

function asset(id, name) {
  return { id, name, browser_download_url: `https://github.com/${repository}/releases/download/v0.6.0-rev.1/${name}` };
}

// What tauri-action uploads for the three platforms of one distro release.
const assets = [
  asset(101, "Pi.Agent.LW_0.6.0-rev.1_x64-setup.exe"),
  asset(102, "pi-agent-desktop_0.6.0-rev.1_amd64.deb"),
  asset(103, "Pi.Agent.LW.app.tar.gz"),
];

function apiAssetUrl(id) {
  return `https://api.github.com/repos/${repository}/releases/assets/${id}`;
}

function tauriActionLatestJson() {
  return {
    version: "0.6.0-rev.1",
    notes: "Pi Agent LW — pi-agent-desktop with the LW extensions.",
    pub_date: "2026-10-01T00:00:00Z",
    platforms: {
      "darwin-aarch64": { signature: "sig-mac", url: apiAssetUrl(103) },
      "linux-x86-64": { signature: "sig-linux", url: apiAssetUrl(102) },
      "windows-x86-64": { signature: "sig-win", url: apiAssetUrl(101) },
    },
  };
}

test("asset-API URLs are rewritten to the matching asset's browser_download_url", () => {
  const original = tauriActionLatestJson();
  const { latestJson, changed, rewrittenPlatforms } = rewriteUpdaterJson(original, assets, repository);

  assert.equal(changed, true);
  assert.deepEqual(rewrittenPlatforms, ["darwin-aarch64", "linux-x86-64", "windows-x86-64"]);
  assert.equal(latestJson.platforms["darwin-aarch64"].url, assets[2].browser_download_url);
  assert.equal(latestJson.platforms["linux-x86-64"].url, assets[1].browser_download_url);
  assert.equal(latestJson.platforms["windows-x86-64"].url, assets[0].browser_download_url);
  // The signatures (and everything else in the feed) are carried over.
  assert.equal(latestJson.platforms["darwin-aarch64"].signature, "sig-mac");
  assert.equal(latestJson.version, original.version);
  // The input is not mutated, so the caller can diff or retry.
  assert.equal(original.platforms["darwin-aarch64"].url, apiAssetUrl(103));
});

test("a duplicate -nsis entry pointing at the same asset id is rewritten too", () => {
  // tauri-action can emit a per-bundle-format key for the same Windows asset;
  // every platform entry is rewritten independently of the others.
  const latestJson = {
    platforms: {
      "windows-x86-64": { signature: "sig-win", url: apiAssetUrl(101) },
      "windows-x86-64-nsis": { signature: "sig-win", url: apiAssetUrl(101) },
    },
  };
  const { latestJson: rewritten, changed } = rewriteUpdaterJson(latestJson, assets, repository);

  assert.equal(changed, true);
  assert.equal(rewritten.platforms["windows-x86-64"].url, assets[0].browser_download_url);
  assert.equal(rewritten.platforms["windows-x86-64-nsis"].url, assets[0].browser_download_url);
});

test("a URL naming an asset that is not in the release throws", () => {
  const latestJson = { platforms: { "linux-x86-64": { signature: "s", url: apiAssetUrl(404) } } };
  assert.throws(
    () => rewriteUpdaterJson(latestJson, assets, repository),
    /release asset 404.*not among the release's assets/,
  );
});

test("URLs that are not the asset-API form are left untouched", () => {
  const browserUrl = "https://github.com/abcwyc/pi-agent-desktop/releases/download/v0.5.209/app.tar.gz";
  const elsewhere = "https://example.com/download/app.dmg";
  const latestJson = {
    platforms: {
      "darwin-aarch64": { signature: "s1", url: browserUrl },
      "linux-x86-64": { signature: "s2", url: elsewhere },
    },
  };
  const { latestJson: rewritten, changed } = rewriteUpdaterJson(latestJson, assets, repository);

  assert.equal(changed, false);
  assert.deepEqual(rewritten, latestJson);
});

test("an asset-API URL for another repository is left untouched", () => {
  const latestJson = {
    platforms: { "linux-x86-64": { signature: "s", url: "https://api.github.com/repos/someone/else/releases/assets/102" } },
  };
  const { latestJson: rewritten, changed } = rewriteUpdaterJson(latestJson, assets, repository);

  assert.equal(changed, false);
  assert.deepEqual(rewritten, latestJson);
});

test("an asset whose browser_download_url is not on github.com throws", () => {
  const latestJson = { platforms: { "linux-x86-64": { signature: "s", url: apiAssetUrl(102) } } };
  const hijacked = [{ id: 102, name: "evil.deb", browser_download_url: "https://evil.example.com/payload.deb" }];
  assert.throws(
    () => rewriteUpdaterJson(latestJson, hijacked, repository),
    /browser_download_url .*evil\.example\.com/,
  );
});

test("rewriting an already-rewritten feed changes nothing", () => {
  const first = rewriteUpdaterJson(tauriActionLatestJson(), assets, repository);
  const second = rewriteUpdaterJson(first.latestJson, assets, repository);

  assert.equal(second.changed, false);
  assert.deepEqual(second.rewrittenPlatforms, []);
  assert.deepEqual(second.latestJson, first.latestJson);
});
