import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  APP_UPDATE_CHECK_INTERVAL_MS,
  checkAppUpdate,
  compareAppVersions,
  getNextAppUpdateCheckAt,
  getLatestAppRelease,
  isAppUpdateDue,
} = await jiti.import("./app-updates.ts");

const project = {
  id: "pi-agent-desktop",
  name: "Pi Agent",
  repository: "abcwyc/pi-agent-desktop",
  currentVersion: "0.8.5",
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("compares stable and prerelease semantic versions", () => {
  assert.equal(compareAppVersions("0.81.1", "0.81.0"), 1);
  assert.equal(compareAppVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareAppVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareAppVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareAppVersions("0.1", "0.1.0"), 0);
  assert.throws(() => compareAppVersions("latest", "1.0.0"), /Invalid version/);
});

test("returns a newer official GitHub release", async () => {
  let requestedUrl = "";
  const update = await checkAppUpdate(project, {
    fetcher: async (url) => {
      requestedUrl = url;
      return jsonResponse({
        tag_name: "v0.8.6",
        html_url: "https://github.com/abcwyc/pi-agent-desktop/releases/tag/v0.8.6",
        draft: false,
        prerelease: false,
      });
    },
  });

  assert.match(requestedUrl, /repos\/abcwyc\/pi-agent-desktop\/releases\/latest$/);
  assert.deepEqual(update, {
    project: "pi-agent-desktop",
    name: "Pi Agent",
    currentVersion: "0.8.5",
    latestVersion: "0.8.6",
    releaseUrl: "https://github.com/abcwyc/pi-agent-desktop/releases/tag/v0.8.6",
  });
});

test("does not report the installed release or prereleases", async () => {
  const current = await checkAppUpdate(project, {
    fetcher: async () => jsonResponse({
      tag_name: "v0.8.5",
      html_url: "https://github.com/abcwyc/pi-agent-desktop/releases/tag/v0.8.5",
    }),
  });
  assert.equal(current, null);

  await assert.rejects(
    checkAppUpdate(project, {
      fetcher: async () => jsonResponse({
        tag_name: "v0.9.0-beta.1",
        html_url: "https://github.com/abcwyc/pi-agent-desktop/releases/tag/v0.9.0-beta.1",
        prerelease: true,
      }),
    }),
    /non-stable/i,
  );
});

test("represents a repository without releases", async () => {
  const appProject = {
    id: "pi-agent-desktop",
    name: "pi-agent-desktop",
    repository: "abcwyc/pi-agent-desktop",
    currentVersion: "0.1",
  };
  const release = await getLatestAppRelease(appProject, {
    fetcher: async () => jsonResponse({}, 404),
  });

  assert.deepEqual(release, {
    project: "pi-agent-desktop",
    name: "pi-agent-desktop",
    repository: "abcwyc/pi-agent-desktop",
    repositoryUrl: "https://github.com/abcwyc/pi-agent-desktop",
    currentVersion: "0.1",
    latestVersion: null,
    releaseUrl: null,
    updateAvailable: false,
    releaseStatus: "unpublished",
  });
});

test("rejects failed requests and untrusted release URLs", async () => {
  await assert.rejects(
    checkAppUpdate(project, { fetcher: async () => jsonResponse({}, 503) }),
    /HTTP 503/,
  );
  await assert.rejects(
    checkAppUpdate(project, {
      fetcher: async () => jsonResponse({
        tag_name: "v0.8.6",
        html_url: "https://example.com/fake-release",
      }),
    }),
    /invalid release URL/i,
  );
});

test("falls back to the releases/latest redirect when the API is unreachable", async () => {
  const urls = [];
  const release = await getLatestAppRelease(project, {
    fetcher: async (url) => {
      urls.push(url);
      if (url.startsWith("https://api.github.com/")) {
        throw new TypeError("fetch failed");
      }
      return new Response(null, {
        status: 302,
        headers: { Location: "https://github.com/abcwyc/pi-agent-desktop/releases/tag/v0.8.6" },
      });
    },
  });

  assert.equal(urls.length, 2);
  assert.match(urls[1], /github\.com\/abcwyc\/pi-agent-desktop\/releases\/latest$/);
  assert.equal(release.releaseStatus, "available");
  assert.equal(release.latestVersion, "0.8.6");
  assert.equal(release.updateAvailable, true);
  assert.equal(release.releaseUrl, "https://github.com/abcwyc/pi-agent-desktop/releases/tag/v0.8.6");
});

test("the redirect fallback maps a missing stable release to unpublished", async () => {
  const release = await getLatestAppRelease(project, {
    fetcher: async (url) => {
      if (url.startsWith("https://api.github.com/")) {
        return jsonResponse({}, 500);
      }
      return new Response(null, {
        status: 302,
        headers: { Location: "https://github.com/abcwyc/pi-agent-desktop/releases" },
      });
    },
  });

  assert.equal(release.releaseStatus, "unpublished");
  assert.equal(release.updateAvailable, false);
});

test("the redirect fallback keeps the API error when both paths fail", async () => {
  await assert.rejects(
    getLatestAppRelease(project, {
      fetcher: async () => new Response(null, { status: 502 }),
    }),
    /HTTP 502/,
  );
});

test("the redirect fallback keeps the API error when the probe leaves github.com", async () => {
  await assert.rejects(
    getLatestAppRelease(project, {
      fetcher: async (url) => {
        if (url.startsWith("https://api.github.com/")) return jsonResponse({}, 502);
        return new Response(null, {
          status: 302,
          headers: { Location: "https://example.com/x" },
        });
      },
    }),
    /HTTP 502/,
  );
});

test("the redirect fallback keeps the API error when the probe points at another repository", async () => {
  await assert.rejects(
    getLatestAppRelease(project, {
      fetcher: async (url) => {
        if (url.startsWith("https://api.github.com/")) return jsonResponse({}, 502);
        return new Response(null, {
          status: 302,
          headers: { Location: "https://github.com/other/repo/releases/tag/v9.9.9" },
        });
      },
    }),
    /HTTP 502/,
  );
});

test("checks the desktop release no more than once per week", () => {
  const now = Date.UTC(2026, 6, 22);
  assert.equal(isAppUpdateDue(undefined, now), true);
  assert.equal(isAppUpdateDue(now - APP_UPDATE_CHECK_INTERVAL_MS + 1, now), false);
  assert.equal(isAppUpdateDue(now - APP_UPDATE_CHECK_INTERVAL_MS, now), true);
  assert.equal(isAppUpdateDue(now + 1, now), true);

  assert.equal(getNextAppUpdateCheckAt({ "pi-agent-desktop": now }, now), now + APP_UPDATE_CHECK_INTERVAL_MS);
  assert.equal(getNextAppUpdateCheckAt({}, now), now);
});
