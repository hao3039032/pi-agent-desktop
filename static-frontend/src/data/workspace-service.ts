/**
 * The IPC-backed workspace service (the static build's alias target for
 * lib/workspace-service.ts): the hidden chat root, cwd validation and the
 * scratch default cwd travel the typed IPC bridge (chats.workspaceState /
 * cwd.validate / cwd.createDefault over pi_ipc) instead of the HTTP routes.
 * Same exported surface and error-text contract (the pickers surface
 * `error.message` directly).
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type { ValidatedCwd } from "../../../lib/workspace-service";

let client: IpcClient | null = null;

export function bindWorkspaceService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) throw new Error("the workspace service IPC bridge is not configured (bindWorkspaceService)");
  return client;
}

function toError(caught: unknown, fallback: string): Error {
  if (caught instanceof IpcFailure) return new Error(caught.error.message || fallback);
  return caught instanceof Error ? caught : new Error(String(caught));
}

/** The hidden cwd used by non-project chats, created on demand. */
export async function fetchChatWorkspaceRoot(_options: { signal?: AbortSignal } = {}): Promise<string> {
  void _options;
  try {
    const data = await ensureClient().request<{ cwd?: string }>("chats.workspaceState", undefined, { timeoutMs: 15_000 });
    if (!data.cwd) throw new Error("the host answered no chat workspace cwd");
    return data.cwd;
  } catch (caught) {
    throw toError(caught, "Failed to resolve the chat workspace");
  }
}

/**
 * Validate a candidate workspace. The host owns normalization, existence,
 * readability and the file allow-list grant — this side never widens
 * roots. Rejects with the host's error text (same text the HTTP route
 * answered, which the pickers display).
 */
export async function validateWorkspaceCwd(
  cwd: string,
  _options: { signal?: AbortSignal } = {},
): Promise<ValidatedCwd> {
  void _options;
  try {
    return await ensureClient().request<ValidatedCwd>("cwd.validate", { cwd }, { timeoutMs: 20_000 });
  } catch (caught) {
    throw toError(caught, "Failed to validate the directory");
  }
}

/**
 * Create ~/pi-cwd/&lt;local YYYYMMDD&gt; on demand. The caller selects the
 * path through validateWorkspaceCwd afterwards — never directly.
 */
export async function createDefaultWorkspaceCwd(): Promise<string> {
  try {
    const data = await ensureClient().request<{ cwd?: string }>("cwd.createDefault", undefined, { timeoutMs: 15_000 });
    if (!data.cwd) throw new Error("the host answered no default cwd");
    return data.cwd;
  } catch (caught) {
    throw toError(caught, "Failed to create the default directory");
  }
}
