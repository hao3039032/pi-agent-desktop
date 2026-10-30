import { access, chmod, copyFile, cp, mkdir, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopTargetTriple, readMachOCpuTypes, requiredMachOCpuType } from "./desktop-platform.mjs";
import { piExecutableName, stagePiDistribution, stagePiExecutableOnly } from "./pi-cli-distribution.mjs";
import { piPackageDirNames } from "./pi-packages.mjs";
import { dedupeNestedPackages, externalPackageSpecifiers, findNestedPiScopePackages, stageCompletePackage, stageResolvedClosure } from "./stage-package.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopBuildDir = join(rootDir, ".next-desktop");
const standaloneDir = join(desktopBuildDir, "standalone");
const serverResourcesDir = join(rootDir, "src-tauri", "resources", "server");
const serverHelperDir = join(rootDir, "src-tauri", "resources", "Pi Agent Server.app");
const nodeResourcesDir = join(rootDir, "src-tauri", "resources", "node");

// Cross-arch builds (x86_64 macOS from an Apple Silicon runner) must not bundle
// the host's Node, so the workflow tells this script what it is building and
// where the matching Node binary lives. Without the override the host's
// process.execPath is copied — correct whenever host arch == target arch.
const KNOWN_DESKTOP_TRIPLES = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
]);

const targetTriple = process.env.PI_DESKTOP_TARGET_TRIPLE ?? desktopTargetTriple();
if (!KNOWN_DESKTOP_TRIPLES.has(targetTriple)) {
  throw new Error(
    `Unknown PI_DESKTOP_TARGET_TRIPLE ${JSON.stringify(process.env.PI_DESKTOP_TARGET_TRIPLE)} — expected one of:\n  ${[...KNOWN_DESKTOP_TRIPLES].join("\n  ")}`,
  );
}

