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
export function projectionEntry(root = ROOT) {
  const importRoot = JSON.stringify(root).slice(1, -1);
  return `
export { SessionManager as projectionSessionManager } from "@earendil-works/pi-coding-agent";
export { McpOAuthProvider as projectionMcpOAuthProvider, MemoryOAuthStateStore as projectionMemoryOAuthStateStore } from "@earendil-works/pi-mcp/oauth";
export { signInMcpWithHostedCallback } from "${importRoot}/lib/mcp-oauth-hosted.server.ts";
export {
  buildSessionContext,
  sliceActiveBranch,
  getLatestModelChange,
  getLatestResponseModel,
} from "${importRoot}/lib/session-projection.ts";
export { projectTreeForResponse, toSummaryTree } from "${importRoot}/lib/project-tree.ts";
export { computeSessionStats } from "${importRoot}/lib/session-stats.ts";
export { extractActiveSystemPrompt } from "${importRoot}/lib/system-prompt-snapshot.ts";
export { isBashOutputPathReferencedByEntries, isValidSessionId } from "${importRoot}/lib/session-file-references-core.ts";
export { resolveBashOutputPath } from "${importRoot}/lib/bash-output.ts";
export { searchSessionContents } from "${importRoot}/lib/session-search.ts";
export { isFilePathReferencedByEntries } from "${importRoot}/lib/session-file-references-core.ts";
export { formatSessionReference } from "${importRoot}/lib/session-reference.ts";
export { patchExportHtml } from "${importRoot}/lib/session-export-html.ts";
export { computeSessionTotalActiveMs } from "${importRoot}/lib/session-timing.ts";
export {
  readSubagentRun,
  SUBAGENT_META_TYPE,
} from "${importRoot}/lib/subagents.ts";
export {
  readSessionToolSelection,
  validateSessionToolSelection,
} from "${importRoot}/lib/session-tool-selection.ts";
export { chatWorkspacePrompt } from "${importRoot}/lib/chat-workspace-prompt.ts";
export { copyChatToProject, setOfflineChatUnlock } from "${importRoot}/lib/chat-continue.ts";
export {
  contextFilesSystemPrompt,
  CHAT_ONLY_RESOURCE_LOADER_OPTIONS,
} from "${importRoot}/lib/chat-only.ts";
export {
  composeModelsData,
  loadScopedModelsData,
  saveScopedDefaultPreferences,
  parseDefaultPreferencesEdit,
  ProjectScopeShadowError,
  ModelNotAvailableError,
  EMPTY_MODELS,
} from "${importRoot}/lib/models-service.server.ts";
export {
  loadEnabledModelsView,
  applyEnabledModelsEdit,
  parseEnabledModelsMutation,
  EnabledModelsRefusalError,
} from "${importRoot}/lib/enabled-models-service.server.ts";
export { getTerminalSettings, setTerminalShell, resolveTerminalShell } from "${importRoot}/lib/terminal-settings.ts";
export { readRedactedModelsConfig } from "${importRoot}/lib/models-config-store.ts";
export { readDistroServiceStatus, applyDistroServiceConfig } from "${importRoot}/lib/distro/service-config.ts";
export { seedAgentDir } from "${importRoot}/lib/distro/seed.ts";
export { saveModelsConfig, ModelsConfigReadError } from "${importRoot}/lib/models-config-service.server.ts";
export {
  composeProviderLists,
  storeProviderApiKey,
  removeProviderApiKey,
  logoutProvider,
  ProviderAuthRefusalError,
} from "${importRoot}/lib/provider-auth-service.server.ts";
export {
  startLoginFlow,
  pollLoginFlow,
  submitLoginCode,
  cancelLoginFlow,
} from "${importRoot}/lib/provider-auth-login.server.ts";
export { loadModelsWithCache, invalidateModelsCache } from "${importRoot}/lib/models-cache.ts";
export { resolveVisibleModels } from "${importRoot}/lib/model-scope.ts";
export { projectTrustReloadOptions, getProjectTrustStatus } from "${importRoot}/lib/project-trust.ts";
export {
  queryModelCatalog,
  discoverModels,
  testModel,
  loadNonChatModels,
  refreshProviderCatalogs,
  queryProviderUsageReport,
} from "${importRoot}/lib/models-extras-service.server.ts";
export { loadSkillsWithInstallInfo } from "${importRoot}/lib/skills-service.ts";
export { setVisibleSkillsDisabled } from "${importRoot}/lib/skills-management.server.ts";
export { readPlugins, managePlugins } from "${importRoot}/lib/plugins-service.server.ts";
export { runPluginMutationTask } from "${importRoot}/lib/plugins-mutation-task.server.ts";
export { runSkillMutationTask } from "${importRoot}/lib/skills-mutation-task.server.ts";
export { searchSkills } from "${importRoot}/lib/skills-search.server.ts";
export { checkManagedPluginUpdates, checkManagedSkillUpdates } from "${importRoot}/lib/updates-management.server.ts";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
registerBunOAuthFlows();
export { validateCron, nextCronRuns, nextCronRun, systemTimezone } from "${importRoot}/lib/scheduled-tasks/cron.ts";
export { buildTask, applyTaskPatch } from "${importRoot}/lib/scheduled-tasks/task-input.ts";
export { decideSlot } from "${importRoot}/lib/scheduled-tasks/catch-up.ts";
export {
  McpServiceError,
  getMcpConfig,
  executeMcpAction,
  managedMcpCredentialTarget,
  signOutMcpCooperative,
  getProjectMcpListing,
  trustProjectFolder,
} from "${importRoot}/lib/mcp-service.server.ts";
export { probeMcpServer, managedMcpProbeTarget } from "${importRoot}/lib/mcp-probe-service.server.ts";
export { startManagedMcpSignIn, readManagedMcpSignIn, submitManagedMcpSignIn, cancelManagedMcpSignIn, waitManagedMcpSignIn, McpOAuthBroker } from "${importRoot}/lib/mcp-sign-in-service.server.ts";
`;

}
export const PROJECTION_MODULE_NAME = "pi-web-session-projection.mjs";
export const TITLE_MODULE_NAME = "pi-web-session-title.mjs";

