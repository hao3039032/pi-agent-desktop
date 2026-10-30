/**
 * Generate docs/migration/api-inventory.json from the app/api route files
 * plus the curated mapping (scripts/migration/api-inventory-mapping.mjs).
 *
 * Extraction is deliberately source-based (the same facts the plan froze):
 * route files and their exported HTTP method names. The generator fails
 * loudly on drift in either direction:
 *   - a route/method without a mapping entry (must not happen: nothing is
 *     "migrate later" outside the list);
 *   - a mapping entry without its route/method (stale mapping).
 *
 * Usage:
 *   node scripts/migration/generate-api-inventory.mjs           # write
 *   node scripts/migration/generate-api-inventory.mjs --check    # verify only
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { OWNERS, MILESTONES, ROUTE_MAP } from "./api-inventory-mapping.mjs";

const ROOT = join(import.meta.dirname, "../..");
const API_DIR = join(ROOT, "app/api");
const OUT_JSON = join(ROOT, "docs/migration/api-inventory.json");

const METHOD_RE = /^export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm;

/** All route.ts files under app/api, repo-relative, sorted. */
function listRouteFiles(dir = API_DIR, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listRouteFiles(full, acc);
    else if (entry === "route.ts") acc.push(relative(ROOT, full));
  }
  return acc.sort();
}

/** Exported HTTP method names of one route file, in declaration order. */
function extractMethods(file) {
  const source = readFileSync(join(ROOT, file), "utf8");
  const methods = [];
  for (const match of source.matchAll(METHOD_RE)) {
    if (!methods.includes(match[1])) methods.push(match[1]);
  }
  return methods;
}

function assertMappingIsValid(route, entry, methods) {
  const problems = [];
  if (!entry?.domain) problems.push("missing domain");
  const owner = entry.owner;
  if (!OWNERS.includes(owner)) problems.push(`unknown owner ${JSON.stringify(owner)}`);
  if (!MILESTONES.includes(entry.milestone)) problems.push(`unknown milestone ${entry.milestone}`);
  if (!entry.methods) problems.push("missing methods map");
  if (entry.methods) {
    for (const method of methods) {
      const spec = entry.methods[method];
      if (!spec) problems.push(`${method}: no mapping entry (nothing is migrated "later")`);
      else if (spec.op === undefined) problems.push(`${method}: missing op (use null for removed-web-only)`);
      else if (spec.op !== null && typeof spec.op !== "string") problems.push(`${method}: op must be a string or null`);
      if (spec?.owner && !OWNERS.includes(spec.owner)) problems.push(`${method}: unknown owner override`);
    }
    for (const method of Object.keys(entry.methods)) {
      if (!methods.includes(method)) problems.push(`${method}: mapping entry but no such export in ${route}`);
    }
  }
  return problems;
}

export function buildInventory() {
  const files = listRouteFiles();
  const routes = [];
  const problems = [];
  const mappedFiles = new Set(Object.keys(ROUTE_MAP));
  let methodCount = 0;
  const opUniqueness = new Map();

  for (const file of files) {
    const methods = extractMethods(file);
    const entry = ROUTE_MAP[file];
    const routeProblems = assertMappingIsValid(file, entry, methods);
    problems.push(...routeProblems.map((problem) => `${file}: ${problem}`));
    mappedFiles.delete(file);
    const route = {
      route: file,
      domain: entry?.domain ?? null,
      owner: entry?.owner ?? null,
      milestone: entry?.milestone ?? null,
      ...(entry?.notes ? { notes: entry.notes } : {}),
      methods: methods.map((method) => {
        const spec = entry?.methods?.[method] ?? {};
        const methodEntry = {
          method,
          op: spec.op ?? null,
          owner: spec.owner ?? entry?.owner ?? null,
          ...(spec.notes ? { notes: spec.notes } : {}),
        };
        methodCount += 1;
        if (methodEntry.op) {
          const list = opUniqueness.get(methodEntry.op) ?? [];
          list.push(`${file} ${method}`);
          opUniqueness.set(methodEntry.op, list);
        }
        return methodEntry;
      }),
    };
    routes.push(route);
  }
  for (const stale of mappedFiles) {
    problems.push(`${stale}: mapping entry but no such route file`);
  }
  for (const [op, sites] of opUniqueness) {
    if (sites.length > 1) problems.push(`duplicate op ${op}: ${sites.join(", ")}`);
  }
  if (problems.length > 0) {
    throw new Error(`api-inventory mapping problems:\n  ${problems.join("\n  ")}`);
  }
  return {
    schemaVersion: 1,
    generatedFrom: "app/api/**/route.ts + scripts/migration/api-inventory-mapping.mjs",
    totals: { routeFiles: files.length, methods: methodCount },
    owners: OWNERS,
    milestones: MILESTONES,
    routes,
  };
}

// Run the CLI only when executed directly (importing for buildInventory()
// from tests must not rewrite the file).
const isDirectRun = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  const checkOnly = process.argv.includes("--check");
  const inventory = buildInventory();
  if (checkOnly) {
    if (!existsSync(OUT_JSON)) {
      console.error("FAIL: docs/migration/api-inventory.json does not exist; run the generator");
      process.exit(1);
    }
    const current = JSON.parse(readFileSync(OUT_JSON, "utf8"));
    if (JSON.stringify(current) !== JSON.stringify(inventory)) {
      console.error(
        "FAIL: docs/migration/api-inventory.json is out of date with app/api or the mapping; " +
          "run: node scripts/migration/generate-api-inventory.mjs",
      );
      process.exit(1);
    }
    console.log(
      `ok: api-inventory in sync (${inventory.totals.routeFiles} route files, ${inventory.totals.methods} methods)`,
    );
  } else {
    writeFileSync(OUT_JSON, JSON.stringify(inventory, null, 2) + "\n");
    console.log(
      `wrote ${relative(ROOT, OUT_JSON)}: ${inventory.totals.routeFiles} route files, ${inventory.totals.methods} methods`,
    );
  }
}
