import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  desktopTargetTriple,
  readMachOCpuTypes,
  requiredMachOCpuType,
} from "./desktop-platform.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("desktop builds target both macOS architectures, Linux x64, and Windows x64", () => {
  assert.equal(
    desktopTargetTriple("darwin", "arm64"),
    "aarch64-apple-darwin",
  );
  assert.equal(
    desktopTargetTriple("darwin", "x64"),
    "x86_64-apple-darwin",
  );
  assert.equal(
    desktopTargetTriple("linux", "x64"),
    "x86_64-unknown-linux-gnu",
  );
  assert.equal(
    desktopTargetTriple("win32", "x64"),
    "x86_64-pc-windows-msvc",
  );
});

test("unsupported desktop platforms fail before packaging", () => {
  assert.throws(
    () => desktopTargetTriple("linux", "arm64"),
    /Unsupported desktop platform: linux\/arm64/,
  );
  assert.throws(
    () => desktopTargetTriple("darwin", "ia32"),
    /Unsupported desktop platform: darwin\/ia32/,
  );
});

test("Linux and Windows packaging include the bundled Node runtime", async () => {
  const [prepareSource, linuxConfigSource, windowsConfigSource] = await Promise.all([
    readFile(join(root, "scripts", "prepare-desktop.mjs"), "utf8"),
    readFile(join(root, "src-tauri", "tauri.linux.conf.json"), "utf8"),
    readFile(join(root, "src-tauri", "tauri.windows.conf.json"), "utf8"),
  ]);
  const linuxConfig = JSON.parse(linuxConfigSource);
  const windowsConfig = JSON.parse(windowsConfigSource);

  assert.match(prepareSource, /process\.platform === "win32" \? "node\.exe" : "node"/);
  assert.match(prepareSource, /node_modules", "npm"/);
  assert.deepEqual(linuxConfig.bundle.targets, ["deb"]);
  assert.ok(linuxConfig.bundle.resources.includes("resources/node"));
  assert.deepEqual(windowsConfig.bundle.targets, ["nsis"]);
  assert.ok(windowsConfig.bundle.icon.includes("icons/icon.ico"));
  assert.ok(windowsConfig.bundle.resources.includes("resources/node"));
});

// The cpu types below are CPU_TYPE_X86_64 / CPU_TYPE_ARM64 from mach/machine.h.
const X86_64 = 0x01000007;
const ARM64 = 0x0100000c;

test("requiredMachOCpuType maps each darwin triple to its cpu type", () => {
  assert.equal(requiredMachOCpuType("aarch64-apple-darwin"), ARM64);
  assert.equal(requiredMachOCpuType("x86_64-apple-darwin"), X86_64);
  assert.throws(
    () => requiredMachOCpuType("x86_64-unknown-linux-gnu"),
    /not a darwin triple/,
  );
  assert.throws(
    () => requiredMachOCpuType("riscv64-apple-darwin"),
    /No Mach-O cpu type mapped/,
  );
});

test("readMachOCpuTypes reads thin and universal Mach-O headers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-desktop-macho-"));
  try {
    // Thin little-endian x86_64 binary: magic 0xfeedfacf, then cputype.
    const thinX64 = Buffer.alloc(8);
    thinX64.writeUInt32LE(0xfeedfacf, 0);
    thinX64.writeUInt32LE(X86_64, 4);
    const thinPath = join(dir, "thin-x64");
    await writeFile(thinPath, thinX64);
    assert.deepEqual(readMachOCpuTypes(thinPath), [X86_64]);

    // Universal binary: big-endian fat magic 0xcafebabe, nfat_arch, then
    // 20-byte arch entries whose first word is the cpu type.
    const fat = Buffer.alloc(8 + 2 * 20);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(ARM64, 8);
    fat.writeUInt32BE(X86_64, 8 + 20);
    const fatPath = join(dir, "universal");
    await writeFile(fatPath, fat);
    assert.deepEqual(readMachOCpuTypes(fatPath), [ARM64, X86_64]);

    // An ELF binary (Linux Node) is not Mach-O.
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    const elfPath = join(dir, "node");
    await writeFile(elfPath, elf);
    assert.equal(readMachOCpuTypes(elfPath), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
