/**
 * Distribution overlay (fork-owned). Everything that makes this build "the LW
 * distribution" instead of plain pi-agent-desktop is described by
 * `distro/distro.json`; see docs/distro.md.
 */
import distroJson from "../../distro/distro.json";
import { isRecord } from "./json-file";

export interface DistroModel {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface DistroConfig {
  id: string;
  revision: number;
  defaultBaseUrl: string;
  /** Registry the "China npm mirror" checkbox writes into settings/env. */
  npmMirrorUrl: string;
  provider: {
    id: string;
    name: string;
    api: string;
    /** Provider-level compat defaults for the distro gateway (session-affinity
     * headers today). Filled in only where absent by mergeDistroProviderCompat:
     * a value the user already chose (a deliberate `false`, a different
     * format) is never overwritten. No `$comment` keys here — everything in
     * this object flows into the user's models.json provider compat. */
    compat?: Record<string, unknown>;
    defaultModel: string;
    models: DistroModel[];
  };
  /** Pi resource packages registered in the user's settings. */
  packages: string[];
  /** Bundled dependencies only: installed, but never registered as Pi packages. */
  runtimePackages?: string[];
  settingsDefaults: {
    defaultThinkingLevel?: string;
    /** Seeded once, only when the user's settings.json carries no `defaultTools`
     * of their own; `+codemode` starts every session with Code mode active
     * (classifier/image models need it, see lib/codemode-settings.ts). */
    defaultTools?: string[];
  };
  webSearch: {
    baseUrlKey: string;
    apiKeyKey: string;
    /** Optional Exa fallback connection for pi-web-access (`provider: "exa"`,
     * an on-demand user choice — the default provider stays `gemini`). The
     * gateway proxies Exa's native endpoints at `<service baseUrl> + suffix`
     * and authenticates with the platform key, never an upstream Exa key.
     * Deliberately not part of `defaults`: those re-merge on every save. */
    exaFallback?: {
      baseUrlKey: string;
      apiKeyKey: string;
      baseUrlSuffix: string;
    };
    defaults: Record<string, unknown>;
  };
  /** pi-model-images 0.2+ ships the imagegen CLI as a skill; its config file
   * gets the same service address in OpenAI form (`…` + suffix) and key so
   * image generation works without extra setup. */
  imageGen?: {
    configFile: string;
    baseUrlSuffix: string;
  };
  /** JSON files written into the agent dir on first run (missing files only). */
  agentFiles: Record<string, unknown>;
  /** Raw text files written into the agent dir on first run (e.g. WATCHDOG.yml). */
  agentTextFiles?: Record<string, string>;
  /** File → legacy file names whose presence must suppress seeding (the
   * owning extension reads and migrates them itself; unused since the
   * plan extension left the bundle, kept for the next package that needs
   * the same guard). */
  legacyAgentFiles?: Record<string, string[]>;
}

export const DISTRO: DistroConfig = distroJson as unknown as DistroConfig;

/** Merge the distro provider's compat defaults into a provider entry's
 * existing compat, filling in only keys that are absent — an explicit value
 * the user set (a deliberate `false`, a different format) always wins, per
 * the session-affinity handover rule "never silently drop an explicit
 * setting". Returns the original object reference when nothing is missing,
 * `undefined` when neither side has anything, so callers can keep the
 * provider entry's shape untouched. */
export function mergeDistroProviderCompat(existing: unknown): Record<string, unknown> | undefined {
  const base = isRecord(existing) ? existing : undefined;
  const defaults = DISTRO.provider.compat;
  if (!defaults) return base;
  if (!base) return { ...defaults };
  const missing = Object.entries(defaults).filter(([key]) => !(key in base));
  if (missing.length === 0) return base;
  return { ...base, ...Object.fromEntries(missing) };
}

/** Update distro models by id, while retaining every other existing model. */
export function mergeDistroModels(existingModels: unknown, distroModels: DistroModel[]): DistroModel[] {
  const byId = new Map(distroModels.map((model) => [model.id, model]));
  const merged: DistroModel[] = [];
  const seen = new Set<string>();
  const existing = Array.isArray(existingModels) ? existingModels : [];

  for (const value of existing) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const id = (value as { id?: unknown }).id;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    merged.push(byId.get(id) ?? value as DistroModel);
    seen.add(id);
  }
  for (const model of distroModels) {
    if (!seen.has(model.id)) merged.push(model);
  }
  return merged;
}

/**
 * Rebase per-model absolute baseUrls that point at the distro's default
 * service onto `baseUrl` (the one the user configured), keeping any suffix
 * (`https://…/v1beta` → `https://custom/v1beta`). Model entries without a
 * baseUrl, or pointing elsewhere, pass through untouched. Without this a
 * user who changed the service address would still send one model's traffic
 * to the default one.
 */
export function rebaseDistroModelUrls(
  models: DistroModel[],
  baseUrl: string,
  defaultBase = DISTRO.defaultBaseUrl,
): DistroModel[] {
  if (!baseUrl || baseUrl === defaultBase) return models;
  return models.map((model) =>
    typeof model.baseUrl === "string" && model.baseUrl.startsWith(defaultBase)
      ? { ...model, baseUrl: baseUrl.replace(/\/+$/, "") + model.baseUrl.slice(defaultBase.length) }
      : model,
  );
}

/**
 * The OpenAI-style base the imagegen CLI needs (`{base}/images/generations`):
 * the service address with the distro's suffix appended unless it already
 * ends with it (`https://gw.example` → `https://gw.example/v1`,
 * `https://gw.example/v1/` → `https://gw.example/v1`).
 */
export function imageGenBaseUrl(
  baseUrl: string,
  suffix = DISTRO.imageGen?.baseUrlSuffix ?? "/v1",
): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.endsWith(suffix) ? base : base + suffix;
}
