/**
 * Build the management-instance module bundle (M2/M3): the session-view
 * projection the management extension's session.readContext /
 * session.projectSnapshot ops run, compiled from THIS REPO's source into
 * one self-contained ESM file the vendored management tree loads by
 * absolute path (PI_WEB_MANAGED_MODULES).
 *
 * The point is ONE implementation: the Next server imports
 * lib/session-projection.ts (re-exported through lib/session-reader.ts);
 * the management instance loads the same code bundled here. A drift
 * between the two is a contract break, so the bundle is rebuilt from
 * source — never hand-edited, never vendored as a copy.
 *
 * Usage:
 *   node scripts/migration/build-management-modules.mjs --out <dir>
 *     writes <dir>/pi-web-session-projection.mjs
 *   node scripts/migration/build-management-modules.mjs --check --out <dir>
 *     exits non-zero when the existing file differs from a fresh build
 *
 * The entry is generated (not a tracked file) so the exported surface
 * stays next to the ops that consume it.
 */

import { build } from "esbuild";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

// The exported surface the management extension consumes. Keep in step with
// the ops in lib/pi-rpc/assets/pi-web-management.mjs.
const ENTRY = `
export {
  buildSessionContext,
  sliceActiveBranch,
  getLatestModelChange,
  getLatestResponseModel,
} from "${ROOT}/lib/session-projection.ts";
export { projectTreeForResponse, toSummaryTree } from "${ROOT}/lib/project-tree.ts";
export { computeSessionStats } from "${ROOT}/lib/session-stats.ts";
export { extractActiveSystemPrompt } from "${ROOT}/lib/system-prompt-snapshot.ts";
export { isBashOutputPathReferencedByEntries, isValidSessionId } from "${ROOT}/lib/session-file-references-core.ts";
export { resolveBashOutputPath } from "${ROOT}/lib/bash-output.ts";
export { searchSessionContents } from "${ROOT}/lib/session-search.ts";
export { isFilePathReferencedByEntries } from "${ROOT}/lib/session-file-references-core.ts";
export { formatSessionReference } from "${ROOT}/lib/session-reference.ts";
export { patchExportHtml } from "${ROOT}/lib/session-export-html.ts";
export { computeSessionTotalActiveMs } from "${ROOT}/lib/session-timing.ts";
export {
  readSubagentRun,
  SUBAGENT_META_TYPE,
} from "${ROOT}/lib/subagents.ts";
export {
  readSessionToolSelection,
  validateSessionToolSelection,
} from "${ROOT}/lib/session-tool-selection.ts";
export { chatWorkspacePrompt } from "${ROOT}/lib/chat-workspace-prompt.ts";
export { copyChatToProject, setOfflineChatUnlock } from "${ROOT}/lib/chat-continue.ts";
export {
  contextFilesSystemPrompt,
  CHAT_ONLY_RESOURCE_LOADER_OPTIONS,
} from "${ROOT}/lib/chat-only.ts";
export {
  composeModelsData,
  loadScopedModelsData,
  saveScopedDefaultPreferences,
  parseDefaultPreferencesEdit,
  ProjectScopeShadowError,
  ModelNotAvailableError,
  EMPTY_MODELS,
} from "${ROOT}/lib/models-service.server.ts";
export {
  loadEnabledModelsView,
  applyEnabledModelsEdit,
  parseEnabledModelsMutation,
  EnabledModelsRefusalError,
} from "${ROOT}/lib/enabled-models-service.server.ts";
export { getTerminalSettings, setTerminalShell, resolveTerminalShell } from "${ROOT}/lib/terminal-settings.ts";
export { readRedactedModelsConfig } from "${ROOT}/lib/models-config-store.ts";
export { readDistroServiceStatus, applyDistroServiceConfig } from "${ROOT}/lib/distro/service-config.ts";
export { seedAgentDir } from "${ROOT}/lib/distro/seed.ts";
export { saveModelsConfig, ModelsConfigReadError } from "${ROOT}/lib/models-config-service.server.ts";
export {
  composeProviderLists,
  storeProviderApiKey,
  removeProviderApiKey,
  logoutProvider,
  ProviderAuthRefusalError,
} from "${ROOT}/lib/provider-auth-service.server.ts";
export {
  startLoginFlow,
  pollLoginFlow,
  submitLoginCode,
  cancelLoginFlow,
} from "${ROOT}/lib/provider-auth-login.server.ts";
export { loadModelsWithCache, invalidateModelsCache } from "${ROOT}/lib/models-cache.ts";
export { resolveVisibleModels } from "${ROOT}/lib/model-scope.ts";
export { projectTrustReloadOptions, getProjectTrustStatus } from "${ROOT}/lib/project-trust.ts";
export {
  queryModelCatalog,
  discoverModels,
  testModel,
  loadNonChatModels,
  refreshProviderCatalogs,
  queryProviderUsageReport,
} from "${ROOT}/lib/models-extras-service.server.ts";
export { loadSkillsWithInstallInfo } from "${ROOT}/lib/skills-service.ts";
export { setVisibleSkillsDisabled } from "${ROOT}/lib/skills-management.server.ts";
export { readPlugins, managePlugins } from "${ROOT}/lib/plugins-service.server.ts";
export { runPluginMutationTask } from "${ROOT}/lib/plugins-mutation-task.server.ts";
export { runSkillMutationTask } from "${ROOT}/lib/skills-mutation-task.server.ts";
export { searchSkills } from "${ROOT}/lib/skills-search.server.ts";
export { checkManagedPluginUpdates, checkManagedSkillUpdates } from "${ROOT}/lib/updates-management.server.ts";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
registerBunOAuthFlows();
export { validateCron, nextCronRuns, nextCronRun, systemTimezone } from "${ROOT}/lib/scheduled-tasks/cron.ts";
export { buildTask, applyTaskPatch } from "${ROOT}/lib/scheduled-tasks/task-input.ts";
export { decideSlot } from "${ROOT}/lib/scheduled-tasks/catch-up.ts";
export {
  McpServiceError,
  getMcpConfig,
  executeMcpAction,
  getProjectMcpListing,
  trustProjectFolder,
} from "${ROOT}/lib/mcp-service.server.ts";
export { probeMcpServer } from "${ROOT}/lib/mcp-probe-service.server.ts";
export { startManagedMcpSignIn, readManagedMcpSignIn, submitManagedMcpSignIn, cancelManagedMcpSignIn, waitManagedMcpSignIn } from "${ROOT}/lib/mcp-sign-in-service.server.ts";
`;

