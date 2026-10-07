/**
 * Distribution overlay (fork-owned). Everything that makes this build "the LW
 * distribution" instead of plain pi-agent-desktop is described by
 * `distro/distro.json`; see docs/distro.md.
 */
import distroJson from "../../distro/distro.json";

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
    defaultModel: string;
    models: DistroModel[];
  };
  packages: string[];
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
   * owning extension reads and migrates them itself, e.g. pi-plan-vanguard). */
  legacyAgentFiles?: Record<string, string[]>;
}

export const DISTRO: DistroConfig = distroJson as unknown as DistroConfig;

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
