/**
 * Navigation adapter tests: the centralized URL owns `session/cwd/view`,
 * back/forward restore routes, and the URL wins over restored workspace
 * state on load (plan §四).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VIEW, parseRoute, serializeRoute } from "./navigation.ts";

test("routes parse session/cwd/view and keep extra params", () => {
  const route = parseRoute("http://x/?session=abc&cwd=/tmp/proj&view=files&file=lib/a.ts");
  assert.equal(route.session, "abc");
  assert.equal(route.cwd, "/tmp/proj");
  assert.equal(route.view, "files");
  assert.equal(route.params.get("file"), "lib/a.ts");
});

test("the default view is omitted, not stored", () => {
  assert.equal(parseRoute("http://x/?view=chat").view, undefined);
  assert.equal(serializeRoute({ params: new URLSearchParams() }), "/");
  assert.equal(
    serializeRoute({ view: DEFAULT_VIEW, params: new URLSearchParams() }),
    "/",
  );
});

test("serialize/parse roundtrips", () => {
  const route = { session: "s1", cwd: "/home/u/p", params: new URLSearchParams([["tab", "2"]]) };
  const url = serializeRoute(route);
  const back = parseRoute(`http://x${url}`);
  assert.equal(back.session, "s1");
  assert.equal(back.cwd, "/home/u/p");
  assert.equal(back.params.get("tab"), "2");
});

test("empty URL means the welcome route; workspace restore only fills it", () => {
  const route = parseRoute("http://x/");
  assert.equal(route.session, undefined);
  assert.equal(route.cwd, undefined);
  assert.equal(route.view, undefined);
  assert.equal(route.params.size, 0);
});
