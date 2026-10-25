/**
 * The pi CLI staging script (docs/distro.md): one upstream release archive per
 * Rust target triple, with two different layouts (`pi/pi` in the darwin/linux
 * tarballs, a flat `pi.exe` in the Windows zips), each verified against the
 * release's SHA256SUMS before extraction.
 *
 * The archives here are built in-test, so nothing touches the network.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { deflateRawSync, gzipSync } from "node:zlib";
import {
  PI_CLI_RELEASE_BASE,
  PI_CLI_TARGETS,
  expectedArchiveSha256,
  extractPiCliArchive,
  githubEnvAssignments,
  parseSha256Sums,
  piCliArtifactFor,
  stagePiCliForTarget,
} from "./pi-cli-release.mjs";

// --- fixtures -------------------------------------------------------------

/** One file entry of a minimal POSIX ustar archive (`dir` writes typeflag 5). */
function tarEntry(path, data, mode, dir = false, type) {
  const header = Buffer.alloc(512);
  const size = Buffer.byteLength(data);
  header.write(path, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write("00000000000\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "utf8");
  header.write(type ?? (dir ? "5" : "0"), 156, 1, "utf8");
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  const padding = Buffer.alloc((512 - (size % 512)) % 512);
  return Buffer.concat([header, Buffer.from(data), padding]);
}

function tarOnly(files) {
  return Buffer.concat([
    ...files.map((file) => tarEntry(file.path, file.data, file.mode ?? 0o644, file.dir === true, file.type)),
    Buffer.alloc(1024),
  ]);
}

function tarGz(files) {
  return gzipSync(tarOnly(files));
}

/** A minimal zip with stored (method 0) and deflated (method 8) entries. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const raw = Buffer.from(file.data);
    const method = file.deflate ? 8 : 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    // Unix mode in the high 16 bits, as `zip` writes it for executables.
    central.writeUInt32LE(((file.mode ?? 0o644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-cli-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// --- the target map -------------------------------------------------------

test("six targets map to the published archives, layouts and stage names", () => {
  const expected = {
    "x86_64-pc-windows-msvc": ["pi-windows-x64.zip", "zip", "pi.exe"],
    "aarch64-pc-windows-msvc": ["pi-windows-arm64.zip", "zip", "pi.exe"],
    "aarch64-apple-darwin": ["pi-darwin-arm64.tar.gz", "tar.gz", "pi/pi"],
    "x86_64-apple-darwin": ["pi-darwin-x64.tar.gz", "tar.gz", "pi/pi"],
    "x86_64-unknown-linux-gnu": ["pi-linux-x64.tar.gz", "tar.gz", "pi/pi"],
    "aarch64-unknown-linux-gnu": ["pi-linux-arm64.tar.gz", "tar.gz", "pi/pi"],
  };
  assert.deepEqual([...PI_CLI_TARGETS].sort(), Object.keys(expected).sort());
  for (const [triple, [asset, kind, entry]] of Object.entries(expected)) {
    const artifact = piCliArtifactFor(triple);
    assert.equal(artifact.asset, asset, `${triple} uses the published asset name`);
    assert.equal(artifact.kind, kind);
    assert.equal(artifact.entry, entry);
    // The staged file must keep the name resolvePiExecutable() probes for.
    assert.equal(artifact.stageName, entry.slice(entry.lastIndexOf("/") + 1));
  }
});

test("an unsupported triple fails with the supported list, not a guessed asset", () => {
  assert.throws(
    () => piCliArtifactFor("aarch64-unknown-linux-musl"),
    /no pi CLI release artifact for target triple "aarch64-unknown-linux-musl".*x86_64-pc-windows-msvc/s,
  );
});

// --- checksums -----------------------------------------------------------

test("SHA256SUMS parsing keeps binary-mode markers and ignores noise", () => {
  const sums = parseSha256Sums([
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  pi-darwin-arm64.tar.gz",
    "FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210 *pi-windows-x64.zip",
    "",
    "not a checksum line",
  ].join("\n"));
  assert.equal(sums.get("pi-darwin-arm64.tar.gz"), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  assert.equal(sums.get("pi-windows-x64.zip"), "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210");
  assert.equal(sums.size, 2);
});

test("an asset missing from SHA256SUMS is refused with the published names", () => {
  const text = `${"a".repeat(64)}  pi-windows-x64.zip\n`;
  assert.throws(
    () => expectedArchiveSha256(text, "pi-darwin-arm64.tar.gz"),
    /lists no pi-darwin-arm64\.tar\.gz.*pi-windows-x64\.zip/s,
  );
});

// --- extraction layout ---------------------------------------------------

test("a darwin/linux tarball is unpacked to pi/pi and made executable", async (t) => {
  const dir = await sandbox(t);
  const archive = tarGz([
    { path: "pi/", data: "", mode: 0o755, dir: true },
    { path: "pi/pi", data: "#!/bin/sh\necho pi\n", mode: 0o644 },
    { path: "pi/theme/dark.json", data: "{}", mode: 0o644 },
  ]);
  const binaryPath = extractPiCliArchive({
    archive,
    kind: "tar.gz",
    entry: "pi/pi",
    stageName: "pi",
    destDir: join(dir, "out"),
  });
  assert.equal(binaryPath, join(dir, "out", "pi", "pi"));
  assert.equal(readFileSync(binaryPath, "utf8"), "#!/bin/sh\necho pi\n");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "out", "pi", "theme", "dark.json"), "utf8")), {});
  if (process.platform !== "win32") {
    // The tarball's 0644 is not enough: the engine spawns this path directly.
    assert.equal(statSync(binaryPath).mode & 0o777, 0o755);
  }
});

test("a Windows zip's flat pi.exe is unpacked and kept executable", async (t) => {
  const dir = await sandbox(t);
  const archive = zip([
    { path: "theme/dark.json", data: "{}" },
    { path: "pi.exe", data: "MZ fake", mode: 0o755, deflate: true },
    { path: "examples/README.md", data: "#", deflate: false },
  ]);
  const binaryPath = extractPiCliArchive({
    archive,
    kind: "zip",
    entry: "pi.exe",
    stageName: "pi.exe",
    destDir: join(dir, "out"),
  });
  assert.equal(binaryPath, join(dir, "out", "pi.exe"));
  assert.equal(readFileSync(binaryPath, "utf8"), "MZ fake");
  assert.equal(readFileSync(join(dir, "out", "examples", "README.md"), "utf8"), "#");
});

test("a wrong archive layout names what it found instead of guessing a root", async (t) => {
  const dir = await sandbox(t);
  const archive = tarGz([{ path: "pi/bin/pi", data: "x", mode: 0o755 }]);
  assert.throws(
    () => extractPiCliArchive({
      archive,
      kind: "tar.gz",
      entry: "pi/pi",
      stageName: "pi",
      destDir: join(dir, "out"),
    }),
    /has no pi\/pi \(entries: pi\/bin\/pi\)/,
  );
});

test("an archive entry that escapes the extraction dir is refused", async (t) => {
  const dir = await sandbox(t);
  const archive = tarGz([
    { path: "pi/pi", data: "x", mode: 0o755 },
    { path: "../escape.sh", data: "x", mode: 0o755 },
  ]);
  assert.throws(
    () => extractPiCliArchive({
      archive,
      kind: "tar.gz",
      entry: "pi/pi",
      stageName: "pi",
      destDir: join(dir, "out"),
    }),
    /escapes the extraction directory: "\.\.\/escape\.sh"/,
  );
});

// --- the whole staging step ----------------------------------------------

/** A fetch stand-in serving one archive plus the release's SHA256SUMS. */
function releaseFetch({ asset, archive, sums }) {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith("/SHA256SUMS")) return { ok: true, arrayBuffer: async () => Buffer.from(sums), status: 200 };
    if (url.endsWith(`/${asset}`)) return { ok: true, arrayBuffer: async () => archive, status: 200 };
    return { ok: false, status: 404, statusText: "Not Found" };
  };
  return { fetchImpl, requests };
}

