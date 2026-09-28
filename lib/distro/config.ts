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
  provider: {
    id: string;
    name: string;
    api: string;
    defaultModel: string;
    models: DistroModel[];
  };
  packages: string[];
  settingsDefaults: { defaultThinkingLevel?: string };
  webSearch: {
    baseUrlKey: string;
    apiKeyKey: string;
    defaults: Record<string, unknown>;
  };
  agentFiles: Record<string, unknown>;
}

export const DISTRO: DistroConfig = distroJson as unknown as DistroConfig;