async function runNextBuild() {
  const require = createRequire(import.meta.url);
  const nextBin = require.resolve("next/dist/bin/next", { paths: [rootDir] });

  await rm(desktopBuildDir, { recursive: true, force: true });

  // The packaged server leaks its runtime config into spawned process trees
  // via __NEXT_PRIVATE_STANDALONE_CONFIG; JSON drops function values, so an
  // inherited build dies on `generateBuildId`. Always load config fresh.
  const buildEnv = { ...process.env };
  delete buildEnv.__NEXT_PRIVATE_STANDALONE_CONFIG;
  delete buildEnv.__NEXT_PRIVATE_ORIGIN;

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [nextBin, "build", "--webpack"], {
      cwd: rootDir,
      env: {
        ...buildEnv,
        NEXT_TELEMETRY_DISABLED: "1",
        PI_WEB_DESKTOP_BUILD: "1",
      },
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Next.js desktop build failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

async function assembleServer() {
  await access(join(standaloneDir, "server.js"), constants.R_OK);
  await rm(serverResourcesDir, { recursive: true, force: true });
  await mkdir(dirname(serverResourcesDir), { recursive: true });
  await cp(standaloneDir, serverResourcesDir, { recursive: true });
  // Ship immutable prerender seeds only; route-cache is regenerated at runtime
  // and can otherwise preserve HTML/RSC pointing at a previous build's chunks.
  await rm(join(serverResourcesDir, ".next-desktop", "server", "route-cache"), { recursive: true, force: true });

  // Next's file tracer follows normal imports but intentionally omits files
  // reached through dynamic provider/export/plugin paths. These packages are
  // serverExternalPackages, so preserve their complete runtime `dist/` trees.
  // package.json rides along so dedupeNestedPackages() can read the top-level
  // version: without it a nested duplicate survives dedupe and ships (the
  // 0.4.7 installer shipped exactly that, #72).
  const directPiPackages = await piPackageDirNames();
  for (const packageName of directPiPackages) {
    const packageSource = join(rootDir, "node_modules", "@earendil-works", packageName);
    const packageDestination = join(
      serverResourcesDir,
      "node_modules",
      "@earendil-works",
      packageName,
    );
    await cp(join(packageSource, "dist"), join(packageDestination, "dist"), {
      recursive: true,
      force: true,
    });
    await copyFile(join(packageSource, "package.json"), join(packageDestination, "package.json"));
  }

  // pi-subagents' detached runner resolves its host peer aliases from the
  // bundled SDK tree (PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT in
  // src-tauri/src/lib.rs): every export subpath of the scope's packages,
  // including ones no app code imports (`pi-agent-core/node`) and transitive
  // scope packages (`chord`, `pi-telemetry`). Next's tracer ships only
  // fragments of those — a nested chord holding nothing but `dist/context/`
  // — which fails the runner's completeness probe with "does not provide
  // @earendil-works/pi-agent-core/node, @earendil-works/chord". Mirror the
  // complete `dist/` of the remaining top-level scope packages and of the
  // copies npm nested under every scope package, so every subpath resolves.
  const scopeSource = join(rootDir, "node_modules", "@earendil-works");
  const scopeDestination = join(serverResourcesDir, "node_modules", "@earendil-works");
  for (const entry of await readdir(scopeSource, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageSource = join(scopeSource, entry.name);
    const packageDestination = join(scopeDestination, entry.name);

    if (!directPiPackages.includes(entry.name)) {
      await cp(join(packageSource, "dist"), join(packageDestination, "dist"), { recursive: true, force: true });
      // The tracer may not have staged this package at all; without the
      // manifest its `exports` map cannot resolve the alias targets.
      await copyFile(join(packageSource, "package.json"), join(packageDestination, "package.json"));
    }

    const nestedSource = join(packageSource, "node_modules", "@earendil-works");
    const nestedEntries = await readdir(nestedSource, { withFileTypes: true }).catch(() => []);
    for (const nested of nestedEntries) {
      if (!nested.isDirectory()) continue;
      const nestedSourcePackage = join(nestedSource, nested.name);
      const nestedDestinationPackage = join(
        packageDestination,
        "node_modules",
        "@earendil-works",
        nested.name,
      );
      await cp(join(nestedSourcePackage, "dist"), join(nestedDestinationPackage, "dist"), { recursive: true, force: true });
      await copyFile(
        join(nestedSourcePackage, "package.json"),
        join(nestedDestinationPackage, "package.json"),
      );
    }
  }

  // node-pty loads its native binding through a runtime-computed path
  // (`prebuilds/${platform}-${arch}/*.node`), which Next's file tracer cannot
  // follow — the standalone output ships only lib/ and package.json. Copy the
  // full prebuilds tree (one signed build serves every platform it supports)
  // and restore the executable bit macOS strips from spawn-helper.
  const ptySource = join(rootDir, "node_modules", "node-pty");
  const ptyDestination = join(serverResourcesDir, "node_modules", "node-pty");
  // Windows starts its output worker and console-list helper by computed path.
  // The tracer omits both; copying native prebuilds alone still exits with -1.
  await cp(join(ptySource, "lib"), join(ptyDestination, "lib"), { recursive: true, force: true });
  const ptyPrebuildsSource = join(ptySource, "prebuilds");
  let ptyPrebuildsPresent = false;
  try {
    await access(ptyPrebuildsSource, constants.R_OK);
    ptyPrebuildsPresent = true;
  } catch {
    // node-pty without prebuilds (source build) — nothing to copy.
  }
  if (ptyPrebuildsPresent) {
    await cp(ptyPrebuildsSource, join(ptyDestination, "prebuilds"), { recursive: true, force: true });
    // macOS strips the executable bit from spawn-helper in every published
    // prebuild (fix once upstream preserves it). Fix all darwin variants so a
    // staged build works on either host architecture.
    for (const variant of ["darwin-arm64", "darwin-x64"]) {
      try {
        await chmod(join(ptyDestination, "prebuilds", variant, "spawn-helper"), 0o755);
      } catch {
        // variant not present in this checkout — nothing to fix.
      }
    }
  }

  // Next's file tracer drops files that a package loads through runtime
  // `require` / `import.meta.resolve`, so jiti arrives incomplete: only
  // lib/jiti-static.mjs survives, while the pi-coding-agent bundle reaches
  // lib/jiti.cjs through a lazy require("jiti"). Ship the complete source
  // package over every staged copy of it. (quickjs-wasi used to need the
  // same treatment for the in-process engine's Code mode sandbox; since the
  // CLI-engine migration the sandbox runs inside the bundled pi distribution
  // and nothing in the staged server loads it, so it is no longer staged.
  // Keep jiti: the SDK's lazy require path is broad, and the cost is one
  // small package.) See stage-package.mjs before assuming a path; the dedupe
  // pass below deletes nested copies that match the top level.
  const stagedNodeModulesDir = join(serverResourcesDir, "node_modules");
  await stageCompletePackage({
    name: "jiti",
    sources: [join(rootDir, "node_modules", "jiti")],
    stagedNodeModulesDir,
  });

  // sharp (pulled in by Next's production image optimizer) ships glibc and
  // musl builds of its native libvips on Linux. The AppImage bundler's
  // linuxdeploy walks every ELF under the resources and resolves its
  // dependencies; the musl builds need `libc.musl-x86_64.so.1`, which no
  // glibc system provides, so bundling dies with "Could not find dependency:
  // libc.musl-x86_64.so.1" — the error tauri reports as an opaque "failed to
  // run linuxdeploy". The packaged server always runs on the bundled glibc
  // Node, so the musl variant is dead weight in every bundle; drop it here.
  if (targetTriple.endsWith("-unknown-linux-gnu")) {
    const imgDir = join(serverResourcesDir, "node_modules", "@img");
    const imgEntries = await readdir(imgDir, { withFileTypes: true }).catch(() => []);
    for (const entry of imgEntries) {
      if (entry.isDirectory() && entry.name.includes("linuxmusl")) {
        await rm(join(imgDir, entry.name), { recursive: true, force: true });
      }
    }
  }

  // pi-ai loads Amazon Bedrock through a variable specifier
  // (`import(runtimeSpecifier)` in bedrock-converse-stream.lazy.js) so bundlers
  // cannot follow it into the Node-only AWS SDK. Next's file tracer is one of
  // those bundlers: the standalone server gets pi-ai's dist, but not
  // @aws-sdk/client-bedrock-runtime, and a packaged session on amazon-bedrock
  // dies with ERR_MODULE_NOT_FOUND at the first stream. Copy the closure Node
  // actually resolves from that entry. Nested copies have to stay nested —
  // pi-ai's https-proxy-agent is 9.1.0 because the hoisted one is 7.0.6.
  const bedrockEntry = join(
    rootDir,
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "api",
    "bedrock-converse-stream.js",
  );
  await stageResolvedClosure({
    importer: bedrockEntry,
    specifiers: await externalPackageSpecifiers(bedrockEntry, [
      "@aws-sdk/client-bedrock-runtime",
      "@smithy/node-http-handler",
      "http-proxy-agent",
      "https-proxy-agent",
    ]),
    sourceRoot: rootDir,
    stagedNodeModulesDir,
  });

  await copyFile(
    join(rootDir, "desktop", "server-launcher.cjs"),
    join(serverResourcesDir, "desktop-server.cjs"),
  );

  // The server reads `updateMirrors` from this file at runtime (see
  // lib/update-mirrors-server.ts). Staging it next to the launcher — the
  // server's cwd — keeps `distro/distro.json` the single source for both the
  // settings check and the installer built into the shell.
  await copyFile(join(rootDir, "distro", "distro.json"), join(serverResourcesDir, "distro.json"));

  // The child extension assets (bridge, chat policy, artifacts guide) are
  // resolved at RUNTIME by resolveAssetPath() through process.cwd() and a
  // dynamic file name, which Next's file tracer cannot follow into the
  // standalone server. Stage the whole assets dir explicitly — every
  // session spawns its child with --extension <these files>, so a missing
  // one fails the session start, not just a feature.
  const extensionAssetsSource = join(rootDir, "lib", "pi-rpc", "assets");
  const extensionAssetsDestination = join(serverResourcesDir, "lib", "pi-rpc", "assets");
  const extensionAssets = await readdir(extensionAssetsSource);
  await mkdir(extensionAssetsDestination, { recursive: true });
  for (const asset of extensionAssets) {
    if (!asset.endsWith(".mjs")) continue;
    await copyFile(join(extensionAssetsSource, asset), join(extensionAssetsDestination, asset));
  }

  const staticSource = join(desktopBuildDir, "static");
  const staticDestination = join(serverResourcesDir, ".next-desktop", "static");
  await mkdir(dirname(staticDestination), { recursive: true });
  await cp(staticSource, staticDestination, { recursive: true });

  const publicDir = join(rootDir, "public");
  try {
    await access(publicDir, constants.R_OK);
    await cp(publicDir, join(serverResourcesDir, "public"), { recursive: true });
  } catch {
    // `public/` is optional in Next.js projects.
  }
}

/** Paths that would exceed Windows' MAX_PATH once staged on a runner. */
async function findOverlongPaths() {
  // Mirrors the checkout location on a windows-latest runner. Measured even on
  // macOS so a long path fails the build here instead of inside makensis.
  const windowsPrefix = "D:\\a\\pi-agent-desktop\\pi-agent-desktop\\src-tauri\\resources\\server";
  const overlong = [];

  async function walk(dir, relative) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}\\${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), childRelative);
        continue;
      }
      const full = `${windowsPrefix}\\${childRelative}`;
      if (full.length > 260) overlong.push({ length: full.length, path: childRelative });
    }
  }

  await walk(serverResourcesDir, "");
  return overlong;
}

