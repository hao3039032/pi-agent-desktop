import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  findPiSubagentsPackageDir,
  findSecurityExtensionEntries,
  findSecurityExtensionPaths,
  packageExtensionEntry,
  PERMISSION_SYSTEM_PACKAGE,
} = await createJiti(import.meta.url).import("./permission-system-package.ts");

const AUTO_REVIEW_PACKAGE = "@erichll/pi-auto-review";

/** A package directory with a `pi` manifest whose first extension entry exists. */
function makePackageDir(root, name, { entry = "src/index.ts", writeEntry = true } = {}) {
  const dir = path.join(root, "npm", "node_modules", ...name.split("/"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, pi: { extensions: [`./${entry}`] } }));
  if (writeEntry) writeFileSync(path.join(dir, entry), "export default () => {};\n");
  return dir;
}

function withTempDir(prefix, run) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("npm sources resolve to the agent dir layout, with or without a version", () => {
  withTempDir("pi-web-perm-", (agentDir) => {
    // Nothing installed: the npm entry resolves to a missing directory.
    assert.deepEqual(findSecurityExtensionPaths([`npm:${PERMISSION_SYSTEM_PACKAGE}`], agentDir), []);

    const gateDir = makePackageDir(agentDir, PERMISSION_SYSTEM_PACKAGE);
    assert.deepEqual(findSecurityExtensionPaths([`npm:${PERMISSION_SYSTEM_PACKAGE}`], agentDir), [gateDir]);
    assert.deepEqual(findSecurityExtensionPaths([`npm:${PERMISSION_SYSTEM_PACKAGE}@40.2.0`], agentDir), [gateDir]);
  });
});

test("the reviewer never loads without the gate, and follows it when both are installed", () => {
  withTempDir("pi-web-perm-", (agentDir) => {
    makePackageDir(agentDir, AUTO_REVIEW_PACKAGE);
    assert.deepEqual(findSecurityExtensionPaths([`npm:${AUTO_REVIEW_PACKAGE}`], agentDir), []);

    const gateDir = makePackageDir(agentDir, PERMISSION_SYSTEM_PACKAGE);
    const reviewDir = path.join(agentDir, "npm", "node_modules", "@erichll", "pi-auto-review");
    // Settings order does not matter: gate first, then the reviewer.
    assert.deepEqual(
      findSecurityExtensionPaths(
        [`npm:${AUTO_REVIEW_PACKAGE}@0.26.0`, `npm:${PERMISSION_SYSTEM_PACKAGE}`],
        agentDir,
      ),
      [gateDir, reviewDir],
    );

    // Entries for other packages never resolve to a security package.
    assert.deepEqual(findSecurityExtensionPaths(["npm:pi-subagents", "/tmp/other"], agentDir), []);
    assert.deepEqual(findSecurityExtensionPaths(undefined, agentDir), []);
  });
});

test("local pi-seed style entries resolve, whatever their separators and trailing slash", () => {
  withTempDir("pi-web-seed-", (seedDir) => {
    const gateDir = makePackageDir(seedDir, PERMISSION_SYSTEM_PACKAGE);
    const spelled = `${gateDir}${path.sep}`;
    const [resolved] = findSecurityExtensionPaths([spelled], seedDir);
    // Compare as paths: the entry is used as written, minus the trailing slash.
    assert.equal(path.resolve(resolved), path.resolve(gateDir));

    // A path that merely contains the name as a prefix of another package.
    const decoy = path.join(seedDir, "npm", "node_modules", `${PERMISSION_SYSTEM_PACKAGE}-extra`);
    mkdirSync(decoy, { recursive: true });
    writeFileSync(path.join(decoy, "package.json"), "{}");
    assert.deepEqual(findSecurityExtensionPaths([decoy], seedDir), []);

    // git: sources never match.
    assert.deepEqual(findSecurityExtensionPaths(["git:github.com/gotgenes/pi-packages"], seedDir), []);
  });
});

test("extension entries are the manifest's first entry file, gate first", () => {
  withTempDir("pi-web-perm-", (agentDir) => {
    const gateDir = makePackageDir(agentDir, PERMISSION_SYSTEM_PACKAGE);
    const reviewDir = makePackageDir(agentDir, AUTO_REVIEW_PACKAGE);
    assert.equal(packageExtensionEntry(gateDir), path.join(gateDir, "src", "index.ts"));

    assert.deepEqual(
      findSecurityExtensionEntries([`npm:${AUTO_REVIEW_PACKAGE}`, `npm:${PERMISSION_SYSTEM_PACKAGE}`], agentDir),
      [
        { id: "gotgenes-pi-permission-system", path: path.join(gateDir, "src", "index.ts") },
        { id: "erichll-pi-auto-review", path: path.join(reviewDir, "src", "index.ts") },
      ],
    );
    // Gate alone is a complete set.
    assert.deepEqual(
      findSecurityExtensionEntries([`npm:${PERMISSION_SYSTEM_PACKAGE}`], agentDir).map(({ id }) => id),
      ["gotgenes-pi-permission-system"],
    );
  });
});

test("an installed package without a loadable entry yields no partial set", () => {
  withTempDir("pi-web-perm-", (agentDir) => {
    makePackageDir(agentDir, PERMISSION_SYSTEM_PACKAGE);
    // The reviewer's manifest names an entry that does not exist: loading the
    // gate alone would leave its authorizerChain naming a link nobody provides.
    makePackageDir(agentDir, AUTO_REVIEW_PACKAGE, { writeEntry: false });
    assert.deepEqual(
      findSecurityExtensionEntries([`npm:${PERMISSION_SYSTEM_PACKAGE}`, `npm:${AUTO_REVIEW_PACKAGE}`], agentDir),
      [],
    );
    assert.equal(packageExtensionEntry(path.join(agentDir, "missing")), undefined);
  });
});

test("pi-subagents resolves like the security packages", () => {
  withTempDir("pi-web-perm-", (agentDir) => {
    assert.equal(findPiSubagentsPackageDir(["npm:pi-subagents"], agentDir), undefined);
    const dir = makePackageDir(agentDir, "pi-subagents");
    assert.equal(findPiSubagentsPackageDir(["npm:pi-subagents@0.76.1"], agentDir), dir);
    assert.equal(findPiSubagentsPackageDir([dir], agentDir), dir);
    assert.equal(findPiSubagentsPackageDir([`npm:${PERMISSION_SYSTEM_PACKAGE}`], agentDir), undefined);
  });
});
