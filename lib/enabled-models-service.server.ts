import { getAgentDir, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  clearEnabledModels,
  constrainProviderEntries,
  pruneStaleEnabledModels,
  renameModelPatterns,
  renameProviderPatterns,
  setModelsEnabled,
  type EnabledModelsEdit,
} from "./enabled-models";
import {
  buildEnabledModelsInput,
  buildEnabledModelsView,
  customProviderIds,
  modelRef,
  readEnabledModelsSettings,
  writeEnabledModels,
  type EnabledModelsView,
} from "./enabled-models-runtime";
import type { EnabledModelsInput, ProviderRename } from "./enabled-models";
import { createModelRuntimeWithExtensions } from "./model-runtime";
import { invalidateModelsCache } from "./models-cache";
import { EnabledModelsMutation, EnabledModelsRefusalError } from "./enabled-models-service";

// Server callers get the whole seam surface from one module (the client
// half re-exported beside the composition).
export { EnabledModelsRefusalError, parseEnabledModelsMutation } from "./enabled-models-service";
export type { EnabledModelsMutation } from "./enabled-models-service";

/**
 * The enabledModels service seam (migration M3), server half: the ONE
 * composition behind GET/PUT /api/models/enabled. Both backends run this
 * exact module — the Next route (app/api/models/enabled/route.ts) and the
 * management instance's `models.enabledGet` / `models.enabledSet` ops (the
 * esbuild projection in scripts/migration/build-management-modules.mjs
 * bundles this file). A drift between them is a contract break, so the route
 * and the extension ops are thin adapters, never a second copy of this logic.
 *
 * The edit engine (lib/enabled-models.ts) and the SDK resolver adapter
 * (lib/enabled-models-runtime.ts) are the unchanged layers underneath:
 * minimal edits, verified provider globs, stale-entry preservation, the
 * resync repair. Server-only by construction (the SDK's graph imports node
 * builtins at module top): the client-safe surface lives in
 * lib/enabled-models-service.ts.
 */

interface RequestContext {
  modelRuntime: ModelRuntime;
  models: readonly Model<Api>[];
  settingsManager: SettingsManager;
  /** Where the two settings files live, for the banner to name one. */
  paths: { cwd: string; agentDir: string };
}

async function loadContext(cwd: string): Promise<RequestContext> {
  const modelRuntime = await createModelRuntimeWithExtensions();
  const agentDir = getAgentDir();
  return {
    modelRuntime,
    models: await modelRuntime.getAvailable(),
    settingsManager: SettingsManager.create(cwd, agentDir),
    paths: { cwd, agentDir },
  };
}

async function buildView(context: RequestContext): Promise<EnabledModelsView> {
  const { patterns, scope, path } = readEnabledModelsSettings(context.settingsManager, context.paths);
  const input = await buildEnabledModelsInput(patterns, context.models);
  const providerNames = new Map(
    context.modelRuntime.getProviders().map((provider) => [provider.id, provider.name]),
  );
  const modelError = context.modelRuntime.getError();
  return buildEnabledModelsView({
    input,
    models: context.models,
    providerNames,
    customProviders: customProviderIds(context.modelRuntime),
    scope,
    settingsPath: path,
    ...(modelError ? { modelError } : {}),
  });
}

/** GET /api/models/enabled's body for an EXISTING, allowed cwd. */
export async function loadEnabledModelsView(cwd: string): Promise<EnabledModelsView> {
  return buildView(await loadContext(cwd));
}

/**
 * Repair the stored patterns after models.json changed under the panel.
 *
 * A pattern's meaning depends on the catalog, and the catalog just moved: a
 * provider rename can make its glob reach into another provider (pi matches
 * patterns against the bare model id too, so `stepfun/*` also matches
 * `commandcode`'s `stepfun/Step-5-Preview`), and renaming a model to an id with
 * a slash drops it out of `provider/*` entirely. So re-resolve, cut entries
 * back to the provider their prefix names, and restore the providers that were
 * fully enabled before the save.
 */
async function resyncAfterModelsConfigSave(
  context: RequestContext,
  input: EnabledModelsInput,
  options: {
    renames: readonly ProviderRename[];
    modelRenames: readonly ProviderRename[];
    fullyEnabled: readonly string[];
  },
): Promise<EnabledModelsEdit> {
  const { renames, modelRenames, fullyEnabled } = options;
  const original = input.patterns;
  // Model references first: they still carry the old provider id, which the
  // provider rewrite below would otherwise have replaced already.
  const renamed = renameProviderPatterns(renameModelPatterns(original, modelRenames), renames);
  let current = renamed === original
    ? input
    : await buildEnabledModelsInput(renamed, context.models, { withProviderGlobs: true });

  const constrained = constrainProviderEntries(current);
  if (constrained.ok && constrained.changed) {
    current = await buildEnabledModelsInput(constrained.patterns, context.models, { withProviderGlobs: true });
  }

  // A provider that was fully enabled before the save stays fully enabled, even
  // when a model of it was renamed out of the glob that used to cover it.
  const refs = fullyEnabled
    .map((id) => renames.find((rename) => rename.from === id)?.to ?? id)
    .flatMap((id) => context.models.filter((model) => model.provider === id).map(modelRef));
  const edit = setModelsEnabled(current, refs, true);
  if (!edit.ok) return edit;
  return { ok: true, patterns: edit.patterns, changed: !samePatternList(edit.patterns, original) };
}

function samePatternList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((pattern, index) => pattern === b[index]);
}

/**
 * PUT /api/models/enabled's shared body: one serialized mutation of the
 * global `enabledModels` (a minimal edit for every op; `resync` is the only
 * repair). Refusals throw EnabledModelsRefusalError (the route's 409s; the
 * management protocol's `project_scope` / `last_model` codes); a successful
 * write invalidates the cached model scope and resolves with the fresh view.
 */
export async function applyEnabledModelsEdit(
  cwd: string,
  mutation: EnabledModelsMutation,
): Promise<EnabledModelsView> {
  const context = await loadContext(cwd);
  const { patterns, scope } = readEnabledModelsSettings(context.settingsManager, context.paths);
  if (scope === "project") {
    throw new EnabledModelsRefusalError(
      "project-scope",
      "Project settings override enabledModels",
    );
  }

  const input = await buildEnabledModelsInput(patterns, context.models, { withProviderGlobs: true });
  let edit: EnabledModelsEdit;
  if (mutation.op === "clear") {
    edit = clearEnabledModels(input);
  } else if (mutation.op === "prune") {
    edit = pruneStaleEnabledModels(input);
  } else if (mutation.op === "resync") {
    edit = await resyncAfterModelsConfigSave(context, input, mutation);
  } else {
    let refs: string[];
    if (mutation.op === "provider") {
      // Resolved server-side so a provider switched on stays on for models
      // the browser has not seen yet.
      refs = context.models
        .filter((model) => model.provider === mutation.provider)
        .map(modelRef);
    } else {
      refs = mutation.refs;
    }
    edit = setModelsEnabled(input, refs, mutation.enabled === true);
  }

  if (!edit.ok) {
    throw new EnabledModelsRefusalError("last-model", "At least one model must stay enabled");
  }
  if (edit.changed) {
    await writeEnabledModels(context.settingsManager, edit.patterns);
    invalidateModelsCache();
  }

  return buildView(context);
}
