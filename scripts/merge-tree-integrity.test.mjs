import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import test from "node:test";

const root = process.cwd();
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

test("no local Rust build output is tracked, while source trees remain eligible", () => {
  const tracked = git("ls-files", "crates/**").split("\n").filter(Boolean);
  assert.deepEqual(tracked.filter((file) => file.split("/").includes("target")), []);
  const ignored = execFileSync("git", ["check-ignore", "-v", "crates/management-host/target/.rustc_info.json"], { cwd: root, encoding: "utf8" });
  assert.match(ignored, /crates\/\*\*\/target\//);
  assert.throws(() => git("check-ignore", "-q", "crates/management-host/src/lib.rs"), /Command failed/);
  // Fixture-cache existence is intentionally machine-local, not a CI invariant.
  // A clean clone has no cache; this test runs identically there.
});

test("upstream icon replacements are intact, self-contained PNGs", () => {
  // Content hashes only: git hash-object is a pure content hash, and the
  // sha256/size/magic values are literals, so neither an upstream blob object
  // nor a remote ref has to exist for this guard to run.
  const expected = new Map([
    ["demo/public/icons/apple-touch-icon.png", { blob: "44b1f2e8396595355d54a0b11a8df8fb6ac5fc55", sha256: "5d5ae770b8619f8e8fb761101aa8d86e65420bb7c0b1714c88f2778fa1e80e01", size: 10161 }],
    ["demo/public/icons/icon-192.png", { blob: "11374f5791e23b8e60d84579fef76e1b6483ffc7", sha256: "e532accc7a757295cd31130745d002334c99504196f9aba75711a56f7d7396ad", size: 11061 }],
    ["demo/public/icons/icon-512.png", { blob: "dfc970b69c3ffe76ca8478059d37bcd83c9f21ac", sha256: "3a296a0be4c82af02cd88e1b285bb4e7115dfb1645b9bdd7d69b11d4eeb12462", size: 51091 }],
  ]);
  for (const [path, { blob, sha256, size }] of expected) {
    const bytes = readFileSync(join(root, path));
    assert.equal(statSync(join(root, path)).size, size, `${path} is the complete ${size}-byte file`);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} is a PNG`);
    assert.equal(git("hash-object", path).trim(), blob, `${path} retains upstream's complete blob`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, `${path} matches upstream bytes`);
  }
});

test("the bundled pi-web pin agrees with the packaged pi-web version", () => {
  const pins = JSON.parse(readFileSync(join(root, "scripts/release-component-pins.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pins["pi-web"].version, pkg.version);
});

// The runner exports this to its own test files; inherited unchanged, a nested
// `node --test` skips the file and exits 0, which would make this guard vacuous.
const cleanEnv = { ...process.env, PI_WEB_INTEGRITY_NESTED: "1" };
delete cleanEnv.NODE_TEST_CONTEXT;

/** What the next commit will contain: index paths, working-tree bytes. */
function materializePendingTree(scratch) {
  for (const file of git("ls-files", "-z").split("\0").filter(Boolean)) {
    mkdirSync(dirname(join(scratch, file)), { recursive: true });
    copyFileSync(join(root, file), join(scratch, file));
  }
  execFileSync("git", ["-C", scratch, "add", "-A"]);
}

test("a clean checkout with no local Rust cache passes these integrity checks", {
  skip: process.env.PI_WEB_INTEGRITY_NESTED === "1" ? "already running inside the clean checkout" : false,
}, () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-web-merge-integrity-"));
  execFileSync("git", ["init", "-q", scratch]);
  materializePendingTree(scratch);
  // The copy carries neither this machine's ignored build output nor any object
  // from a remote/upstream ref, so the checks below cannot lean on either.
  assert.equal(git("-C", scratch, "ls-files", "crates/**").includes("/target/"), false);
  assert.equal(statSync(join(scratch, "crates/management-host/target/.rustc_info.json"), { throwIfNoEntry: false }), undefined);
  execFileSync(process.execPath, ["--test", join(root, "scripts/merge-tree-integrity.test.mjs")], { cwd: scratch, stdio: "pipe", env: cleanEnv });
});

test("only the dynamic manifest route remains", () => {
  assert.equal(statSync(join(root, "app/manifest.ts"), { throwIfNoEntry: false }), undefined);
  assert.equal(readFileSync(join(root, "app/manifest.webmanifest/route.ts"), "utf8").includes("MetadataRoute"), true);
});