export function titleEntry(root = ROOT) {
  return `export { generateSessionTitleFromRegistry } from ${JSON.stringify(`${root}/lib/session-title.ts`)};`;
}

/** Only pure title logic and the SDK's two pure transcript/model helpers may survive tree shaking. */
export async function bundleTitleModule() {
  const result = await build({
    stdin: { contents: titleEntry(), resolveDir: ROOT, loader: "ts" },
    bundle: true, format: "esm", platform: "node", target: "node20", write: false, metafile: true, legalComments: "none",
  });
  const outputs = Object.values(result.metafile.outputs);
  if (outputs.length !== 1) throw new Error("unexpected title helper output");
  const allowed = ["/lib/session-title.ts", "/@earendil-works/pi-ai/dist/models.js", "/@earendil-works/pi-ai/dist/utils/transcript.js"];
  for (const [name, info] of Object.entries(outputs[0].inputs)) {
    if (info.bytesInOutput > 0 && name !== "lib/session-title.ts" && !allowed.some((suffix) => name.replaceAll("\\", "/").endsWith(suffix))) {
      throw new Error(`unexpected title helper dependency: ${name}`);
    }
  }
  return result.outputFiles[0].text;
}

/** Bundle the projection entry; returns the output contents. */
export async function bundleProjectionModules({ sdkRuntime = false } = {}) {
  const result = await build({
    stdin: {
      contents: projectionEntry(),
      resolveDir: ROOT,
      loader: "ts",
      sourcefile: "management-projection-entry.ts",
    },
    bundle: true,
    // The extension loader resolves the SDK's public specifier to its own
    // virtual module in the compiled pi; never bundle a second SDK graph.
    format: "esm",
    platform: "node",
    target: "node20",
    // MCP internals and the public SDK must resolve from the same managed tree.
    external: sdkRuntime ? ["jiti", "@earendil-works/*"] : ["jiti", "@earendil-works/pi-coding-agent", "@earendil-works/pi-mcp/oauth"],
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
export async function buildProjectionInto(outDir, options) {
  const contents = await bundleProjectionModules(options);
  await mkdir(outDir, { recursive: true });
  const target = resolve(outDir, PROJECTION_MODULE_NAME);
  await writeFile(target, contents, "utf8");
  await writeFile(resolve(outDir, TITLE_MODULE_NAME), await bundleTitleModule(), "utf8");
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
  let previousTitle = null;
  if (check) {
    previousTitle = await import("node:fs/promises").then((fs) => fs.readFile(resolve(outDir, TITLE_MODULE_NAME), "utf8")).catch(() => null);
    previous = await import("node:fs/promises")
      .then((fs) => fs.readFile(resolve(outDir, PROJECTION_MODULE_NAME), "utf8"))
      .catch(() => null);
  }
  const target = await buildProjectionInto(outDir, { sdkRuntime: args.includes("--sdk-runtime") });
  if (check) {
    const { readFile } = await import("node:fs/promises");
    const fresh = await readFile(target, "utf8");
    const freshTitle = await readFile(resolve(outDir, TITLE_MODULE_NAME), "utf8");
    if ((previous !== null && previous !== fresh) || (previousTitle !== null && previousTitle !== freshTitle)) {
      console.error(`[build-management-modules] ${target} is stale (differs from a fresh build)`);
      await rm(target, { force: true });
      process.exit(1);
    }
    console.error(`[build-management-modules] ${target} up to date`);
  } else {
    console.error(`[build-management-modules] wrote ${target}`);
  }
}
