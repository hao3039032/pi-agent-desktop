/**
 * One-time distro default: start a session with the loader tools only
 * (fork-owned; see docs/distro.md).
 *
 * Both bundled extensions register their whole tool set eagerly under their own
 * default (`toolActivation: "auto"`). `auto` only keeps the lazy loader when the
 * selected model's provider accepts a tool added mid-conversation; the models
 * this distro ships run through the LW provider (an `anthropic-messages` HTTP
 * endpoint), and none of the models the distro ships declares that support in
 * its `compat` block — so `auto` falls back to eager there and a fresh parent
 * session declares on every request:
 *
 *   - pi-subagents: `subagent`, `bg_wait`, `subagent_supervisor`,
 *     `contact_supervisor` (`contact_supervisor` rides along with `subagent`)
 *   - pi-web-access: `web_search`, `source_check`, `fetch_content`,
 *     `get_search_content`
 *
 * Most sessions use neither, yet every request pays for those declarations.
 * `"dynamic"` keeps the loader-only shape on every model: a new session
 * declares `subagents_enable` and `web_enable` alone, and the real tools appear
 * on the next model request after the model calls the loader. That request
 * carries a changed tool list, so Pi resends the whole conversation and its
 * cached prefix is lost — one prompt-cache miss. `auto` falls back to eager on a
 * model whose `compat` declares no mid-conversation tool changes precisely to
 * avoid that miss; nothing about such a model prevents the tools from being
 * added there, and `"dynamic"` puts every model on the loader path and pays it.
 * The trade-off is that single miss against the schemas on every request before
 * it. pi-subagents likewise hands a restored older session one
 * `subagents_enable` pass, at the same one-off cost.
 *
 * Only "bridges that hand Pi's tools to another agent SDK" defer the change to
 * the next *user* prompt, because they fix the tool list for a whole prompt
 * (pi-subagents documents that case and points those users at
 * `--exclude-tools subagents_enable`). This distro's `lw` provider is a plain
 * `anthropic-messages` HTTP endpoint, not such a bridge.
 *
 * `"eager"` is the opposite choice, made deliberately by a user who would
 * rather keep the tools declared than pay that miss; a value already in the file
 * is therefore never rewritten, not even by a later revision of this distro.
 * The GUI and CLI keep full control of the choice: this fills in a missing key
 * only, and the seed calls it only while the one-shot flag is still unset.
 *
 * Runs at most once per agent dir (`migrations.toolActivation` in
 * `desktop-distro.json`), and that flag counts as set only after one successful
 * write: a write that throws leaves it unset and the next start retries (see
 * `seed.ts`). Files that do not exist yet are left to the seed
 * (`distro.json`'s `agentFiles`) or, for `web-search.json`, to the service form,
 * and every other key in a file this module does touch is carried through
 * untouched.
 *
 * **The switch is a one-shot seed, never a default that keeps coming back.** The
 * two guards cover different cases:
 *
 * 1. The state flag covers everything, *including a deleted key*: once it is
 *    set this module never runs again, so a user who removes the key goes back
 *    to the extension's own `auto` for good.
 * 2. The value check only protects values the user wrote down (`eager`, or a
 *    spelling a later release adds): even a lost or corrupt desktop-distro.json
 *    cannot rewrite those.
 *
 * A deleted key is indistinguishable from a never-seeded one, so a lost flag
 * (`readState()` returning null for a corrupt file) is exactly a fresh seed —
 * the same semantics `migrations.mcpAdapter` and `migrations.defaultTools`
 * already have. The flag, not the value check, is the only thing that protects
 * the "deleted the key" case; do not describe it otherwise.
 *
 * Nothing else may inject this key later. In particular it does not belong in
 * `webSearch.defaults`: `applyDistroServiceConfig()` spreads those into
 * `web-search.json` on *every* service-config save, which would put `dynamic`
 * back after a user who deleted the key chose the extension's own `auto`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonObject, writeJsonObject } from "./json-file";

/** The value both extensions accept for "loader first, tools on demand". */
export const LAZY_TOOL_ACTIVATION = "dynamic";

/**
 * Config files that carry the switch, relative to the agent dir. Exported so the
 * distro config's drift test can check every one of them against `agentFiles`
 * (see lib/distro/config.test.mjs).
 */
export const LAZY_TOOL_ACTIVATION_FILES = [
  // pi-web-access: `web_enable` loads the four web tools. Created by the service
  // form rather than seeded: a bare file here would take priority over the
  // legacy `~/.pi/web-search.json` an existing user may still be configured in.
  "web-search.json",
  // pi-subagents: `subagents_enable` loads subagent/bg_wait/subagent_supervisor.
  "extensions/subagent/config.json",
];

export interface LazyToolActivationReport {
  /** Files the default was written into. */
  written: string[];
  /** Files that already carry a `toolActivation` the user chose. */
  kept: string[];
  /** Files that exist but are not a JSON object: never overwritten. */
  invalid: string[];
}

/**
 * Fill in `toolActivation: "dynamic"` for every existing config file that does
 * not state a choice of its own. Missing files are skipped: the seed and the
 * extensions' own defaults cover them.
 *
 * Called at most once per agent dir by the seed, once a write has succeeded — a
 * failed write leaves the flag unset, so the next start retries. Calling it
 * again is harmless for a value the user wrote, but a key they *deleted* would be
 * filled back in — that case is the state flag's job, not this function's.
 */
export function applyLazyToolActivation(agentDir: string): LazyToolActivationReport {
  const report: LazyToolActivationReport = { written: [], kept: [], invalid: [] };

  for (const name of LAZY_TOOL_ACTIVATION_FILES) {
    const path = join(agentDir, name);
    if (!existsSync(path)) continue;

    const config = readJsonObject(path);
    if (!config) {
      report.invalid.push(name);
      continue;
    }
    if (typeof config.toolActivation === "string") {
      report.kept.push(name);
      continue;
    }

    writeJsonObject(path, { ...config, toolActivation: LAZY_TOOL_ACTIVATION });
    report.written.push(name);
  }

  return report;
}
