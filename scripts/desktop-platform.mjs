import { closeSync, openSync, readSync } from "node:fs";

export function desktopTargetTriple(
  platform = process.platform,
  arch = process.arch,
) {
  if (platform === "darwin" && arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (platform === "darwin" && arch === "x64") {
    return "x86_64-apple-darwin";
  }
  if (platform === "linux" && arch === "x64") {
    return "x86_64-unknown-linux-gnu";
  }
  if (platform === "win32" && arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }

  throw new Error(`Unsupported desktop platform: ${platform}/${arch}`);
}

// Mach-O cpu types (mach/machine.h) for the Node architectures a bundle can
// carry: CPU_TYPE_X86_64 = 0x01000007, CPU_TYPE_ARM64 = 0x0100000c.
const MACH_O_CPU_TYPE_BY_ARCH = {
  x86_64: 0x01000007,
  aarch64: 0x0100000c,
};

/** The Mach-O cpu type a darwin Node binary must contain to serve `triple`. */
export function requiredMachOCpuType(triple) {
  if (!triple.endsWith("-apple-darwin")) {
    throw new Error(`Target triple ${JSON.stringify(triple)} is not a darwin triple; Mach-O cpu types only apply there.`);
  }
  const cpuType = MACH_O_CPU_TYPE_BY_ARCH[triple.split("-")[0]];
  if (!cpuType) {
    throw new Error(`No Mach-O cpu type mapped for target triple ${JSON.stringify(triple)}`);
  }
  return cpuType;
}

/**
 * The cpu types a Mach-O file carries — one entry for a thin binary, every
 * slice for a universal one — or null when the file is not Mach-O (Windows
 * PE / Linux ELF). Used to gate cross-arch staging in prepare-desktop.mjs.
 */
export function readMachOCpuTypes(filePath) {
  const fd = openSync(filePath, "r");
  try {
    // Fat header (magic + nfat_arch) plus up to eight fat_arch entries
    // (cputype, cpusubtype, offset, size, align — 20 bytes each).
    const head = Buffer.alloc(8 + 20 * 8);
    const bytesRead = readSync(fd, head, 0, head.length, 0);
    const bytes = head.subarray(0, bytesRead);
    if (bytesRead < 8) return null;

    // Universal binaries store the fat magic and arch table big-endian.
    if (bytes.readUInt32BE(0) === 0xcafebabe) {
      const count = bytes.readUInt32BE(4);
      const cpuTypes = [];
      for (let index = 0; index < count; index += 1) {
        const entryOffset = 8 + index * 20;
        if (entryOffset + 4 > bytes.length) break;
        cpuTypes.push(bytes.readUInt32BE(entryOffset));
      }
      return cpuTypes;
    }

    // Thin header: magic (0xfeedfacf 64-bit / 0xfeedface 32-bit) followed by
    // cputype, in either byte order. 0xcafebabe cannot collide: a thin
    // little-endian x86_64 header reads 0xcffaedfe big-endian.
    if ([0xfeedfacf, 0xfeedface].includes(bytes.readUInt32LE(0))) {
      return [bytes.readUInt32LE(4)];
    }
    if ([0xfeedfacf, 0xfeedface].includes(bytes.readUInt32BE(0))) {
      return [bytes.readUInt32BE(4)];
    }
    return null;
  } finally {
    closeSync(fd);
  }
}
