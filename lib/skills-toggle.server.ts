import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isExistingPathWithinRoots } from "./path-security";
import { setDisableModelInvocation } from "./skill-frontmatter";

/** Edit only markdown within caller-authorized roots, resolving symlinks first. */
export function toggleSkillFile(
  filePath: string,
  disableModelInvocation: boolean,
  allowedRoots: Set<string>,
): { status: number; error: string } | null {
  if (path.extname(filePath).toLowerCase() !== ".md") return { status: 400, error: "Not a skill file" };
  if (!existsSync(filePath)) return { status: 404, error: "file not found" };
  if (!isExistingPathWithinRoots(filePath, allowedRoots)) return { status: 403, error: "Access denied" };
  const content = readFileSync(filePath, "utf8");
  const updated = setDisableModelInvocation(content, disableModelInvocation);
  if (updated !== content) writeFileSync(filePath, updated, "utf8");
  return null;
}
