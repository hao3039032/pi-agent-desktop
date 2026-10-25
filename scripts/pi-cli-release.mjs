/**
 * Stage the pi CLI the packaged desktop runs its sessions on, for one build
 * target (docs/distro.md, `.github/workflows/distro-release.yml`).
 *
 * The upstream release publishes one archive per Rust target triple, and the
 * ARCHIVE'S LAYOUT DIFFERS: the darwin/linux tarballs wrap everything in a
 * top-level `pi/` directory (`pi/pi`), while the Windows zips are flat
 * (`pi.exe`). Both have to land next to the server as `pi` / `pi.exe`, which
 * is what `resolvePiExecutable()` looks for, so the mapping and the layout
 * live here instead of a shell `case` on the runner platform (an Intel macOS
 * build runs on an ARM runner, and platform alone cannot tell the two apart).
 *
 * Downloads are verified against the release's own SHA256SUMS before anything
 * is extracted: a renamed, truncated or swapped asset fails here with the
 * asset name and the expected hash, not later inside `npm run desktop:prepare`.
 *
 * Usage:
 *   node scripts/pi-cli-release.mjs --target aarch64-apple-darwin --download-dir <dir> [--github-env <file>] [--base <url>]
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync, gunzipSync } from "node:zlib";

/** Where the release's stable, tag-less download URLs point. */
export const PI_CLI_RELEASE_BASE = "https://github.com/earendil-works/pi/releases/latest/download";

/**
 * One archive per supported Rust target triple. `entry` is the binary's path
 * inside the archive, `stageName` the file name it must keep beside the
 * server (the name `resolvePiExecutable()` probes for).
 */
const ARTIFACTS = new Map([
  ["x86_64-pc-windows-msvc", { asset: "pi-windows-x64.zip", kind: "zip", entry: "pi.exe", stageName: "pi.exe" }],
  ["aarch64-pc-windows-msvc", { asset: "pi-windows-arm64.zip", kind: "zip", entry: "pi.exe", stageName: "pi.exe" }],
  ["aarch64-apple-darwin", { asset: "pi-darwin-arm64.tar.gz", kind: "tar.gz", entry: "pi/pi", stageName: "pi" }],
  ["x86_64-apple-darwin", { asset: "pi-darwin-x64.tar.gz", kind: "tar.gz", entry: "pi/pi", stageName: "pi" }],
  ["x86_64-unknown-linux-gnu", { asset: "pi-linux-x64.tar.gz", kind: "tar.gz", entry: "pi/pi", stageName: "pi" }],
  ["aarch64-unknown-linux-gnu", { asset: "pi-linux-arm64.tar.gz", kind: "tar.gz", entry: "pi/pi", stageName: "pi" }],
]);

export const PI_CLI_TARGETS = [...ARTIFACTS.keys()];

/** The release artifact for a Rust target triple. */
export function piCliArtifactFor(triple) {
  // A Map, not an object literal: "constructor", "__proto__" or "toString"
  // must be unsupported triples, never inherited properties that look like one.
  const artifact = typeof triple === "string" ? ARTIFACTS.get(triple) : undefined;
  if (!artifact) {
    throw new Error(
      `no pi CLI release artifact for target triple ${JSON.stringify(triple)}; `
        + `supported: ${PI_CLI_TARGETS.join(", ")}`,
    );
  }
  return artifact;
}

/** `name  sha256` lines of a release's SHA256SUMS file. */
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of String(text).split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** The expected hash of one asset; a missing entry means upstream renamed it. */
export function expectedArchiveSha256(sumsText, asset) {
  const expected = parseSha256Sums(sumsText).get(asset);
  if (!expected) {
    throw new Error(
      `the release's SHA256SUMS lists no ${asset}; refusing to use an unverified archive `
        + `(published assets: ${[...parseSha256Sums(sumsText).keys()].join(", ")})`,
    );
  }
  return expected;
}