test("staging downloads the target's archive, verifies it and stages the binary", async (t) => {
  const dir = await sandbox(t);
  const archive = tarGz([{ path: "pi/pi", data: "binary", mode: 0o755 }]);
  const sums = `${sha256(archive)}  pi-darwin-x64.tar.gz\n`;
  const { fetchImpl, requests } = releaseFetch({ asset: "pi-darwin-x64.tar.gz", archive, sums });

  const staged = await stagePiCliForTarget({
    triple: "x86_64-apple-darwin",
    destDir: join(dir, "stage"),
    fetchImpl,
  });

  // The Intel build downloads the x64 archive from an ARM runner: the target
  // triple decides, never the runner's own architecture.
  assert.deepEqual(requests, [
    `${PI_CLI_RELEASE_BASE}/SHA256SUMS`,
    `${PI_CLI_RELEASE_BASE}/pi-darwin-x64.tar.gz`,
  ]);
  assert.equal(staged.sha256, sha256(archive));
  assert.equal(readFileSync(staged.binaryPath, "utf8"), "binary");
  assert.equal(
    githubEnvAssignments(staged),
    `PI_CLI_SOURCE=${staged.binaryPath}\nPI_CLI_DISTRIBUTION_DIR=${join(dir, "stage", "pi")}\n`,
  );
  // The distribution beside the binary is exported too: prepare-desktop needs
  // the whole archive tree, not just the executable.
  assert.equal(staged.distributionDir, join(dir, "stage", "pi"));
});

test("an env-file value with a newline is refused instead of injected", () => {
  assert.throws(
    () => githubEnvAssignments({ binaryPath: "/tmp/pi\nPI_WEB_PASSWORD=x", distributionDir: "/tmp" }),
    /PI_CLI_SOURCE cannot be written to the env file/,
  );
  assert.throws(
    () => githubEnvAssignments({ binaryPath: "/tmp/pi", distributionDir: "/tmp\r\nX=1" }),
    /PI_CLI_DISTRIBUTION_DIR cannot be written to the env file/,
  );
});

