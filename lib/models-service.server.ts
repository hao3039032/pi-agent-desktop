import { createAgentSessionServices, getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { loadModelsWithCache, invalidateModelsCache, withModelRuntimeError, withSafeModelLoadFailure, type ModelsData } from "./models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { projectTrustReloadOptions } from "./project-trust";
import { isChatWorkspacePath } from "./chat-workspace";
import { readChatSettings, resolveChatStartDefaults } from "./chat-settings";
import {
  projectSettingsPath,
  shadowingProjectKeys,
  writeDefaultPreferences,
} from "./default-preferences";
import {
  ModelNotAvailableError,
  ProjectScopeShadowError,
  parseDefaultPreferencesEdit,
  type DefaultPreferencesEditRequest,
} from "./models-service";

// Server callers get the whole seam surface from one module (the client
// half re-exported beside the composition).
export { ModelNotAvailableError, ProjectScopeShadowError, parseDefaultPreferencesEdit };

/**
 * The models service seam (migration M3), server half: the ONE composition
 * that answers "which models does the selector offer, and which is default"
 * for a cwd. Both backends run this exact module — the Next route
 * (app/api/models/route.ts) and the management instance's `models.list` op
 * (the esbuild projection in scripts/migration/build-management-modules.mjs
 * bundles this file). A drift between them is a contract break, so the route
 * and the extension op are thin adapters, never a second copy of this logic.
 *
 * Server-only by construction (the SDK's graph imports node builtins at
 * module top): the client-safe surface — types, parse, the shaped refusals'
 * classes and the HTTP/IPC call implementations — lives in
 * lib/models-service.ts, which "use client" modules import.
 *
 * The composition loads the FULL model scope the way the server always
 * did: createAgentSessionServices (project trust honored — enumerating
 * models still imports and runs a repository's .pi/extensions factories,
 * #236), the CLI's own `enabledModels` resolution (#307), thinking levels
 * per model, and a chat cwd's Settings › Chats start defaults.
 */

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string },
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

/** The `/api/models` body for an EXISTING, allowed cwd. */
export async function composeModelsData(cwd: string): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  const agentDir = getAgentDir();
  // Gate untrusted project extensions: enumerating models still imports and
  // runs a repository's .pi/extensions factories, so honor project trust here
  // too (see lib/project-trust.ts, #236).
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManager = services.settingsManager;
  // `enabledModels` supports globs and fuzzy patterns, so resolve it the same
  // way the CLI does instead of comparing pattern strings literally (#307).
  const scope = await resolveVisibleModels(
    services.modelRuntime,
    settings.getEnabledModels(),
  );
  const { visible, thinkingLevelPins, warnings } = scope;
  modelList = visible.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    input: m.input,
  })).sort(compareModelEntries);
  for (const m of visible) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = getSupportedThinkingLevels(m);
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
  }

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  // A new chat starts on the model and reasoning level chosen in Settings › Chats, so the
  // composer must show the same ones the server will start with.
  const chatStart = isChatWorkspacePath(cwd)
    ? resolveChatStartDefaults(readChatSettings(), visible)
    : {};
  const initial = selectInitialModelScope(scope, {
    ...(chatStart.requestedModel ? { requestedModel: chatStart.requestedModel } : {}),
    ...(chatStart.thinkingLevel ? { thinkingLevel: chatStart.thinkingLevel } : {}),
    ...(defaultProvider && defaultModelId
      ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
      : {}),
  });
  if (initial.model) {
    defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
  }
  const defaultThinkingLevel = initial.thinkingLevel
    ?? (initial.model
      ? settings.getModelThinkingLevel(initial.model.provider, initial.model.id)
      : undefined)
    ?? settings.getDefaultThinkingLevel()
    ?? null;

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      defaultThinkingLevel,
      savedDefaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins,
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
    },
    modelError,
  );
}

/** The empty-but-valid answer a load failure degrades to (the route's shape). */
export const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  defaultThinkingLevel: null,
  savedDefaultThinkingLevel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

/** `composeModelsData` wrapped in the cache + failure degradation (the route's exact answer). */
export async function loadScopedModelsData(cwd: string): Promise<ModelsData> {
  try {
    return await loadModelsWithCache(cwd, () => composeModelsData(cwd));
  } catch {
    return withSafeModelLoadFailure(EMPTY_MODELS);
  }
}

/**
 * PUT /api/models/default's shared body: the selectors' star, the ONLY writer
 * of the global default model / thinking level. Validation order is the
 * contract: a project settings.json that shadows the value refuses with
 * ProjectScopeShadowError (the route answers 409), a model outside the cwd's
 * enabled scope refuses with ModelNotAvailableError (404); a successful write
 * invalidates the cached model scope.
 */
export async function saveScopedDefaultPreferences(
  cwd: string,
  edit: DefaultPreferencesEditRequest,
): Promise<{ model?: { provider: string; modelId: string }; thinkingLevel?: string }> {
  const agentDir = getAgentDir();
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const parsed = "provider" in edit
    ? { model: { provider: edit.provider, modelId: edit.modelId } }
    : { thinkingLevel: edit.thinkingLevel };

  const shadowed = shadowingProjectKeys(services.settingsManager, parsed);
  if (shadowed.length > 0) {
    throw new ProjectScopeShadowError(projectSettingsPath(cwd), shadowed);
  }
  if (parsed.model) {
    // Only a model the selector can offer is a default that actually takes
    // effect: startup falls back to the first scoped model otherwise.
    const scope = await resolveVisibleModels(
      services.modelRuntime,
      services.settingsManager.getEnabledModels(),
    );
    const { provider, modelId } = parsed.model;
    if (!scope.visible.some((model) => model.provider === provider && model.id === modelId)) {
      throw new ModelNotAvailableError(provider, modelId);
    }
  }
  await writeDefaultPreferences(services.settingsManager, parsed);
  invalidateModelsCache();
  return parsed;
}
