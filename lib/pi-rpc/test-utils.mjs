/**
 * Shared helpers for the lib/pi-rpc test files: the PI_CLI_BIN path check
 * (an MSYS-style "/f/..." passes a string check but fails existsSync on
 * win32, silently skipping every e2e test — the 0-tests trap AGENTS.md
 * warns about) and the Windows-tolerant temp-dir cleanup.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

/** Map an MSYS/Git-Bash drive path ("/f/project/...") onto "F:/project/...". */
export function normalizeMsysPath(raw) {
  if (process.platform === "win32" && typeof raw === "string" && /^\/[a-zA-Z]\//.test(raw)) {
    return `${raw[1].toUpperCase()}:${raw.slice(2)}`;
  }
  return raw;
}

/**
 * The pi CLI executable to drive, "" when unavailable (tests then skip).
 * Normalized so the same env var works from cmd, PowerShell and MSYS shells.
 * A set-but-missing path fails loudly: a typo silently skipping every e2e
 * test is exactly the 0-tests trap AGENTS.md warns about.
 */
export function resolvePiCliBin() {
  const raw = process.env.PI_CLI_BIN ?? "";
  if (!raw) return "";
  const normalized = normalizeMsysPath(raw);
  if (!existsSync(normalized)) {
    throw new Error(`PI_CLI_BIN points at a missing file: ${normalized}`);
  }
  return normalized;
}

/** Windows: a pi child's cwd handle outlives close() by a beat; rm failures must not fail tests. */
export async function cleanupDir(work) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(work, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}