test("prototype keys are not target triples", () => {
  for (const triple of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.throws(() => piCliArtifactFor(triple), /no pi CLI release artifact for target triple/);
  }
});

test("a truncated tar and a PAX/GNU header are refused, not half-read", async (t) => {
  const dir = await sandbox(t);
  // A header whose size field promises more bytes than the archive holds: the
  // release checksum proves the bytes arrived, not that the tar is coherent.
  const raw = Buffer.from(tarOnly([{ path: "pi/pi", data: "binary", mode: 0o755 }]));
  raw.write("00000000014\0", 124, 12, "utf8");
  const truncated = gzipSync(raw.subarray(0, 512 + 6));
  assert.throws(
    () => extractPiCliArchive({ archive: truncated, kind: "tar.gz", entry: "pi/pi", stageName: "pi", destDir: join(dir, "a") }),
    /truncated/,
  );
  // A PAX header would carry the real path in its body; ignoring it would
  // extract the wrong file name.
  const pax = tarGz([{ path: "PaxHeaders/x", data: "30 path=pi/pi\n", mode: 0o644, type: "x" }]);
  assert.throws(
    () => extractPiCliArchive({ archive: pax, kind: "tar.gz", entry: "pi/pi", stageName: "pi", destDir: join(dir, "b") }),
    /PAX\/GNU extension/,
  );
});

test("a hardlink, symlink, device or fifo entry is refused, never silently skipped", async (t) => {
  const dir = await sandbox(t);
  // Skipped non-regular entries would stage a tree that still verifies against
  // its own manifest (the manifest lists what was staged, not what upstream
  // meant to ship), so each unsupported type is a hard failure.
  for (const [label, type] of [["hardlink", "1"], ["symlink", "2"], ["char device", "3"], ["fifo", "6"]]) {
    const archive = tarGz([
      { path: "pi/pi", data: "binary", mode: 0o755 },
      { path: `pi/theme/linked-${label}`, data: "theme", mode: 0o644, type },
    ]);
    assert.throws(
      () => extractPiCliArchive({ archive, kind: "tar.gz", entry: "pi/pi", stageName: "pi", destDir: join(dir, label) }),
      new RegExp(`unsupported type "${type}"`),
      `${label} must fail the extraction instead of being dropped`,
    );
  }
  // A plain directory entry stays fine (it carries no data).
  const withDir = tarGz([
    { path: "pi/theme/", data: "", mode: 0o755, dir: true },
    { path: "pi/pi", data: "binary", mode: 0o755 },
  ]);
  const staged = extractPiCliArchive({ archive: withDir, kind: "tar.gz", entry: "pi/pi", stageName: "pi", destDir: join(dir, "plain") });
  assert.ok(staged.endsWith("pi"));
});

test("a checksum mismatch stops before extraction", async (t) => {
  const dir = await sandbox(t);
  const archive = tarGz([{ path: "pi/pi", data: "binary", mode: 0o755 }]);
  const sums = `${"0".repeat(64)}  pi-darwin-arm64.tar.gz\n`;
  const { fetchImpl } = releaseFetch({ asset: "pi-darwin-arm64.tar.gz", archive, sums });
  await assert.rejects(
    stagePiCliForTarget({ triple: "aarch64-apple-darwin", destDir: join(dir, "stage"), fetchImpl }),
    /pi-darwin-arm64\.tar\.gz: SHA-256 [0-9a-f]{64} does not match the release's 0{64}/,
  );
  assert.throws(() => statSync(join(dir, "stage", "pi", "pi")), /ENOENT/);
});

test("a 404 while fetching the release refuses to stage anything", async (t) => {
  const dir = await sandbox(t);
  const fetchImpl = async () => ({ ok: false, status: 404, statusText: "Not Found" });
  await assert.rejects(
    stagePiCliForTarget({ triple: "aarch64-apple-darwin", destDir: join(dir, "stage"), fetchImpl }),
    /GET .*\/SHA256SUMS failed: HTTP 404/,
  );
  assert.throws(() => statSync(join(dir, "stage", "pi", "pi")), /ENOENT/);
});

test("staging is idempotent per directory and refreshes file modes", async (t) => {
  const dir = await sandbox(t);
  mkdirSync(join(dir, "stage", "pi"), { recursive: true });
  const stale = join(dir, "stage", "pi", "pi");
  await (await import("node:fs/promises")).writeFile(stale, "stale");
  chmodSync(stale, 0o600);
  const archive = tarGz([{ path: "pi/pi", data: "fresh", mode: 0o644 }]);
  const sums = `${sha256(archive)}  pi-darwin-x64.tar.gz\n`;
  const { fetchImpl } = releaseFetch({ asset: "pi-darwin-x64.tar.gz", archive, sums });
  const staged = await stagePiCliForTarget({ triple: "x86_64-apple-darwin", destDir: join(dir, "stage"), fetchImpl });
  assert.equal(readFileSync(staged.binaryPath, "utf8"), "fresh");
  if (process.platform !== "win32") assert.equal(statSync(staged.binaryPath).mode & 0o777, 0o755);
});
