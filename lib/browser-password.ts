import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import { remoteAccessSettingsPath } from "./remote-access.ts";

export interface PasswordVerifier { salt: string; hash: string }
export type WebPassword = string | PasswordVerifier;
export const MIN_BROWSER_PASSWORD_LENGTH = 12;
export const MAX_BROWSER_PASSWORD_LENGTH = 1024;

export function browserPasswordPath(): string {
  return join(dirname(remoteAccessSettingsPath()), "browser-password.json");
}

export function readBrowserPassword(path = browserPasswordPath()): PasswordVerifier | undefined {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read browser password configuration", { cause: error });
  }
  // Corrupt/unreadable credentials must never silently disable authentication.
  const record = JSON.parse(raw) as Partial<PasswordVerifier> & { version?: unknown };
  if (record?.version !== 1 || typeof record.salt !== "string" || !/^[a-f0-9]{32}$/.test(record.salt)
    || typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash)) {
    throw new Error("Invalid browser password configuration");
  }
  return { salt: record.salt, hash: record.hash };
}

export function getWebPassword(): WebPassword | undefined {
  return process.env.PI_WEB_PASSWORD || readBrowserPassword();
}

export function writeBrowserPassword(password: string, path = browserPasswordPath()): void {
  if (password.length < MIN_BROWSER_PASSWORD_LENGTH || password.length > MAX_BROWSER_PASSWORD_LENGTH) {
    throw new Error("Password must contain 12–1024 characters");
  }
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, salt, hash }) + "\n");
}

export function removeBrowserPassword(path = browserPasswordPath()): void {
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function verifyBrowserPassword(password: string, verifier: PasswordVerifier): boolean {
  if (password.length > MAX_BROWSER_PASSWORD_LENGTH) return false;
  return timingSafeEqual(scryptSync(password, verifier.salt, 32), Buffer.from(verifier.hash, "hex"));
}

/** Rotating the salted verifier invalidates all previously issued browser cookies. */
export function webPasswordSigningKey(password: WebPassword): string {
  return typeof password === "string" ? password : `scrypt-v1:${password.salt}:${password.hash}`;
}
