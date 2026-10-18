#!/usr/bin/env node
/**
 * Fork: stage Git for Windows (PortableGit) into src-tauri/resources/git so the
 * Windows app ships a working Git Bash — pi's bash tool requires one, and
 * git: packages need git. Windows release runner only; needs 7-Zip (`7z`) on
 * PATH, which GitHub's windows images provide.
 *
 * `post-install.bat` is kept: lib/distro/runtime-env.ts runs it once on the
 * user's machine, exactly as the PortableGit self-extractor would.
 *
 *   node scripts/distro-portable-git.mjs
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Bump together: https://github.com/git-for-windows/git/releases
const VERSION = "2.55.0.windows.5";
const ASSET = "PortableGit-2.55.0.5-64-bit.7z.exe";
const SHA256 = "5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const gitDir = join(rootDir, "src-tauri", "resources", "git");

// Documentation, man/info pages and translations are never used by pi.
const PRUNE = [
  "mingw64/share/doc",
  "mingw64/share/man",
  "mingw64/share/info",
  "mingw64/share/locale",
  "usr/share/doc",
  "usr/share/man",
  "usr/share/info",
  "usr/share/locale",
];

async function main() {
  const url = `https://github.com/git-for-windows/git/releases/download/v${VERSION}/${ASSET}`;
  const archive = join(tmpdir(), ASSET);
  if (!existsSync(archive)) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  const { readFileSync } = await import("node:fs");
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (digest !== SHA256) throw new Error(`Checksum mismatch for ${ASSET}: ${digest}`);

  rmSync(gitDir, { recursive: true, force: true });
  mkdirSync(gitDir, { recursive: true });
  const result = spawnSync("7z", ["x", `-o${gitDir}`, "-y", archive], { stdio: ["ignore", "ignore", "inherit"] });
  if (result.status !== 0) throw new Error(`7z failed (${result.error?.message ?? `exit ${result.status}`})`);

  for (const rel of PRUNE) rmSync(join(gitDir, ...rel.split("/")), { recursive: true, force: true });
  if (!existsSync(join(gitDir, "bin", "bash.exe"))) throw new Error("PortableGit layout changed: bin/bash.exe missing");
  console.log(`PortableGit ${VERSION} staged at ${gitDir}`);
}

await main();
