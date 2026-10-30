/**
 * Guards for the migration checklist (docs/migration/api-inventory.json):
 *
 *  1. the checked-in inventory is byte-identical to what the current
 *     app/api sources + curated mapping produce (regeneration sync);
 *  2. the frozen totals from the migration plan hold: 89 route files and
 *     124 exported methods — a change must be a conscious mapping edit,
 *     never silent drift;
 *  3. every method carries an IPC op or an explicit removed-web-only null;
 *     ops are unique; owners and milestones stay in their enums;
 *  4. only the web-only routes (web-auth, push) may have null ops.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildInventory } from "./generate-api-inventory.mjs";

const ROOT = join(import.meta.dirname, "../..");
const INVENTORY = JSON.parse(readFileSync(join(ROOT, "docs/migration/api-inventory.json"), "utf8"));

// The plan's frozen counts (M0: "89 个路由文件、124 个具名 HTTP 方法导出").
const EXPECTED_ROUTE_FILES = 89;
const EXPECTED_METHODS = 124;
const WEB_ONLY_ROUTES = new Set(["app/api/web-auth/route.ts", "app/api/push/config/route.ts", "app/api/push/subscribe/route.ts"]);

test("inventory regenerates identically from the current sources", () => {
  const rebuilt = buildInventory();
  assert.deepEqual(rebuilt, INVENTORY, "run: node scripts/migration/generate-api-inventory.mjs");
});

test("frozen totals hold: 89 route files, 124 methods", () => {
  assert.equal(INVENTORY.totals.routeFiles, EXPECTED_ROUTE_FILES);
  assert.equal(INVENTORY.totals.methods, EXPECTED_METHODS);
  const files = new Set(INVENTORY.routes.map((route) => route.route));
  assert.equal(files.size, EXPECTED_ROUTE_FILES, "route files are unique");
  assert.equal(
    INVENTORY.routes.reduce((sum, route) => sum + route.methods.length, 0),
    EXPECTED_METHODS,
  );
});

test("every method has a unique op (or an explicit web-only removal)", () => {
  const ops = new Map();
  for (const route of INVENTORY.routes) {
    for (const method of route.methods) {
      assert.ok(method.op !== undefined, `${route.route} ${method.method}: op must exist`);
      if (method.op === null) {
        assert.ok(
          WEB_ONLY_ROUTES.has(route.route),
          `${route.route} ${method.method}: null op is reserved for web-only routes`,
        );
        assert.equal(route.owner, "removed-web-only");
        continue;
      }
      assert.match(method.op, /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/, `${route.route} ${method.method}: op must be domain.name`);
      const previous = ops.get(method.op);
      assert.equal(previous, undefined, `duplicate op ${method.op} (${previous} vs ${route.route} ${method.method})`);
      ops.set(method.op, `${route.route} ${method.method}`);
    }
  }
});

test("owners and milestones stay in their enums", () => {
  for (const route of INVENTORY.routes) {
    assert.ok(INVENTORY.owners.includes(route.owner), `${route.route}: owner ${route.owner}`);
    assert.ok(INVENTORY.milestones.includes(route.milestone), `${route.route}: milestone ${route.milestone}`);
    for (const method of route.methods) {
      assert.ok(INVENTORY.owners.includes(method.owner), `${route.route} ${method.method}: owner ${method.owner}`);
    }
  }
});
