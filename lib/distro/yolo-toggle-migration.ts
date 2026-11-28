/**
 * Move the permission system's retired file-backed `yoloMode` switch onto the
 * `yolo-session` link provided by pi-permission-yolo-toggle (release 0.8.704).
 *
 * The toggle default is recorded before the permission config is changed, so a
 * failed write can be retried without losing the old state. Existing valid
 * toggle choices win. A dormant `yolo-session` chain on an old install is also
 * given `defaultEnabled: false`; only a permission file actually created by
 * this seed run, with no toggle file, is treated as a fresh install whose
 * extension default (on) should apply. File contents never establish that
 * provenance.
 *
 * Permission-system global config is JSONC. Parse it strictly as JSONC and use
 * targeted edits so comments, deny rules and unrelated user settings survive.
 * The toggle extension's own config remains strict JSON and is fully validated
 * before either file is written. Project-scoped configs are not touched.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  type ParseError,
} from "jsonc-parser";
import { replaceFileAtomicSync } from "../atomic-file";
import { isRecord } from "./json-file";

/** The authorizer name pi-permission-yolo-toggle registers its link under. */
export const YOLO_AUTHORIZER_NAME = "yolo-session";

export const PERMISSION_SYSTEM_CONFIG = "extensions/pi-permission-system/config.json";
export const YOLO_TOGGLE_CONFIG = "extensions/pi-permission-yolo-toggle/config.json";

export interface YoloToggleMigrationReport { written: string[]; kept: string[] }

export interface YoloToggleMigrationOptions {
  /** Files this seed run actually created, not files that merely match a seed. */
  newlySeededFiles?: ReadonlySet<string>;
}

interface PermissionConfigFile {
  config: Record<string, unknown>;
  body: string;
  bom: string;
}

function readPermissionConfig(path: string): PermissionConfigFile {
  const source = readFileSync(path, "utf8");
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? source.slice(1) : source;
  if (!body.trim()) return { config: {}, body, bom };
  const errors: ParseError[] = [];
  const parsed: unknown = parse(body, errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length > 0 || !isRecord(parsed)) {
    throw new Error(`${PERMISSION_SYSTEM_CONFIG} is not valid JSONC object; left untouched`);
  }
  const tree = parseTree(body, errors, { allowTrailingComma: true, allowEmptyContent: true });
  for (const key of ["authorizerChain", "yoloMode"]) {
    const occurrences = tree?.children?.filter((property) => property.children?.[0]?.value === key).length ?? 0;
    if (occurrences > 1) {
      throw new Error(`${PERMISSION_SYSTEM_CONFIG}: duplicate ${key} key; left untouched`);
    }
  }
  return { config: parsed, body, bom };
}

