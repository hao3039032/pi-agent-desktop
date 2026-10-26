import { join } from "node:path";
import { CONFIG_DIR_NAME, DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PROJECT_SETTINGS_MAX_BYTES, readRegularFileText } from "./regular-file";

// The built-in extensions a `pi` child prepends under the CLI's names (ADR
// 0006, "Loading"): since the CLI-engine migration every session loads them in
// the child, and Settings resolves the `extensions` switches for exactly these
// names, so `-builtin:<name>`, project overrides, and replacement by a
// third-party extension that registers `/mcp`, `codemode`, or `tool_search`
// read as in the CLI. `llama.cpp` is not among them: it serves a local model
// server, not a feature of the session. The Code mode sandbox itself runs in
// the bundled pi distribution; nothing in this server process executes it.

export const MCP_DISABLE_VARIABLE = "PI_WEB_DISABLE_MCP";

/**
 * Whether the operator turned MCP off for the whole server. Any value other
 * than empty, `0`, or `false` counts: a switch that guards a server should not
 * be undone by spelling `yes` instead of `1`.
 */
export function isMcpDisabledByOperator(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment[MCP_DISABLE_VARIABLE]?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

export const BUILTIN_EXTENSION_NAMES = ["codemode", "tool-search", "mcp"] as const;
export type BuiltinExtensionName = typeof BUILTIN_EXTENSION_NAMES[number];

export interface BuiltinExtensionSwitch {
  enabled: boolean;
  /** The settings file whose `extensions` entry turns it off. */
  settingsPath?: string;
  /**
   * What the global settings alone make of it. Present only when a trusted
   * project's `extensions` list was read; otherwise the switch itself is the
   * global answer. A global setting, such as Code mode's Always on, is weighed
   * against this, never against whichever project Settings was opened from.
   */
  global?: { enabled: boolean; settingsPath?: string };
}

/**
 * A settings file's `extensions` list, read as SettingsManager reads it: a
 * byte-order mark is allowed, and a file that does not parse counts as empty.
 * A FIFO or a device there throws instead of blocking the server on a read
 * nothing answers, as does a project file past `PROJECT_SETTINGS_MAX_BYTES`.
 */
function readSettingsExtensions(path: string, maxBytes?: number): string[] | undefined {
  const text = readRegularFileText(path, maxBytes);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undefined;
  }
  const extensions = typeof parsed === "object" && parsed !== null ? (parsed as { extensions?: unknown }).extensions : undefined;
  return Array.isArray(extensions) ? extensions.filter((entry): entry is string => typeof entry === "string") : undefined;
}

type SettingsScope = "global" | "project";

async function resolveBuiltinSwitches(
  options: { agentDir: string; cwd: string; projectTrusted: boolean },
  lists: Partial<Record<SettingsScope, string[]>>,
  paths: Record<SettingsScope, string>,
): Promise<Record<BuiltinExtensionName, BuiltinExtensionSwitch>> {
  const { agentDir, cwd, projectTrusted } = options;
  const storage: Parameters<typeof SettingsManager.fromStorage>[0] = {
    withLock: (scope, fn) => {
      const extensions = lists[scope];
      fn(extensions ? JSON.stringify({ extensions }) : undefined);
    },
  };
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: SettingsManager.fromStorage(storage, { projectTrusted }),
    builtinExtensions: [...BUILTIN_EXTENSION_NAMES],
  });
  // Nothing is missing without packages; skip rather than install if that ever changes.
  const resolved = await packageManager.resolve(async () => "skip");
  const switches = {} as Record<BuiltinExtensionName, BuiltinExtensionSwitch>;
  for (const name of BUILTIN_EXTENSION_NAMES) {
    const resource = resolved.extensions.find((extension) => extension.path === `builtin:${name}`);
    const enabled = resource?.enabled ?? true;
    switches[name] = enabled
      ? { enabled }
      : { enabled, settingsPath: resource?.metadata.scope === "project" ? paths.project : paths.global };
  }
  return switches;
}

/**
 * Whether the `extensions` settings leave each built-in on, read from the
 * files as the session's resource loader would: `-builtin:mcp` (or a `!`
 * pattern matching it) in the global settings turns it off, and a matching
 * `+`, `-` or `!` entry in a trusted project's settings overrides that. The
 * SDK's package manager decides, so its pattern rules apply exactly; it is
 * given only the two `extensions` lists, never `packages`, so it cannot
 * install or even look up a package. It still scans the extension, skill,
 * prompt and theme folders it auto-discovers, which only reads them. When a
 * trusted project has a list of its own, the global list is resolved a second
 * time on its own for each switch's `global` answer.
 */
export async function readBuiltinExtensionSwitches(options: {
  agentDir: string;
  /** Without one, only the global settings count. */
  cwd?: string;
  projectTrusted: boolean;
}): Promise<Record<BuiltinExtensionName, BuiltinExtensionSwitch>> {
  const { agentDir } = options;
  const projectTrusted = options.cwd !== undefined && options.projectTrusted;
  const cwd = options.cwd ?? agentDir;
  const paths = {
    global: join(agentDir, "settings.json"),
    project: join(cwd, CONFIG_DIR_NAME, "settings.json"),
  };
  const global = readSettingsExtensions(paths.global);
  // The project file is the repository's, read by a GET: capped, and never a FIFO.
  const project = projectTrusted ? readSettingsExtensions(paths.project, PROJECT_SETTINGS_MAX_BYTES) : undefined;
  const switches = await resolveBuiltinSwitches({ agentDir, cwd, projectTrusted }, { global, project }, paths);
  if (project === undefined) return switches;
  const globalSwitches = await resolveBuiltinSwitches({ agentDir, cwd, projectTrusted: false }, { global }, paths);
  for (const name of BUILTIN_EXTENSION_NAMES) switches[name].global = globalSwitches[name];
  return switches;
}
