/**
 * The "China npm mirror" checkbox in the service dialog. The choice is
 * persisted as pi's `npmCommand` setting (settings.json), so pi's package
 * manager installs plugins through the mirror; the same registry is mirrored
 * into `process.env.npm_config_registry` so spawned `npx` (skill installs)
 * inherits it too. Pure helpers take the mirror URL explicitly for tests.
 */
import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { DISTRO } from "./config";
import { isRecord, readJsonObject } from "./json-file";

const REGISTRY_ENV_KEYS = ["npm_config_registry", "NPM_CONFIG_REGISTRY"] as const;

export function mirrorNpmCommand(mirrorUrl = DISTRO.npmMirrorUrl): string[] {
  return ["npm", "--registry", mirrorUrl];
}

/** True only for the exact command shape this module writes. */
export function isMirrorNpmCommand(command: unknown, mirrorUrl = DISTRO.npmMirrorUrl): boolean {
  return (
    Array.isArray(command) && command.length === 3 &&
    command[0] === "npm" && command[1] === "--registry" && command[2] === mirrorUrl
  );
}

/** What to write to settings for the requested checkbox state, if anything. */
export type NpmCommandPlan = { write: false } | { write: true; command?: string[] };

export function planNpmCommandChange(current: unknown, enabled: boolean, mirrorUrl = DISTRO.npmMirrorUrl): NpmCommandPlan {
  const isOurs = isMirrorNpmCommand(current, mirrorUrl);
  if (enabled) {
    // A custom npmCommand is replaced by an explicit checkbox choice.
    return isOurs ? { write: false } : { write: true, command: mirrorNpmCommand(mirrorUrl) };
  }
  // Only remove what we wrote; a custom command is left untouched.
  return isOurs ? { write: true, command: undefined } : { write: false };
}

export function applyNpmMirrorEnv(enabled: boolean, mirrorUrl = DISTRO.npmMirrorUrl): void {
  if (enabled) {
    process.env.npm_config_registry = mirrorUrl;
  } else if (process.env.npm_config_registry === mirrorUrl) {
    delete process.env.npm_config_registry;
  }
}

/** Startup: honor a registry the user set in the environment themselves. */
export function applyNpmMirrorEnvFromSettings(agentDir = getAgentDir()): void {
  if (!readNpmMirrorEnabled(agentDir)) return;
  if (REGISTRY_ENV_KEYS.some((key) => process.env[key])) return;
  process.env.npm_config_registry = DISTRO.npmMirrorUrl;
}

export function readNpmMirrorEnabled(agentDir = getAgentDir()): boolean {
  const settings = readJsonObject(join(agentDir, "settings.json"));
  return isRecord(settings) && isMirrorNpmCommand(settings.npmCommand);
}

/** Apply the checkbox state: settings write via SettingsManager + env toggle. */
export async function setNpmMirrorEnabled(enabled: boolean, agentDir = getAgentDir()): Promise<void> {
  const settingsManager = SettingsManager.create(agentDir, agentDir);
  const plan = planNpmCommandChange(settingsManager.getNpmCommand(), enabled);
  if (plan.write) settingsManager.setNpmCommand(plan.command);
  await settingsManager.flush();
  applyNpmMirrorEnv(enabled);
}