async function findNpmSource() {
  const npmFromCurrentRun = process.env.npm_execpath
    ? dirname(dirname(process.env.npm_execpath))
    : null;
  const candidates = [
    npmFromCurrentRun,
    join(dirname(process.execPath), "node_modules", "npm"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(join(candidate, "bin", "npx-cli.js"), constants.R_OK);
      return candidate;
    } catch {
      // Try the next Node installation layout.
    }
  }

  throw new Error("Could not locate npm next to the bundled Node.js runtime.");
}

async function bundleNodeRuntime() {
  const triple = targetTriple;
  const sourceNodePath = process.env.PI_DESKTOP_NODE_BINARY ?? process.execPath;
  await access(sourceNodePath, constants.R_OK);
  await rm(serverHelperDir, { recursive: true, force: true });
  await rm(nodeResourcesDir, { recursive: true, force: true });

  let binaryPath;
  if (process.platform === "darwin") {
    // Wrap Node in an LSBackgroundOnly .app so it does not appear in the Dock.
    // Info.plist uses the parent CFBundleIdentifier (com.abcwyc.pi-agent) so
    // macOS TCC SystemPolicyAppData grants persist across launches — a distinct
    // helper id re-prompts "access data from other apps" every cold start.
    const contentsDir = join(serverHelperDir, "Contents");
    binaryPath = join(contentsDir, "MacOS", "node");
    await mkdir(dirname(binaryPath), { recursive: true });
    await copyFile(sourceNodePath, binaryPath);
    await chmod(binaryPath, 0o755);
    await copyFile(
      join(rootDir, "desktop", "server-helper-Info.plist"),
      join(contentsDir, "Info.plist"),
    );
    // Fork: ship npm on macOS as well, so pi can install/update packages
    // without a system Node.js (lib/distro/runtime-env.ts puts it on PATH).
    await cp(
      await findNpmSource(),
      join(nodeResourcesDir, "node_modules", "npm"),
      { recursive: true },
    );
  } else {
    const executableName = process.platform === "win32" ? "node.exe" : "node";
    binaryPath = join(nodeResourcesDir, executableName);
    await mkdir(nodeResourcesDir, { recursive: true });
    await copyFile(sourceNodePath, binaryPath);
    await chmod(binaryPath, 0o755);
    await cp(
      await findNpmSource(),
      join(nodeResourcesDir, "node_modules", "npm"),
      { recursive: true },
    );
  }

  // Wrong-arch staging is silent at build time and fatal on the target
  // machine ("Bad CPU type in executable" when the shell spawns the server),
  // so gate it here: the bundled Mach-O must contain the target's cpu type.
  if (triple.endsWith("-apple-darwin")) {
    const cpuTypes = readMachOCpuTypes(binaryPath);
    if (cpuTypes === null) {
      throw new Error(
        `Bundled Node at ${relative(rootDir, binaryPath)} is not a Mach-O binary; expected a darwin Node build for ${triple}.`,
      );
    }
    const required = requiredMachOCpuType(triple);
    if (!cpuTypes.includes(required)) {
      throw new Error(
        `Bundled Node at ${relative(rootDir, binaryPath)} carries no ${triple} code ` +
          `(cpu types: ${cpuTypes.map((type) => `0x${type.toString(16).padStart(8, "0")}`).join(", ")}). ` +
          "When cross-building, download a Node runtime for the target architecture and point " +
          "PI_DESKTOP_NODE_BINARY at it (with PI_DESKTOP_TARGET_TRIPLE set to match).",
      );
    }
  }

  return { binaryPath, triple };
}

