import type { McpRefusalReason, ToolSettingsResponse } from "./api-types";
import {
  CODEMODE_INLINE_BUDGET_MAX,
  isCodemodeInlineBudget,
  isCodemodeMode,
  isCodemodePreference,
  readCodemodePreference,
  readCodemodeSettings,
  writeCodemodeInlineBudget,
  writeCodemodeMode,
  writeCodemodePreference,
} from "./codemode-settings";
import { getGlobalSettingsPath } from "./global-settings-file";
import {
  readPowerShellToolEnabled,
  writePowerShellToolEnabled,
} from "./powershell-settings";

export class ToolSettingsRefusalError extends Error {
  public readonly status: number;
  public readonly reason: McpRefusalReason;

  constructor(status: number, reason: McpRefusalReason, message: string) {
    super(message);
    this.name = "ToolSettingsRefusalError";
    this.status = status;
    this.reason = reason;
  }
}

const CHANGES = ["enabled", "codemode", "codemodeMode", "codemodeInlineBudget"] as const;

export async function readToolSettings(
  settingsPath = getGlobalSettingsPath(),
  platform: NodeJS.Platform = process.platform,
): Promise<ToolSettingsResponse> {
  const powerShellEnabled = await readPowerShellToolEnabled(settingsPath, platform);
  const codemode = await readCodemodePreference(settingsPath);
  const { mode: codemodeMode, inlineBudget: codemodeInlineBudget } = await readCodemodeSettings(settingsPath);
  return {
    isWindows: platform === "win32",
    powerShellEnabled,
    codemode,
    codemodeMode,
    codemodeInlineBudget,
  };
}

export async function applyToolSettingsChange(
  body: unknown,
  settingsPath = getGlobalSettingsPath(),
  platform: NodeJS.Platform = process.platform,
): Promise<ToolSettingsResponse> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ToolSettingsRefusalError(400, "invalid-request", "Expected a JSON object");
  }
  const changes = body as {
    enabled?: unknown;
    codemode?: unknown;
    codemodeMode?: unknown;
    codemodeInlineBudget?: unknown;
  };
  if (CHANGES.filter((key) => key in changes).length !== 1) {
    throw new ToolSettingsRefusalError(
      400,
      "invalid-request",
      "Send one of enabled (PowerShell), codemode, codemodeMode or codemodeInlineBudget",
    );
  }

  if ("codemodeMode" in changes) {
    if (!isCodemodeMode(changes.codemodeMode)) {
      throw new ToolSettingsRefusalError(400, "invalid-request", 'codemodeMode must be "on" or "only"');
    }
    await writeCodemodeMode(changes.codemodeMode, settingsPath);
    return readToolSettings(settingsPath, platform);
  }

  if ("codemodeInlineBudget" in changes) {
    const budget = changes.codemodeInlineBudget;
    if (budget !== null && !isCodemodeInlineBudget(budget)) {
      throw new ToolSettingsRefusalError(
        400,
        "invalid-request",
        `codemodeInlineBudget must be a whole number from 0 to ${CODEMODE_INLINE_BUDGET_MAX}, or null`,
      );
    }
    await writeCodemodeInlineBudget(budget ?? undefined, settingsPath);
    return readToolSettings(settingsPath, platform);
  }

  if ("codemode" in changes) {
    if (!isCodemodePreference(changes.codemode)) {
      throw new ToolSettingsRefusalError(400, "invalid-request", 'codemode must be "automatic" or "always"');
    }
    await writeCodemodePreference(changes.codemode, settingsPath);
    return readToolSettings(settingsPath, platform);
  }

  if (platform !== "win32") {
    throw new ToolSettingsRefusalError(
      404,
      "invalid-request",
      "PowerShell tool settings are only available on Windows",
    );
  }

  if (typeof changes.enabled !== "boolean") {
    throw new ToolSettingsRefusalError(400, "invalid-request", "enabled must be a boolean");
  }
  await writePowerShellToolEnabled(changes.enabled, settingsPath, platform);
  return readToolSettings(settingsPath, platform);
}