export const PROJECTION_MODULE_NAME = "pi-web-session-projection.mjs";

/** Bundle the projection entry; returns the output contents. */
export async function bundleProjectionModules() {
  const result = await build({
    stdin: {
      contents: ENTRY,
      resolveDir: ROOT,
      loader: "ts",
      sourcefile: "management-projection-entry.ts",
    },
    bundle: true,
    // Jiti resolves its Babel transformer relative to its own package; bundling
    // it relocates that lookup into the projection and breaks extensions.
    external: ["jiti"],
    format: "esm",
    platform: "node",
    target: "node20",
    // MCP internals and the public SDK must resolve from the same managed tree.
    external: ["@earendil-works/pi-coding-agent"],
    write: false,
    legalComments: "none",
    // The models seam (lib/models-service.ts) pulls in the SDK's CJS graph
    // (createAgentSessionServices → utils/child-process → cross-spawn), and
    // bundled CJS keeps its `require("child_process")` calls. In an ESM
    // output esbuild routes those to a shim that throws — so give the bundle
    // a real require bound to its own URL (the esbuild-documented pattern):
    // node builtins then load through the child's own runtime, which is the
    // same environment the pi SDK already runs in.
    banner: {
      js: `import { createRequire as __piWebProjectionCreateRequire } from "node:module";\nconst require = __piWebProjectionCreateRequire(import.meta.url);`,
    },
  });
  return result.outputFiles[0].text;
}

/** Build into a directory (creates it). Returns the written path. */
export async function buildProjectionInto(outDir) {
  const contents = await bundleProjectionModules();
  await mkdir(outDir, { recursive: true });
  const target = resolve(outDir, PROJECTION_MODULE_NAME);
  await writeFile(target, contents, "utf8");
  return target;
}

// --- CLI ---------------------------------------------------------------------

const args = process.argv.slice(2);
const check = args.includes("--check");
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : null;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!outDir) {
    console.error("usage: node scripts/migration/build-management-modules.mjs [--check] --out <dir>");
    process.exit(2);
  }
  let previous = null;
  if (check) {
    previous = await import("node:fs/promises")
      .then((fs) => fs.readFile(resolve(outDir, PROJECTION_MODULE_NAME), "utf8"))
      .catch(() => null);
  }
  const target = await buildProjectionInto(outDir);
  if (check) {
    const { readFile } = await import("node:fs/promises");
    const fresh = await readFile(target, "utf8");
    if (previous !== null && previous !== fresh) {
      console.error(`[build-management-modules] ${target} is stale (differs from a fresh build)`);
      await rm(target, { force: true });
      process.exit(1);
    }
    console.error(`[build-management-modules] ${target} up to date`);
  } else {
    console.error(`[build-management-modules] wrote ${target}`);
  }
}