await runNextBuild();
await assembleServer();

const deduped = await dedupeNestedPackages(serverResourcesDir);
if (deduped > 0) console.log(`Removed ${deduped} redundant nested package cop${deduped === 1 ? "y" : "ies"}`);

// #72 build gate: the app pins the whole @earendil-works scope to one version
// line, so the staged tree must never contain a pi package nested under
// another pi package. If one survives dedupe, shipping it breaks every
// Windows user on the next overwrite install (Node's nearest-module
// resolution loads the stale copy after the upgrade leaves it in place).
const nestedPiScope = await findNestedPiScopePackages(join(serverResourcesDir, "node_modules"));
if (nestedPiScope.length > 0) {
  console.error(
    `Staged node_modules contains @earendil-works packages nested under other @earendil-works packages:\n` +
      nestedPiScope.map((dir) => `  ${relative(rootDir, dir)}`).join("\n"),
  );
  throw new Error(
    "Refusing to package: a nested @earendil-works copy would shadow the top-level one after overwrite installs (#72).",
  );
}

// Fail here rather than inside makensis, which reports a bare "failed opening
// file" and takes an entire signed release build down with it.
const overlong = await findOverlongPaths();
if (overlong.length > 0) {
  console.error(
    `${overlong.length} staged path(s) exceed Windows' 260-character limit:\n` +
      overlong.map(({ length, path }) => `  ${length}  ${path}`).join("\n"),
  );
  throw new Error("Staged paths would break the Windows installer.");
}

