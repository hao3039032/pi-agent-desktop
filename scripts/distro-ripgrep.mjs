#!/usr/bin/env node
/**
 * Stage the target macOS ripgrep binary for the distro build.
 *
 * pi's grep tool shells out to `rg`. A GUI-launched desktop app cannot rely
 * on Homebrew's PATH, so the binary is shipped beside the other distro
 * resources and its directory is prepended by lib/distro/runtime-env.ts.
 *
 *   node scripts/distro-ripgrep.mjs --target aarch64-apple-darwin
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopTargetTriple, readMachOCpuTypes, requiredMachOCpuType } from "./desktop-platform.mjs";
import { readArchive } from "./pi-cli-release.mjs";

export const RIPGREP_VERSION = "15.2.0";
export const RIPGREP_RELEASE_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}`;

const ARTIFACTS = new Map([
  ["aarch64-apple-darwin", {
    asset: `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
  }],
  ["x86_64-apple-darwin", {
    asset: `ripgrep-${RIPGREP_VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
  }],
]);

export const RIPGREP_TARGETS = [...ARTIFACTS.keys()];

export function ripgrepArtifactFor(triple) {
  const artifact = typeof triple === "string" ? ARTIFACTS.get(triple) : undefined;
  if (!artifact) {
    throw new Error(
      `no ripgrep release artifact for target triple ${JSON.stringify(triple)}; `
        + `supported: ${RIPGREP_TARGETS.join(", ")}`,
    );
  }
  return { triple, ...artifact };
}

async function fetchChecked(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Download, verify and stage the one executable Plan mode needs. */
export async function stageRipgrepForTarget({
  triple,
  destDir,
  fetchImpl = fetch,
  base = RIPGREP_RELEASE_BASE,
}) {
  const artifact = ripgrepArtifactFor(triple);
  const archiveUrl = `${base}/${artifact.asset}`;
  const archive = await fetchChecked(archiveUrl, fetchImpl);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== artifact.sha256) {
    throw new Error(
      `${artifact.asset}: SHA-256 ${actual} does not match the pinned ${artifact.sha256} (${archiveUrl})`,
    );
  }

  const prefix = artifact.asset.slice(0, -".tar.gz".length);
  const entries = readArchive(archive, "tar.gz");
  const files = ["rg", "COPYING", "LICENSE-MIT", "UNLICENSE"].map((name) => {
    const entry = entries.find((candidate) => candidate.path === `${prefix}/${name}`);
    if (!entry) throw new Error(`${artifact.asset} has no ${prefix}/${name} entry`);
    return { name, data: entry.data };
  });

  const destination = resolve(destDir);
  mkdirSync(destination, { recursive: true });
  for (const file of files) writeFileSync(join(destination, file.name), file.data);
  const binaryPath = join(destination, "rg");
  chmodSync(binaryPath, 0o755);
  if (!readMachOCpuTypes(binaryPath)?.includes(requiredMachOCpuType(triple))) {
    throw new Error(`ripgrep Mach-O architecture does not match ${triple}`);
  }
  return { ...artifact, binaryPath, sha256: actual };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    if (flag === "--target") { options.target = value; index += 1; }
    else if (flag === "--dest") { options.dest = value; index += 1; }
    else if (flag === "--base") { options.base = value; index += 1; }
    else throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = options.target ?? process.env.PI_DESKTOP_TARGET_TRIPLE ?? desktopTargetTriple();
  if (!target.endsWith("-apple-darwin")) {
    throw new Error(`distro ripgrep is only staged for macOS targets, got ${target}`);
  }
  const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const destination = options.dest ?? join(rootDir, "src-tauri", "resources", "ripgrep");
  const staging = mkdtempSync(join(tmpdir(), "distro-ripgrep-"));
  try {
    const staged = await stageRipgrepForTarget({
      triple: target,
      destDir: staging,
      ...(options.base ? { base: options.base } : {}),
    });
    mkdirSync(destination, { recursive: true });
    for (const name of ["rg", "COPYING", "LICENSE-MIT", "UNLICENSE"]) {
      writeFileSync(join(destination, name), readFileSync(join(staging, name)));
    }
    chmodSync(join(destination, "rg"), 0o755);
    console.log(`ripgrep ${RIPGREP_VERSION} ${target} sha256 ${staged.sha256} staged at ${destination}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
