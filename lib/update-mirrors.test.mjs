import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mirrorsModule = await jiti.import("./update-mirrors.ts");
const {
  DEFAULT_UPDATE_MIRRORS,
  mirrorGitHubUrl,
  isMirrorableGitHubUrl,
  resolveUpdateMirrors,
} = mirrorsModule;
const { getLatestAppRelease } = await jiti.import("./app-updates.ts");

const project = {
  id: "pi-agent-desktop",
  name: "Pi Agent",
  repository: "hao3039032/pi-agent-desktop",
  currentVersion: "0.7.801",
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const releasePayload = {
  tag_name: "v0.7.802",
  html_url: "https://github.com/hao3039032/pi-agent-desktop/releases/tag/v0.7.802",
  draft: false,
  prerelease: false,
};

test("mirrors only prefix https GitHub URLs", () => {
  assert.equal(
    mirrorGitHubUrl("https://api.github.com/repos/o/r/releases/latest", "gh-proxy.com"),
    "https://gh-proxy.com/https://api.github.com/repos/o/r/releases/latest",
  );
  assert.equal(
    mirrorGitHubUrl("https://github.com/o/r/releases/download/v1/a.zip", "ghproxy.cn/"),
    "https://ghproxy.cn/https://github.com/o/r/releases/download/v1/a.zip",
  );
  // Never mirror arbitrary hosts: a mirror of anything would be an open
  // redirect through someone else's infrastructure.
  assert.equal(mirrorGitHubUrl("https://example.com/file", "gh-proxy.com"), "https://example.com/file");
  assert.equal(mirrorGitHubUrl("http://github.com/insecure", "gh-proxy.com"), "http://github.com/insecure");
  assert.equal(mirrorGitHubUrl("not a url", "gh-proxy.com"), "not a url");
  assert.equal(mirrorGitHubUrl("https://github.com/x", "https://evil%.com/"), "https://github.com/x");
  assert.equal(isMirrorableGitHubUrl("https://objects.githubusercontent.com/a"), true);
  assert.equal(isMirrorableGitHubUrl("https://evil.com/a"), false);
});

test("PI_UPDATE_MIRRORS overrides and clears the mirror list", () => {
  assert.deepEqual(resolveUpdateMirrors({}), DEFAULT_UPDATE_MIRRORS);
  assert.deepEqual(resolveUpdateMirrors({ PI_UPDATE_MIRRORS: "a.com, b.com " }), ["a.com", "b.com"]);
  assert.deepEqual(resolveUpdateMirrors({ PI_UPDATE_MIRRORS: "https://c.com:8443/" }), ["c.com:8443"]);
  assert.deepEqual(resolveUpdateMirrors({ PI_UPDATE_MIRRORS: "" }), []);
});

test("the check falls back to mirrors after both direct paths fail", async () => {
  const requested = [];
  const release = await getLatestAppRelease(project, {
    mirrors: ["mirror-a.example", "mirror-b.example"],
    fetcher: async (url) => {
      requested.push(String(url));
      if (url.includes("mirror-a.example")) return jsonResponse({}, 403);
      if (url.includes("mirror-b.example")) return jsonResponse(releasePayload);
      throw new Error("direct github unreachable");
    },
  });

  // Direct API and direct redirect probe ran first, then mirror A (403 →
  // next), then mirror B answered with a valid release.
  assert.equal(requested.filter((url) => !url.includes(".example")).length, 2);
  assert.match(requested[0], /api\.github\.com\/repos\/hao3039032\/pi-agent-desktop\/releases\/latest$/);
  assert.match(requested[1], /github\.com\/hao3039032\/pi-agent-desktop\/releases\/latest$/);
  assert.match(requested.at(-2), /^https:\/\/mirror-a\.example\/https:\/\/api\.github\.com\//);
  assert.match(requested.at(-1), /^https:\/\/mirror-b\.example\/https:\/\/api\.github\.com\//);
  assert.equal(release.releaseStatus, "available");
  assert.equal(release.latestVersion, "0.7.802");
});

test("a mirror cannot forge a release: validation still applies", async () => {
  await assert.rejects(
    getLatestAppRelease(project, {
      mirrors: ["bad-mirror.example"],
      fetcher: async (url) => {
        if (url.includes("bad-mirror.example")) {
          return jsonResponse({
            tag_name: "v99.0.0",
            html_url: "https://bad-mirror.example/evil-release",
            draft: false,
            prerelease: false,
          });
        }
        throw new Error("direct unreachable");
      },
    }),
    /invalid release URL/i,
  );
});

test("every mirror failing surfaces the original direct error", async () => {
  await assert.rejects(
    getLatestAppRelease(project, {
      mirrors: ["m1.example", "m2.example"],
      fetcher: async () => {
        throw new Error("direct github unreachable");
      },
    }),
    /direct github unreachable/,
  );
});

test("an empty mirror list keeps the direct-only behaviour", async () => {
  const requested = [];
  await assert.rejects(
    getLatestAppRelease(project, {
      mirrors: [],
      fetcher: async (url) => {
        requested.push(String(url));
        throw new Error("nope");
      },
    }),
    /nope/,
  );
  assert.equal(requested.length, 2);
});
