import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  isMirrorHost,
  mirrorGitHubUrl,
  isMirrorableGitHubUrl,
  normalizeMirrorHost,
  parseMirrorList,
} = await jiti.import("./update-mirrors.ts");
const {
  distroConfigCandidates,
  readDistroMirrors,
  resolveUpdateMirrors,
} = await jiti.import("./update-mirrors-server.ts");
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

test("a mirror must be a bare host, never a URL or a path", () => {
  for (const host of ["gh-proxy.com", "ghproxy.cn", "mirror.example.org:8443", "a-b.c-d.example"]) {
    assert.equal(isMirrorHost(host), true, host);
    assert.equal(normalizeMirrorHost(`https://${host}/`), host);
  }
  for (const value of [
    "",
    "localhost",
    "gh-proxy.com/",
    "https://gh-proxy.com",
    "gh-proxy.com/https://github.com",
    "user:pass@gh-proxy.com",
    "-bad.example.com",
    "bad-.example.com",
    "bad..example.com",
    "gh-proxy.com:abc",
    "gh-proxy.com:123456",
    "with space.example.com",
  ]) {
    assert.equal(isMirrorHost(value), false, value);
  }
  assert.deepEqual(parseMirrorList(" gh-proxy.com , ghproxy.cn ,, https://nope"), ["gh-proxy.com", "ghproxy.cn"]);
});