function assertSafeEntryPath(entryPath) {
  if (!entryPath || entryPath.startsWith("/") || /^[a-zA-Z]:/.test(entryPath) || entryPath.split("/").includes("..")) {
    throw new Error(`archive entry escapes the extraction directory: ${JSON.stringify(entryPath)}`);
  }
}

/** Read a ustar archive (already gunzipped). */
function readTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "").trim();
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = Number.parseInt(field(124, 12) || "0", 8);
    const mode = Number.parseInt(field(100, 8) || "0", 8);
    const type = field(156, 1) || "0";
    if (!Number.isFinite(size) || size < 0) throw new Error(`tar entry ${name} has an invalid size`);
    // PAX ('x'/'g') and GNU long-name ('L'/'K') records carry the real path in
    // their data; ignoring them would silently drop or mis-name files, so the
    // archive is refused instead. The published pi archives use plain ustar.
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      throw new Error(`tar entry ${name} uses a PAX/GNU extension this extractor does not support`);
    }
    // Hardlinks ('1'), symlinks ('2'), devices ('3'/'4'), fifos ('6') and
    // anything else unrecognized must not be skipped: a silently dropped
    // hardlinked theme file would package incomplete resources that still
    // verify against the manifest (it lists what was staged, not what the
    // archive meant to ship).
    if (type !== "0" && type !== "" && type !== "5") {
      throw new Error(`tar entry ${JSON.stringify(entryPathRaw(prefix, name))} has unsupported type ${JSON.stringify(type)}; refusing to stage an incomplete distribution`);
    }
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    // A header that claims more bytes than the archive holds is a truncated or
    // corrupt archive; the release checksum does not prove its structure.
    if (dataStart + size > buffer.length) {
      throw new Error(`tar entry ${entryPath} is truncated: it claims ${size} bytes past the archive end`);
    }
    if (type === "0" || type === "") {
      assertSafeEntryPath(entryPath);
      entries.push({ path: entryPath, data: buffer.subarray(dataStart, dataStart + size), mode });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** The entry's display path for diagnostics (ustar prefix + name). */
function entryPathRaw(prefix, name) {
  return prefix ? `${prefix}/${name}` : name;
}

/** Read a zip archive (stored and deflate entries). */
function readZip(buffer) {
  // End of central directory: the last 22 bytes plus an optional comment.
  let eocd = -1;
  for (let cursor = buffer.length - 22; cursor >= 0 && cursor >= buffer.length - 22 - 0xffff; cursor -= 1) {
    if (buffer.readUInt32LE(cursor) === 0x06054b50) {
      eocd = cursor;
      break;
    }
  }
  if (eocd < 0) throw new Error("archive is not a zip file (no end-of-central-directory record)");
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryPath = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (entryPath.endsWith("/")) continue;
    assertSafeEntryPath(entryPath);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`corrupt zip entry ${entryPath}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    // The whole archive's SHA-256 was verified before extraction, so a per-
    // entry CRC check would only re-test bytes that already match.
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip entry ${entryPath} uses unsupported compression method ${method}`);
    if (data.length !== uncompressedSize) throw new Error(`zip entry ${entryPath} is truncated`);
    // Unix mode lives in the high 16 bits of the external attributes.
    entries.push({ path: entryPath, data, mode: (externalAttributes >>> 16) & 0o777 });
  }
  return entries;
}

/** All files of an archive, in memory. */
export function readArchive(archive, kind) {
  if (kind === "tar.gz") return readTar(gunzipSync(archive));
  if (kind === "zip") return readZip(archive);
  throw new Error(`unsupported pi CLI archive kind: ${JSON.stringify(kind)}`);
}

/**
 * Extract an archive to `destDir` and return the staged binary's absolute
 * path. The binary keeps the name `resolvePiExecutable()` looks for, and on
 * Unix it is executable (a tarball's mode bits, or the zip's, may say 0644).
 */
