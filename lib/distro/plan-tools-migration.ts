/**
 * One-time distro migration (revision 3): make plan-mode delegation reachable
 * after the lazy tool activation switch (revision 2, `lazy-tool-activation.ts`).
 *
 * With `toolActivation: "dynamic"` a fresh session starts with the
 * `subagents_enable` loader alone, and pi-plan-vanguard's Plan policy admits
 * only what `defaultPlanTools` selects (plus its own per-call read-only
 * delegation verification, which runs *before* the allowlist and needs no
 * entry). The loader is an extension tool without a `readOnlyHint`, so it
 * classifies as "user-opt-in": the revision-2 seed list did not name it, and a
 * Plan workflow blocked the call — "not selected by the Plan policy" — leaving
 * plan-mode delegation unusable on every install that seeded the old list.
 *
 * The fix adds three names to `defaultPlanTools`:
 *
 *   - `subagents_enable`: the loader must be callable for `subagent` to appear.
 *   - `subagent`: without it only *verified* read-only agents, plan-scout and
 *     `planAdmittedAgents` run; with it the tool is also selectable, so any
 *     agent does. Children execute outside the Plan sandbox — selecting
 *     `subagent` is a deliberate opt-in to that, exactly like choosing it in
 *     `/plan tools`.
 *   - `subagent_supervisor`: the parent's reply channel; without it a child
 *     that asks its supervisor a question during a Plan workflow can never be
 *     answered.
 *
 * `bg_wait` stays out on purpose: pi-plan-vanguard 0.62.x keeps it blocked in
 * Plan mode and its prompt tells the model results arrive automatically.
 *
 * Like every migration here this is a one-shot seed, never a recurring default:
 * the state flag (`migrations.planTools` in `desktop-distro.json`) covers
 * everything once it is set, and the value check below rewrites only a list
 * that still matches the old seeded one entry-for-entry. A list the user
 * edited — reordered, trimmed, extended, or with the key deleted — is a
 * deliberate answer to the same trade-off and is never touched, and a missing
 * `pi-plan-vanguard.json` is left to the `agentFiles` seed (which also skips
 * when a legacy `pi-plan-mode.json`/`plan-mode.json` still exists; the
 * migration applies the same guard so the two paths cannot disagree).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DISTRO } from "./config";
import { readJsonObject, writeJsonObject } from "./json-file";

/** The config file this migration touches, relative to the agent dir. */
export const PLAN_TOOLS_CONFIG_FILE = "pi-plan-vanguard.json";

/** The list revisions ≤ 2 seeded (unchanged since it was introduced). */
export const PRE_DELEGATION_PLAN_TOOLS: readonly string[] = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "web_enable",
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
];

/** The delegation names revision 3 adds; exported for the drift test. */
export const DELEGATION_PLAN_TOOLS: readonly string[] = ["subagents_enable", "subagent", "subagent_supervisor"];

export interface PlanToolsMigrationReport {
  /** The old seeded list was replaced with the current one. */
  written: boolean;
  /** Why an existing file was left alone; empty for a missing file. */
  kept: string[];
}

function sameEntries(actual: readonly unknown[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const seen = new Set<string>();
  for (const name of actual) {
    if (typeof name !== "string" || seen.has(name)) return false;
    seen.add(name);
  }
  return expected.every((name) => seen.has(name));
}

function seededPlanTools(): string[] {
  const entry = DISTRO.agentFiles[PLAN_TOOLS_CONFIG_FILE];
  const list = (entry as { defaultPlanTools?: unknown } | undefined)?.defaultPlanTools;
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : [];
}

/**
 * Replace the revision-2 `defaultPlanTools` seed with the revision-3 list, in
 * an existing `pi-plan-vanguard.json`. Called at most once per agent dir by the
 * seed (`migrations.planTools`); a failed write leaves that flag unset so the
 * next start retries. Calling it again is harmless for a customized list.
 */
export function applyPlanToolsMigration(agentDir: string): PlanToolsMigrationReport {
  const legacyNames = DISTRO.legacyAgentFiles?.[PLAN_TOOLS_CONFIG_FILE] ?? [];
  if (legacyNames.some((legacy) => existsSync(join(agentDir, legacy)))) {
    // pi-plan-vanguard still reads the legacy file and migrates it itself on
    // next save; creating the canonical file here would shadow it.
    return { written: false, kept: ["legacy config file present"] };
  }

  const path = join(agentDir, PLAN_TOOLS_CONFIG_FILE);
  if (!existsSync(path)) {
    // Fresh (or never-seeded) install: `agentFiles` writes the current list
    // when the file is missing, so the migration has nothing to do.
    return { written: false, kept: [] };
  }

  const config = readJsonObject(path);
  if (!config) return { written: false, kept: ["config is not valid JSON"] };

  const current = config.defaultPlanTools;
  if (!Array.isArray(current)) return { written: false, kept: ["no defaultPlanTools key (user deleted it)"] };
  if (!sameEntries(current, PRE_DELEGATION_PLAN_TOOLS)) {
    return { written: false, kept: ["defaultPlanTools was customized"] };
  }

  writeJsonObject(path, { ...config, defaultPlanTools: seededPlanTools() });
  return { written: true, kept: [] };
}
