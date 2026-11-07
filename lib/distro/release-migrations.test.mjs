import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { runReleaseMigrations, RELEASE_MIGRATIONS } = await jiti.import("./release-migrations.ts");

test("skipped releases run in semver order, each once, independently of unknown future receipts", () => {
  const calls = [];
  const entries = ["0.8.210", "0.8.209", "0.8.99"].map((version) => ({ version, run: (dir) => calls.push([version, dir]) }));
  const previous = { "0.8.99": true, "1.0.0": true };
  const next = runReleaseMigrations("sandbox", previous, entries);
  assert.deepEqual(calls, [["0.8.209", "sandbox"], ["0.8.210", "sandbox"]]);
  assert.deepEqual(previous, { "0.8.99": true, "1.0.0": true });
  assert.deepEqual(next, { "0.8.99": true, "1.0.0": true, "0.8.209": true, "0.8.210": true });
  assert.deepEqual(runReleaseMigrations("sandbox", next, entries), next);
  assert.equal(calls.length, 2);
});

test("failure records no completion, blocks later migrations and retries without repeating successes", (t) => {
  t.mock.method(console, "warn", () => {});
  let fails = true;
  const calls = [];
  const entries = ["0.8.209", "0.8.210", "0.8.211"].map((version) => ({ version, run() {
    calls.push(version);
    if (version === "0.8.210" && fails) throw new Error("disk failure");
  } }));
  const first = runReleaseMigrations("sandbox", {}, entries);
  assert.deepEqual(first, { "0.8.209": true });
  fails = false;
  const second = runReleaseMigrations("sandbox", first, entries);
  assert.deepEqual(second, { "0.8.209": true, "0.8.210": true, "0.8.211": true });
  assert.deepEqual(calls, ["0.8.209", "0.8.210", "0.8.210", "0.8.211"]);
});

test("invalid/duplicate release registration fails before any migration runs", () => {
  const run = () => assert.fail("must validate the full registry first");
  assert.throws(() => runReleaseMigrations("sandbox", {}, [{ version: "bad", run }]));
  assert.throws(() => runReleaseMigrations("sandbox", {}, [{ version: "0.8.209", run }, { version: "0.8.209", run }]));
});

// The real registry: a malformed auto-review file fails 0.8.210 (so 0.8.215,
// which sorts after it, never runs); once readable both run. That sandbox has
// no models.json, so the Exa fallback migration is a no-op success.
test("real migration retries malformed files, records success, then respects a user's later change", (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
  const dir = mkdtempSync(join(tmpdir(), "distro-release-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "extensions/pi-auto-review"), { recursive: true });
  const file = join(dir, "extensions/pi-auto-review/config.json");
  writeFileSync(file, "invalid");
  assert.deepEqual(runReleaseMigrations(dir), {});
  writeFileSync(file, JSON.stringify({ model: "lw/gemini-3.5-flash-lite" }));
  const done = runReleaseMigrations(dir);
  assert.deepEqual(done, { "0.8.210": true, "0.8.215": true });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).model, "lw/deepseek-v4.1-flash");
  writeFileSync(file, JSON.stringify({ model: "lw/gemini-3.5-flash-lite" }));
  runReleaseMigrations(dir, done);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).model, "lw/gemini-3.5-flash-lite");
  assert.ok(RELEASE_MIGRATIONS.some((entry) => entry.version === "0.8.210"));
  assert.ok(RELEASE_MIGRATIONS.some((entry) => entry.version === "0.8.215"));
});