export function extractPiCliArchive({ archive, kind, entry, stageName, destDir }) {
  const entries = readArchive(archive, kind);
  const root = resolve(destDir);
  let binaryPath;
  for (const file of entries) {
    const target = resolve(root, file.path);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`archive entry escapes the extraction directory: ${file.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.data);
    chmodSync(target, file.mode ? file.mode & 0o777 : 0o644);
    if (file.path === entry) binaryPath = target;
  }
  if (!binaryPath) {
    throw new Error(
      `the archive has no ${entry} (entries: ${entries.slice(0, 10).map((file) => file.path).join(", ")}`
        + `${entries.length > 10 ? ", …" : ""})`,
    );
  }
  if (!statSync(binaryPath).isFile()) throw new Error(`${entry} in the archive is not a regular file`);
  if (stageName && binaryPath.slice(binaryPath.lastIndexOf(sep) + 1) !== stageName) {
    throw new Error(
      `the archive's binary is ${JSON.stringify(entry)}, which cannot stay named `
        + `${JSON.stringify(stageName)} (resolvePiExecutable() probes that name)`,
    );
  }
  if (process.platform !== "win32") chmodSync(binaryPath, 0o755);
  return binaryPath;
}

async function fetchChecked(url, fetchImpl) {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Download, verify and extract the pi CLI for a triple into `destDir`.
 * Returns the staged binary path and the verified hash.
 */
export async function stagePiCliForTarget({
  triple,
  destDir,
  fetchImpl = fetch,
  base = PI_CLI_RELEASE_BASE,
}) {
  const artifact = piCliArtifactFor(triple);
  const sumsUrl = `${base}/SHA256SUMS`;
  const expected = expectedArchiveSha256(await fetchChecked(sumsUrl, fetchImpl).then(String), artifact.asset);
  const archiveUrl = `${base}/${artifact.asset}`;
  const archive = await fetchChecked(archiveUrl, fetchImpl);
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `${artifact.asset}: SHA-256 ${actual} does not match the release's ${expected} (${archiveUrl})`,
    );
  }
  mkdirSync(destDir, { recursive: true });
  const binaryPath = extractPiCliArchive({ archive, ...artifact, destDir });
  return { binaryPath, sha256: actual, asset: artifact.asset, distributionDir: dirname(resolve(binaryPath)) };
}

/**
 * The env-file lines the workflow consumes. Both values are staged paths
 * inside the runner's temp dir; a newline in one would let the archive lay
 * out its own entries and inject a third assignment, so they are refused.
 */
export function githubEnvAssignments({ binaryPath, distributionDir }) {
  for (const [name, value] of [["PI_CLI_SOURCE", binaryPath], ["PI_CLI_DISTRIBUTION_DIR", distributionDir]]) {
    if (!value || /[\r\n]/.test(value)) throw new Error(`${name} cannot be written to the env file: ${JSON.stringify(value)}`);
  }
  return `PI_CLI_SOURCE=${binaryPath}\nPI_CLI_DISTRIBUTION_DIR=${distributionDir}\n`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--target") { options.target = value; index += 1; }
    else if (flag === "--download-dir") { options.downloadDir = value; index += 1; }
    else if (flag === "--github-env") { options.githubEnv = value; index += 1; }
    else if (flag === "--base") { options.base = value; index += 1; }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!options.target) throw new Error("--target <rust-triple> is required");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // A fresh staging dir per run: a leftover binary from an earlier target must
  // never be the one that gets packaged. The runner's temp dir cleans it up.
  const downloadRoot = options.downloadDir ?? tmpdir();
  mkdirSync(downloadRoot, { recursive: true });
  const staging = mkdtempSync(join(downloadRoot, "pi-cli-"));
  const staged = await stagePiCliForTarget({
    triple: options.target,
    destDir: staging,
    ...(options.base ? { base: options.base } : {}),
  });
  console.log(`pi CLI ${staged.asset} sha256 ${staged.sha256} verified; staged at ${staged.binaryPath}`);
  console.log(`pi distribution at ${staged.distributionDir}`);
  if (options.githubEnv) {
    writeFileSync(options.githubEnv, githubEnvAssignments(staged), { flag: "a" });
    console.log(githubEnvAssignments(staged).trimEnd());
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
