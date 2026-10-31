/**
 * The tool settings service seam (migration M3), client half: presets,
 * Code mode, PowerShell, and inline budget settings.
 *
 * Client-safe by construction (types + the HTTP implementations only);
 * the server composition is lib/tool-settings-service.server.ts.
 * The static build swaps this module for the IPC implementation
 * (static-frontend/src/data/tool-settings-service.ts).
 */

import type {
  CodemodeMode,
  McpCodemodePreference,
  McpRefusalReason,
  ToolSettingsResponse,
} from "./api-types";

export type { ToolSettingsResponse };

export type ToolSettingsChange =
  | { codemode: McpCodemodePreference }
  | { codemodeMode: CodemodeMode }
  | { codemodeInlineBudget: number | null }
  | { enabled: boolean };

export class ToolSettingsError extends Error {
  public readonly reason?: McpRefusalReason;
  public readonly status?: number;

  constructor(message: string, reason?: McpRefusalReason, status?: number) {
    super(message);
    this.name = "ToolSettingsError";
    this.reason = reason;
    this.status = status;
  }
}

/** The tool settings load (HTTP implementation). */
export async function fetchToolSettings(): Promise<ToolSettingsResponse> {
  const res = await fetch("/api/tools/settings");
  const data = await res.json() as ToolSettingsResponse & { error?: string; reason?: McpRefusalReason };
  if (!res.ok || data.error) {
    throw new ToolSettingsError(data.error ?? `HTTP ${res.status}`, data.reason, res.status);
  }
  return data;
}

/** Apply one tool settings change (HTTP implementation). */
export async function saveToolSettings(change: ToolSettingsChange): Promise<ToolSettingsResponse> {
  const res = await fetch("/api/tools/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
    cache: "no-store",
  });
  const data = await res.json() as ToolSettingsResponse & { error?: string; reason?: McpRefusalReason };
  if (!res.ok || data.error) {
    throw new ToolSettingsError(data.error ?? `HTTP ${res.status}`, data.reason, res.status);
  }
  return data;
}
