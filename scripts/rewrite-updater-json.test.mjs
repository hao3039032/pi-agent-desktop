import assert from "node:assert/strict";
import test from "node:test";
import { rewriteUpdaterJson } from "./rewrite-updater-json.mjs";

const repository = "abcwyc/pi-agent-desktop";
const tag = "v0.6.0-rev.1";

function asset(id, name) {
  return { id, name, browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}` };
}

// A draft release serves the same assets from an untagged-<hash> path — that
// segment only becomes the tag once the draft is published.
function draftAsset(id, name) {
  return { id, name, browser_download_url: `https://github.com/${repository}/releases/download/untagged-05a85f5ca99828e5fd06/${name}` };
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
      "windows-x86_64": { signature: "sig-win", url: apiAssetUrl(101) },
    },
  };
}

test("asset-API URLs are rewritten to the matching asset's download URL under the tag", () => {
  const original = tauriActionLatestJson();
  const { latestJson, changed, rewrittenPlatforms } = rewriteUpdaterJson(original, assets, repository, tag);

  assert.equal(changed, true);
  assert.deepEqual(rewrittenPlatforms, ["darwin-aarch64", "linux-x86-64", "windows-x86_64"]);
  assert.equal(latestJson.platforms["darwin-aarch64"].url, assets[2].browser_download_url);
  assert.equal(latestJson.platforms["linux-x86-64"].url, assets[1].browser_download_url);
  assert.equal(latestJson.platforms["windows-x86_64"].url, assets[0].browser_download_url);
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
      "windows-x86_64": { signature: "sig-win", url: apiAssetUrl(101) },
      "windows-x86_64-nsis": { signature: "sig-win", url: apiAssetUrl(101) },
    },
  };
  const { latestJson: rewritten, changed } = rewriteUpdaterJson(latestJson, assets, repository, tag);

  assert.equal(changed, true);
  assert.equal(rewritten.platforms["windows-x86_64"].url, assets[0].browser_download_url);
  assert.equal(rewritten.platforms["windows-x86_64-nsis"].url, assets[0].browser_download_url);
});

test("a draft's untagged-<hash> URLs are rewritten under the release tag", () => {
  // That is exactly the v0.6.0-rev.1 breakage: rewriting to the draft's
  // browser_download_url verbatim shipped URLs that 404 once the release was
  // published. The tag must be substituted while the release is still a draft.
  const draftAssets = [
    draftAsset(101, "Pi.Agent.LW_0.6.0-rev.1_x64-setup.exe"),
    draftAsset(102, "My%20App.app.tar.gz"),
  ];
  const latestJson = {
    platforms: {
      "windows-x86_64": { signature: "sig-win", url: apiAssetUrl(101) },
      "darwin-aarch64": { signature: "sig-mac", url: apiAssetUrl(102) },
    },
  };
  const { latestJson: rewritten, changed, rewrittenPlatforms } = rewriteUpdaterJson(latestJson, draftAssets, repository, tag);

  assert.equal(changed, true);
  assert.deepEqual(rewrittenPlatforms, ["windows-x86_64", "darwin-aarch64"]);
  // The untagged-<hash> segment is replaced by the tag; the file-name segment
  // (including its percent-encoding) is preserved verbatim.
  assert.equal(
    rewritten.platforms["windows-x86_64"].url,
    `https://github.com/${repository}/releases/download/${tag}/Pi.Agent.LW_0.6.0-rev.1_x64-setup.exe`,
  );
  assert.equal(
    rewritten.platforms["darwin-aarch64"].url,
    `https://github.com/${repository}/releases/download/${tag}/My%20App.app.tar.gz`,
  );
  assert.equal(rewritten.platforms["windows-x86_64"].signature, "sig-win");
});

test("an asset served from another repository throws", () => {
  const foreign = [
    { id: 102, name: "x.deb", browser_download_url: "https://github.com/someone/else/releases/download/v1/x.deb" },
  ];
  assert.throws(
    () => rewriteUpdaterJson({ platforms: { "linux-x86-64": { signature: "s", url: apiAssetUrl(102) } } }, foreign, repository, tag),
    /someone\/else, not from abcwyc\/pi-agent-desktop/,
  );
});

test("a missing or empty tag throws", () => {
  assert.throws(() => rewriteUpdaterJson(tauriActionLatestJson(), assets, repository), /tag the release will be published under/);
  assert.throws(() => rewriteUpdaterJson(tauriActionLatestJson(), assets, repository, "  "), /tag the release will be published under/);
});

test("a URL naming an asset that is not in the release throws", () => {
  const latestJson = { platforms: { "linux-x86-64": { signature: "s", url: apiAssetUrl(404) } } };
  assert.throws(
    () => rewriteUpdaterJson(latestJson, assets, repository, tag),
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
  const { latestJson: rewritten, changed } = rewriteUpdaterJson(latestJson, assets, repository, tag);

  assert.equal(changed, false);
  assert.deepEqual(rewritten, latestJson);
});

test("an asset-API URL for another repository is left untouched", () => {
  const latestJson = {
    platforms: { "linux-x86-64": { signature: "s", url: "https://api.github.com/repos/someone/else/releases/assets/102" } },
  };
  const { latestJson: rewritten, changed } = rewriteUpdaterJson(latestJson, assets, repository, tag);

  assert.equal(changed, false);
  assert.deepEqual(rewritten, latestJson);
});

test("an asset whose browser_download_url is not a github.com download URL throws", () => {
  const latestJson = { platforms: { "linux-x86-64": { signature: "s", url: apiAssetUrl(102) } } };
  const hijacked = [{ id: 102, name: "evil.deb", browser_download_url: "https://evil.example.com/payload.deb" }];
  assert.throws(
    () => rewriteUpdaterJson(latestJson, hijacked, repository, tag),
    /browser_download_url .*evil\.example\.com/,
  );
});

test("rewriting an already-rewritten feed changes nothing", () => {
  const first = rewriteUpdaterJson(tauriActionLatestJson(), assets, repository, tag);
  const second = rewriteUpdaterJson(first.latestJson, assets, repository, tag);

  assert.equal(second.changed, false);
  assert.deepEqual(second.rewrittenPlatforms, []);
  assert.deepEqual(second.latestJson, first.latestJson);
});
