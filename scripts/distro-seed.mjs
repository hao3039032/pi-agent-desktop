#!/usr/bin/env node
/**
 * Fork: pre-install the distro's pi packages into src-tauri/resources/pi-seed.
 *
 * Runs on each release runner (packages can contain platform-specific
 * binaries), after `npm ci`. pi itself does the installing — the bundled SDK's
 * CLI runs `update --extensions` against a throwaway agent dir — so the result
 * is exactly what `pi install` would produce on the user's machine. At runtime
 * lib/distro/seed.ts points the user's settings.json at these copies, so the
 * user needs neither npm nor git.
 *
 *   node scripts/distro-seed.mjs
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distro = JSON.parse(readFileSync(join(rootDir, "distro", "distro.json"), "utf8"));
const seedDir = join(rootDir, "src-tauri", "resources", "pi-seed");
const cli = join(rootDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

/** Relative (posix) location pi installs a package source at, inside the agent dir. */
export function seedRelativePath(source) {
  if (source.startsWith("npm:")) {
    const spec = source.slice(4).trim();
    const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
    return `npm/node_modules/${at > 0 ? spec.slice(0, at) : spec}`;
  }
  const git = /^git:([^/]+)\/([^/]+)\/([^/@#]+?)(?:\.git)?(?:[@#].*)?$/.exec(source.trim());
  if (git) return `git/${git[1]}/${git[2]}/${git[3]}`;
  throw new Error(`Unsupported distro package source (use npm: or git:): ${source}`);
}

function run(command, args, env) {
  const result = spawnSync(command, args, { stdio: "inherit", env, cwd: rootDir });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`})`);
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    yield full;
    if (entry.isDirectory() && !entry.isSymbolicLink()) yield* walk(full);
  }
}

/**
 * `npm` / `npm.cmd` shims for the npm CLI bundled at resources/node (see
 * prepare-desktop.mjs). pi spawns `npm` from PATH; the npm package's own
 * wrappers are not present in every Node distribution, so ship explicit ones.
 * `node` itself is on PATH: the Rust shell prepends the bundled runtime's dir.
 */
function writeNpmShims(binDir) {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "npm"),
    '#!/bin/sh\nexec node "${0%/*}/../../node/node_modules/npm/bin/npm-cli.js" "$@"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "npm.cmd"),
    '@node "%~dp0\\..\\..\\node\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n',
  );
}

function main() {
  if (!existsSync(cli)) throw new Error(`pi CLI not found at ${cli}; run npm ci first`);

  const staging = mkdtempSync(join(tmpdir(), "pi-seed-"));
  try {
    writeFileSync(join(staging, "settings.json"), JSON.stringify({ packages: distro.packages }, null, 2));
    const env = { ...process.env, PI_CODING_AGENT_DIR: staging };
    delete env.PI_OFFLINE;
    run(process.execPath, [cli, "update", "--extensions"], env);

    rmSync(seedDir, { recursive: true, force: true });
    mkdirSync(seedDir, { recursive: true });

    const packages = distro.packages.map((source) => {
      const path = seedRelativePath(source);
      const installed = join(staging, ...path.split("/"));
      const pkgJson = join(installed, "package.json");
      if (!existsSync(pkgJson)) throw new Error(`${source} was not installed at ${installed}`);
      return { source, path, version: JSON.parse(readFileSync(pkgJson, "utf8")).version };
    });

    for (const top of ["npm", "git"]) {
      const from = join(staging, top);
      if (existsSync(from)) cpSync(from, join(seedDir, top), { recursive: true, verbatimSymlinks: true });
    }
    for (const pkg of packages) {
      if (!pkg.path.startsWith("git/")) continue;
      const dir = join(seedDir, ...pkg.path.split("/"));
      // History is not needed for a read-only bundled copy.
      rmSync(join(dir, ".git"), { recursive: true, force: true });
      // pi installs git packages with a plain `npm install --omit=dev`, which
      // on npm >= 7 also installs peer dependencies: a full private copy of
      // pi and its SDKs (~170 MB per package) that pi's extension loader never
      // uses, because it aliases @earendil-works/* and typebox to the host.
      // Reinstall without peers, the same way pi installs npm: packages.
      rmSync(join(dir, "node_modules"), { recursive: true, force: true });
      rmSync(join(dir, "package-lock.json"), { force: true });
      const pkgJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (Object.keys(pkgJson.dependencies ?? {}).length > 0) {
        const result = spawnSync(
          "npm",
          ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund", "--no-package-lock"],
          { cwd: dir, stdio: "inherit", shell: process.platform === "win32" },
        );
        if (result.status !== 0) throw new Error(`npm install failed for ${pkg.source}`);
      }
    }

    // Source maps and type declarations are never loaded at runtime; dropping
    // them saves ~20 MiB / ~4k files in every installer.
    for (const file of [...walk(seedDir)]) {
      if (/\.(?:map|d\.ts|d\.mts|d\.cts)$/.test(file) && statSync(file).isFile()) rmSync(file);
    }

    writeNpmShims(join(seedDir, "bin"));

    const seedVersion = createHash("sha256")
      .update(JSON.stringify({ distro, packages }))
      .digest("hex")
      .slice(0, 16);
    writeFileSync(
      join(seedDir, "manifest.json"),
      `${JSON.stringify({ distro: distro.id, revision: distro.revision, seedVersion, packages }, null, 2)}\n`,
    );

    // NSIS cannot package paths over MAX_PATH. Budget for a long per-user
    // install root: C:\Users\<20 chars>\AppData\Local\<product>\resources\pi-seed\
    const installPrefix = 90;
    const overlong = [];
    let files = 0;
    let bytes = 0;
    for (const file of walk(seedDir)) {
      const rel = relative(seedDir, file);
      if (installPrefix + rel.length > 259) overlong.push(rel.split(sep).join("/"));
      const stats = statSync(file);
      if (stats.isFile()) { files++; bytes += stats.size; }
    }
    console.log(`pi-seed: ${packages.length} packages, ${files} files, ${(bytes / 1048576).toFixed(1)} MiB (seed ${seedVersion})`);
    for (const pkg of packages) console.log(`  ${pkg.source} ${pkg.version} -> ${pkg.path}`);
    if (overlong.length > 0) {
      throw new Error(`pi-seed paths too long for Windows installs:\n${overlong.slice(0, 20).join("\n")}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
