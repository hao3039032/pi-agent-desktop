import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { fetchGitStatus } = await createJiti(import.meta.url).import("./git-status-service.ts");

test("fetchGitStatus encodes cwd, forwards cancellation and returns status", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const controller = new AbortController();
  const status = { isGitRepository: true, repositoryRoot: "/tmp/a b", files: [], additions: 1, deletions: 0 };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/git/status?cwd=%2Ftmp%2Fa%20b");
    assert.equal(options.signal, controller.signal);
    return Response.json(status);
  };
  assert.deepEqual(await fetchGitStatus("/tmp/a b", controller.signal), status);
});

test("fetchGitStatus surfaces the route error rather than a successful empty status", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => Response.json({ error: "Access denied" }, { status: 403 });
  await assert.rejects(fetchGitStatus("/outside"), /Access denied/);
});
