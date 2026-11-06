import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import { replaceFileAtomicSync } from "../atomic-file";
import { isRecord } from "./json-file";

export const OLD_ADVISOR_MODEL = "lw/gemini-3.8-flash";
export const DEEPSEEK_MODEL = "lw/deepseek-v4.1-flash";
export const REMOVED_MODEL_ID = "gemini-3.8-flash";
const OLD_TEXT_MODELS = new Set(["gemini-3.8-flash", "gemini-3.5-flash-lite", "lw/gemini-3.8-flash", "lw/gemini-3.5-flash-lite"]);

export interface DeepSeekMigrationReport { written: string[]; kept: string[] }

function readExisting(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error; // I/O failures must leave the migration flag unset for a retry.
  }
}

/** Change only direct advisor model scalars, retaining comments/formatting.
 * Validate the entire semantic delta before writing: instruction blocks,
 * anchors, or unfamiliar YAML must never be accidentally rewritten.
 */
export function migrateAdvisorText(source: string): string | null {
  if (!source.trim()) return source;
  try {
    const original: unknown = load(source);
    if (!isRecord(original) || !Array.isArray(original.advisors)) return source;
    const expected = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    let changed = false;
    for (const advisor of expected.advisors as unknown[]) {
      if (isRecord(advisor) && advisor.model === OLD_ADVISOR_MODEL) {
        advisor.model = DEEPSEEK_MODEL;
        changed = true;
      }
    }
    if (!changed) return source;
    const next = source.replace(
      /^([ \t]*(?:-[ \t]+)?model[ \t]*:[ \t]*)(?:"lw\/gemini-3\.8-flash"|'lw\/gemini-3\.8-flash'|lw\/gemini-3\.8-flash)(?=[ \t]*(?:#[^\r\n]*)?\r?$)/gm,
      (match) => match.replace(OLD_ADVISOR_MODEL, DEEPSEEK_MODEL),
    );
    return isDeepStrictEqual(load(next), expected) ? next : null;
  } catch {
    return null;
  }
}

/** Global user config only. No project traversal and no credential routing changes.
 * seedAgentDir records releaseMigrations["0.8.209"] after success. Invalid files
 * are reported and left intact; read/write errors throw so the next start retries.
 */
export function applyDeepSeekMigration(agentDir: string): DeepSeekMigrationReport {
  const report: DeepSeekMigrationReport = { written: [], kept: [] };
  for (const name of ["WATCHDOG.yml", "WATCHDOG.yaml"]) {
    const path = join(agentDir, name);
    const source = readExisting(path);
    if (source === undefined) continue;
    const next = migrateAdvisorText(source);
    if (next === null) report.kept.push(`${name}: invalid or unsupported YAML`);
    else if (next !== source) { replaceFileAtomicSync(path, next); report.written.push(name); }
  }

  const updateJson = (name: string, update: (config: Record<string, unknown>) => void) => {
    const path = join(agentDir, name);
    const source = readExisting(path);
    if (source === undefined) return;
    let config: unknown;
    try { config = JSON.parse(source.replace(/^\uFEFF/, "")); } catch { report.kept.push(`${name}: invalid JSON`); return; }
    if (!isRecord(config)) { report.kept.push(`${name}: not an object`); return; }
    const before = JSON.stringify(config);
    update(config);
    if (JSON.stringify(config) !== before) {
      replaceFileAtomicSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
      report.written.push(name);
    }
  };

  updateJson("extensions/pi-auto-review/config.json", (config) => {
    if (typeof config.model === "string" && OLD_TEXT_MODELS.has(config.model)) config.model = DEEPSEEK_MODEL;
  });
  updateJson("web-search.json", (config) => {
    // Search is a separate provider API, not a chat model. Exa supports a
    // keyless search path; keep Gemini credentials for audio/video only.
    if (config.provider === "gemini" && config.searchModel === REMOVED_MODEL_ID && config.searchProvider === undefined) {
      config.provider = "exa";
      delete config.searchModel;
    }
    for (const key of ["summaryModel", "queryRewriteModel"]) {
      if (config[key] === undefined || (typeof config[key] === "string" && OLD_TEXT_MODELS.has(config[key]))) {
        config[key] = DEEPSEEK_MODEL;
      }
    }
  });
  updateJson("models.json", (config) => {
    const provider = isRecord(config.providers) ? config.providers.lw : undefined;
    if (isRecord(provider) && Array.isArray(provider.models)) {
      provider.models = provider.models.filter((model) => !isRecord(model) || model.id !== REMOVED_MODEL_ID);
    }
  });
  updateJson("settings.json", (config) => {
    if (config.defaultProvider === "lw" && config.defaultModel === REMOVED_MODEL_ID) {
      config.defaultModel = "deepseek-v4.1-flash";
    }
  });
  return report;
}
