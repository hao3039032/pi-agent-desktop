/**
 * The static app's project-trust client (the vite alias for
 * `@/lib/project-trust-client`): `trust.status` and `trust.set` over IPC —
 * the Rust host's port of `getProjectTrustStatus`, the project's MCP listing,
 * and the trust write path.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type {
  ProjectTrustMutationResult,
  ProjectTrustOverviewResult,
  ProjectTrustStatusResult,
} from "../../../lib/project-trust-client";
import type { ProjectTrustResponse, ProjectTrustStatus, McpRefusalReason } from "../../../lib/api-types";

let boundClient: IpcClient | null = null;

export function bindProjectTrustClient(client: IpcClient): void {
  boundClient = client;
}

function ensureClient(): IpcClient {
  if (boundClient === null) {
    throw new Error("the project-trust IPC bridge is not configured (bindProjectTrustClient)");
  }
  return boundClient;
}

export async function fetchProjectTrustStatus(
  cwd: string,
  signal?: AbortSignal,
): Promise<ProjectTrustStatusResult> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  const status = await ensureClient().request<ProjectTrustStatus>(
    "trust.status",
    { cwd },
  );
  return { ok: true, ...status };
}

export async function fetchProjectTrustOverview(
  cwd: string,
  signal?: AbortSignal,
): Promise<ProjectTrustOverviewResult> {
  if (signal?.aborted) {
    return {
      ok: false,
      status: 0,
      data: { error: "The operation was aborted." },
    };
  }
  try {
    const data = await ensureClient().request<ProjectTrustResponse>(
      "trust.status",
      { cwd },
    );
    return { ok: true, status: 200, data };
  } catch (error) {
    let msg = error instanceof Error ? error.message : String(error);
    let reason: McpRefusalReason | undefined = undefined;
    if (error instanceof IpcFailure) {
      msg = error.error.message || msg;
      reason = (error.error as { reason?: McpRefusalReason }).reason;
    }
    return {
      ok: false,
      status: 500,
      data: { error: msg, ...(reason ? { reason } : {}) },
    };
  }
}

export async function setProjectTrust(
  cwd: string,
  signal?: AbortSignal,
): Promise<ProjectTrustMutationResult> {
  if (signal?.aborted) {
    return {
      ok: false,
      status: 0,
      data: { error: "The operation was aborted." },
    };
  }
  try {
    const data = await ensureClient().request<ProjectTrustStatus>(
      "trust.set",
      { cwd },
    );
    return { ok: true, status: 200, data };
  } catch (error) {
    let msg = error instanceof Error ? error.message : String(error);
    let reason: McpRefusalReason | undefined = undefined;
    if (error instanceof IpcFailure) {
      msg = error.error.message || msg;
      reason = (error.error as { reason?: McpRefusalReason }).reason;
    }
    return {
      ok: false,
      status: 409,
      data: { error: msg, ...(reason ? { reason } : {}) },
    };
  }
}
