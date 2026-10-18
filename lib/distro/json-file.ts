import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a JSON object file; missing/empty → `{}`, unparsable → `null` (never overwrite it). */
export function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    if (!text.trim()) return {};
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeJsonObject(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