/** The toggle extension accepts strict JSON only, including for existing files. */
function readToggleConfig(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    // Match the extension: it JSON.parses the raw text, so a BOM is invalid.
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${YOLO_TOGGLE_CONFIG} is not valid strict JSON; left untouched`);
  }
  if (!isRecord(parsed)) throw new Error(`${YOLO_TOGGLE_CONFIG} must contain an object; left untouched`);
  if (parsed.defaultEnabled !== undefined && typeof parsed.defaultEnabled !== "boolean") {
    throw new Error(`${YOLO_TOGGLE_CONFIG}: defaultEnabled must be a boolean; left untouched`);
  }
  for (const key of ["statusOn", "statusOff"] as const) {
    if (parsed[key] !== undefined && typeof parsed[key] !== "string") {
      throw new Error(`${YOLO_TOGGLE_CONFIG}: ${key} must be a string; left untouched`);
    }
  }
  return parsed;
}

function writePrivateText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Existing dotfiles links must keep pointing at their target. New files are
  // still created through a wx temporary file and renamed into place.
  replaceFileAtomicSync(path, text, { mode: 0o600 });
}

/** Remove exactly a root property and its comma, leaving surrounding JSONC
 * comments in place. jsonc-parser's modify() also consumes comments before a
 * first property, which can silently discard a user's policy explanation. */
function removePermissionProperty(body: string, key: string): string {
  const root = parseTree(body, [], { allowTrailingComma: true, allowEmptyContent: true });
  if (!root) return body;
  const value = findNodeAtLocation(root, [key]);
  const property = value?.parent;
  if (property?.type !== "property" || property.parent?.type !== "object") return body;
  const properties = property.parent.children ?? [];
  const index = properties.indexOf(property);
  const previous = index > 0 ? properties[index - 1] : undefined;
  const next = index >= 0 ? properties[index + 1] : undefined;
  const propertyStart = property.offset;
  const propertyEnd = property.offset + property.length;
  const objectEnd = property.parent.offset + property.parent.length;

  const scanner = createScanner(body, false);
  const commas: Array<{ offset: number; length: number; content: string }> = [];
  while (scanner.getTokenOffset() < body.length) {
    scanner.scan();
    if (body.slice(scanner.getTokenOffset(), scanner.getPosition()) === ",") {
      commas.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: "" });
    }
  }
  const edits = [{ offset: propertyStart, length: property.length, content: "" }];
  if (next) {
    const comma = commas.find((candidate) => candidate.offset >= propertyEnd && candidate.offset < next.offset);
    if (comma) edits.push(comma);
  } else {
    const previousEnd = previous ? previous.offset + previous.length : property.parent.offset + 1;
    const preceding = commas.filter((candidate) =>
      candidate.offset >= previousEnd && candidate.offset < propertyStart).at(-1);
    const trailing = commas.find((candidate) => candidate.offset >= propertyEnd && candidate.offset < objectEnd);
    if (preceding) edits.push(preceding);
    if (trailing) edits.push(trailing);
  }
  return applyEdits(body, edits);
}

function editPermissionConfig(
  file: PermissionConfigFile,
  chain: unknown[],
  needsLink: boolean,
  removeYoloMode: boolean,
): string {
  let body = file.body;
  const formattingOptions = {
    tabSize: 2,
    insertSpaces: true,
    eol: body.includes("\r\n") ? "\r\n" : "\n",
    keepLines: true,
  };
  if (needsLink) {
    body = applyEdits(body, modify(body, ["authorizerChain"], [YOLO_AUTHORIZER_NAME, ...chain], { formattingOptions }));
  }
  if (removeYoloMode) {
    body = removePermissionProperty(body, "yoloMode");
  }
  return file.bom + body;
}

export function applyYoloToggleMigration(
  agentDir: string,
  options: YoloToggleMigrationOptions = {},
): YoloToggleMigrationReport {
  const report: YoloToggleMigrationReport = { written: [], kept: [] };
  const configPath = join(agentDir, PERMISSION_SYSTEM_CONFIG);
  if (!existsSync(configPath)) return report;

  const permissionFile = readPermissionConfig(configPath);
  const { config } = permissionFile;
  const chain = config.authorizerChain;
  if (chain !== undefined && !Array.isArray(chain)) {
    throw new Error(`${PERMISSION_SYSTEM_CONFIG}: authorizerChain is not an array; left untouched`);
  }
  const yoloMode = config.yoloMode;
  const entries = (chain ?? []) as unknown[];
  const needsLink = !entries.includes(YOLO_AUTHORIZER_NAME);
  // Only a boolean carried a YOLO state; anything else was never a working switch.
  const legacyYolo = typeof yoloMode === "boolean";
  if (needsLink && yoloMode !== undefined && !legacyYolo) {
    report.kept.push(`${PERMISSION_SYSTEM_CONFIG}: yoloMode is not a boolean; left as is`);
  }

  // Validate the complete existing toggle before writing either file. Strict
  // JSON here is deliberate: JSONC support belongs to the permission system.
  const togglePath = join(agentDir, YOLO_TOGGLE_CONFIG);
  const toggle = existsSync(togglePath) ? readToggleConfig(togglePath) : null;
  const oldDefault = legacyYolo ? yoloMode === true : false;
  const createdByThisSeed = options.newlySeededFiles?.has(PERMISSION_SYSTEM_CONFIG) === true;

  let nextToggle: Record<string, unknown> | null = null;
  if (toggle !== null) {
    if (toggle.defaultEnabled === undefined) {
      nextToggle = { ...toggle, defaultEnabled: oldDefault };
    } else if (needsLink || legacyYolo) {
      report.kept.push(`${YOLO_TOGGLE_CONFIG} exists: its defaultEnabled kept`);
    }
  } else if (needsLink || legacyYolo || !createdByThisSeed) {
    // An already-linked old config is not evidence that YOLO was on: its link
    // may never have loaded. Only a file created by this seed run gets the
    // extension default. A crash before migration therefore fails closed on
    // the next start, even when the file still exactly matches the new seed.
    nextToggle = { defaultEnabled: oldDefault };
  }

  if (nextToggle !== null) {
    writePrivateText(togglePath, `${JSON.stringify(nextToggle, null, 2)}\n`);
    report.written.push(YOLO_TOGGLE_CONFIG);
  }

  if (needsLink || legacyYolo) {
    writePrivateText(configPath, editPermissionConfig(permissionFile, entries, needsLink, legacyYolo));
    report.written.push(PERMISSION_SYSTEM_CONFIG);
  }
  return report;
}