const { binaryPath: nodeBinary, triple } = await bundleNodeRuntime();

// The CLI engine (lib/pi-rpc) spawns `pi` children; ship the whole pi
// distribution beside the server so the desktop works without a PATH install.
// PI_CLI_DISTRIBUTION_DIR is the directory the release download step extracted
// (the archive's own layout, binary included); resources next to the binary —
// photon_rs_bg.wasm, theme/ — are part of the package, not optional extras.
// PI_CLI_SOURCE alone (a bare executable) is still supported and is recorded
// as an incomplete staging so the release gate can tell the two apart.
const piDistributionDir = process.env.PI_CLI_DISTRIBUTION_DIR;
const piSource = process.env.PI_CLI_SOURCE ?? process.env.PI_CLI_BIN;
const piResourcesDir = join(rootDir, "src-tauri", "resources", "pi");
// The target platform is chosen by the BUILD TARGET, not the host: the Intel
// macOS build runs on an Apple Silicon runner, and a cross build must still
// stage `pi` (never `pi.exe`) with executable permission.
const piTargetPlatform = triple.includes("-pc-windows")
  ? "win32"
  : triple.includes("-apple-darwin")
    ? "darwin"
    : "linux";
if (piDistributionDir) {
  await access(piDistributionDir, constants.R_OK);
  const manifest = stagePiDistribution({
    sourceDir: piDistributionDir,
    destDir: piResourcesDir,
    binaryName: piExecutableName(piTargetPlatform),
    platform: piTargetPlatform,
  });
  console.log(`pi CLI staged at ${relative(rootDir, join(piResourcesDir, manifest.binary))} (${manifest.files.length} files from the distribution)`);
} else if (piSource) {
  if (process.env.PI_DESKTOP_REQUIRE_PI === "1") {
    // Release context: the archives ship wasm + theme next to the binary; a
    // bare executable there is a half distribution, and the release gate
    // (complete: true in the manifest) must never pass with one.
    throw new Error(
      "PI_DESKTOP_REQUIRE_PI=1 requires PI_CLI_DISTRIBUTION_DIR (the archive's own directory); " +
        `PI_CLI_SOURCE alone (${piSource}) would package an incomplete distribution.`,
    );
  }
  await access(piSource, constants.R_OK);
  stagePiExecutableOnly({ sourcePath: piSource, destDir: piResourcesDir, platform: piTargetPlatform });
  console.log(`pi CLI staged at ${relative(rootDir, join(piResourcesDir, basename(piSource)))} (executable only: no PI_CLI_DISTRIBUTION_DIR)`);
} else if (process.env.PI_DESKTOP_REQUIRE_PI === "1") {
  // Release context: every session runs on the pi CLI child since the route
  // flip, so a desktop without the binary is fully broken, not degraded.
  throw new Error(
    "PI_DESKTOP_REQUIRE_PI=1 but neither PI_CLI_SOURCE nor PI_CLI_BIN is set: " +
      "the packaged desktop would have no pi CLI to run sessions on.",
  );
} else {
  console.log("No PI_CLI_DISTRIBUTION_DIR/PI_CLI_SOURCE/PI_CLI_BIN set: the desktop will resolve pi from PATH.");
}

console.log(`Desktop server staged at ${serverResourcesDir}`);
console.log(`Node runtime staged at ${nodeBinary} (${triple})`);