test("PI_UPDATE_MIRRORS really overrides, and an empty value really disables", () => {
  // Unset: the distribution's own list wins.
  assert.deepEqual(resolveUpdateMirrors({}, "/nonexistent"), []);
  // A non-empty override replaces the file.
  assert.deepEqual(resolveUpdateMirrors({ PI_UPDATE_MIRRORS: "a.com, b.com " }, "/nonexistent"), ["a.com", "b.com"]);
  assert.deepEqual(resolveUpdateMirrors({ PI_UPDATE_MIRRORS: "https://c.com:8443/" }, "/nonexistent"), ["c.com:8443"]);
  // An EMPTY override is not "unset": it must disable mirroring even when the
  // distribution config names mirrors.
  const dir = mkdtempSync(join(tmpdir(), "pi-update-mirrors-"));
  try {
    writeFileSync(join(dir, "distro.json"), JSON.stringify({ updateMirrors: ["from-file.example"] }));
    assert.deepEqual(resolveUpdateMirrors({}, dir), ["from-file.example"]);
    assert.deepEqual(resolveUpdateMirrors({ PI_UPDATE_MIRRORS: "" }, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the mirror list comes from distro/distro.json, never from a hardcoded default", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-update-mirrors-file-"));
  try {
    // A source checkout keeps the file under distro/; the packaged server
    // stages it next to the launcher. Both are read.
    mkdirSync(join(dir, "distro"));
    writeFileSync(join(dir, "distro", "distro.json"), JSON.stringify({ updateMirrors: ["checkout.example"] }));
    assert.deepEqual(readDistroMirrors(dir), ["checkout.example"]);
    assert.deepEqual(
      distroConfigCandidates(dir).map((path) => relative(dir, path)),
      ["distro.json", join("distro", "distro.json")],
    );

    // A malformed file degrades to direct-only instead of a list nobody wrote.
    writeFileSync(join(dir, "distro.json"), "{ not json");
    assert.equal(readDistroMirrors(dir), null);
    assert.deepEqual(resolveUpdateMirrors({}, dir), []);

    // No file at all: direct-only.
    assert.equal(readDistroMirrors(join(dir, "missing")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("a mirror's 404 is a dead candidate, not an authoritative 'no release'", async () => {
  // A mirror that cannot serve the API path answers 404. Reading that as
  // "this repository has no release" would let a third party hide real updates
  // for a whole check interval, so the next candidate must still be tried.
  const requested = [];
  const release = await getLatestAppRelease(project, {
    mirrors: ["dead.example", "good.example"],
    fetcher: async (url) => {
      requested.push(String(url));
      if (url.includes("dead.example")) return jsonResponse({}, 404);
      if (url.includes("good.example")) return jsonResponse(releasePayload);
      throw new Error("direct github unreachable");
    },
  });

  assert.equal(release.releaseStatus, "available");
  assert.equal(release.latestVersion, "0.7.802");
  assert.match(requested.at(-1), /^https:\/\/good\.example\//);
  // The canonical API 404 still means "no release yet" when nothing else answers.
  const unpublished = await getLatestAppRelease(project, {
    mirrors: [],
    fetcher: async (url) => {
      if (url.startsWith("https://api.github.com/")) return jsonResponse({}, 404);
      throw new Error("github unreachable");
    },
  });
  assert.equal(unpublished.releaseStatus, "unpublished");
});

test("a mirror answering 200 with HTML is a dead candidate, not a release", async () => {
  const requested = [];
  const release = await getLatestAppRelease(project, {
    mirrors: ["html.example", "good.example"],
    fetcher: async (url) => {
      requested.push(String(url));
      if (url.includes("html.example")) {
        return new Response("<html>blocked</html>", { status: 200, headers: { "Content-Type": "text/html" } });
      }
      if (url.includes("good.example")) return jsonResponse(releasePayload);
      throw new Error("direct github unreachable");
    },
  });
  assert.equal(release.releaseStatus, "available");
  assert.match(requested.at(-1), /^https:\/\/good\.example\//);
});

test("release metadata must name THIS repository's tag page", async () => {
  // A host check is not enough: the badge links straight to html_url, so a
  // mirror could otherwise point "an update is available" at any github page.
  const foreign = [
    { html_url: "https://github.com/attacker/pi-agent-desktop/releases/tag/v0.7.802" },
    { html_url: "https://github.com/hao3039032/pi-agent-desktop/releases/latest" },
    { html_url: "https://github.com/hao3039032/pi-agent-desktop/releases/tag/v9.9.9" },
    { html_url: "https://github.com/hao3039032/pi-agent-desktop/releases/tag/v0.7.802?x=1" },
    { html_url: "https://user:pw@github.com/hao3039032/pi-agent-desktop/releases/tag/v0.7.802" },
  ];
  for (const entry of foreign) {
    await assert.rejects(
      getLatestAppRelease(project, {
        mirrors: ["mirror.example"],
        fetcher: async (url) => {
          if (url.includes("mirror.example")) return jsonResponse({ ...releasePayload, ...entry });
          throw new Error("direct github unreachable");
        },
      }),
      /invalid release URL/i,
      entry.html_url,
    );
  }
});

test("the whole check stays inside one deadline", async () => {
  const calls = [];
  const started = Date.now();
  await assert.rejects(
    getLatestAppRelease(project, {
      mirrors: ["a.example", "b.example", "c.example", "d.example"],
      timeoutMs: 120,
      deadlineMs: 150,
      fetcher: async (url) => {
        calls.push(String(url));
        // Simulate a black-holed network: every attempt burns its whole slice.
        await new Promise((resolve) => setTimeout(resolve, 60));
        throw new Error("timeout");
      },
    }),
    /timeout/,
  );
  // Not "one slow attempt per mirror with a full timeout each": the shared
  // budget caps how many can even start.
  assert.ok(Date.now() - started < 900, `took ${Date.now() - started}ms`);
  assert.ok(calls.length <= 6, `made ${calls.length} attempts`);
});

// Identical accept/reject lists live in scripts/distro-build.test.mjs and
// src-tauri/src/update_install.rs: the three validators must agree.
const ACCEPTED_MIRRORS = ["gh-proxy.com", "ghproxy.cn", "mirror.example.org:8443", "a-b.c-d.example"];
const REJECTED_MIRRORS = [
  "", "localhost", "gh-proxy.com/", "https://gh-proxy.com", "gh-proxy.com/https://github.com",
  "user:pass@gh-proxy.com", "-bad.example.com", "bad-.example.com", "bad..example.com",
  "gh-proxy.com:abc", "gh-proxy.com:123456", "gh-proxy.com:0", "gh-proxy.com:65536",
  "with space.example.com",
];

test("mirror hosts use the same accept/reject rules as the build and the shell", async () => {
  const { isMirrorHost } = await jiti.import("./update-mirrors.ts");
  for (const host of ACCEPTED_MIRRORS) assert.equal(isMirrorHost(host), true, host);
  for (const host of REJECTED_MIRRORS) assert.equal(isMirrorHost(host), false, host);
});

test("a mirror list keeps its order, drops repeats and stays within the retry budget", async () => {
  const { parseMirrorList, MAX_UPDATE_MIRRORS } = await jiti.import("./update-mirrors.ts");
  assert.equal(MAX_UPDATE_MIRRORS, 3);
  assert.deepEqual(parseMirrorList("a.com, b.com, a.com"), ["a.com", "b.com"]);
  assert.deepEqual(parseMirrorList("a.com,b.com,c.com,d.com"), ["a.com", "b.com", "c.com"]);
  assert.deepEqual(parseMirrorList("gh-proxy.com:0, gh-proxy.com:65536"), []);
});
