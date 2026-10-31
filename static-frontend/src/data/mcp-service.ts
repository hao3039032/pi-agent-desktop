/**
 * The IPC-backed MCP service (the static build's alias target for
 * lib/mcp-service.ts): Settings › MCP overview and actions go through
 * mcp.configGet and mcp.configAction over pi_ipc.
 */

import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type {
  McpActionRequest,
  McpActionResult,
  McpLoadResult,
  McpTestRequestResult,
  FetchLike,
} from "../../../components/mcp-config-helpers";

let client: IpcClient | null = null;

export function bindMcpService(bound: IpcClient): void {
  client = bound;
}

function ensureClient(): IpcClient {
  if (client === null) {
    throw new Error("the mcp service IPC bridge is not configured (bindMcpService)");
  }
  return client;
}

export async function postMcpTest(body: Record<string, unknown>, signal?: AbortSignal): Promise<McpTestRequestResult> {
  if (signal?.aborted) return { ok: false, error: { error: "The operation was aborted." } };
  try {
    const data = await ensureClient().request<any>("mcp.test", body, { timeoutMs: 60_000 });
    return { ok: true, data };
  } catch (error) {
    if (error instanceof IpcFailure) return { ok: false, error: { error: error.error.message, ...(error.error.reason ? { reason: error.error.reason as any } : {}), ...error.error.details } };
    return { ok: false, error: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export async function fetchMcpOverview(
  cwd?: string | null,
  signal?: AbortSignal,
  _fetchImpl?: FetchLike,
  timeoutMs: number = 15_000,
): Promise<McpLoadResult> {
  if (signal?.aborted) {
    return { ok: false, error: { error: "The operation was aborted." } };
  }
  try {
    const data = await ensureClient().request<any>(
      "mcp.configGet",
      cwd ? { cwd } : {},
      { timeoutMs },
    );
    return { ok: true, data };
  } catch (error) {
    let msg = error instanceof Error ? error.message : String(error);
    let reason: any = undefined;
    if (error instanceof IpcFailure) {
      msg = error.error.message || msg;
      reason = (error.error as { reason?: any }).reason;
    }
    return { ok: false, error: { error: msg, ...(reason ? { reason } : {}) } };
  }
}

export async function postMcpAction(
  request: McpActionRequest,
  cwd?: string | null,
  signal?: AbortSignal,
  _fetchImpl?: FetchLike,
  timeoutMs: number = 15_000,
): Promise<McpActionResult> {
  if (signal?.aborted) {
    return { ok: false, error: { error: "The operation was aborted." } };
  }
  const body: Record<string, unknown> = { ...request, ...(cwd ? { cwd } : {}) };
  try {
    const data = await ensureClient().request<any>(
      "mcp.configAction",
      body,
      { timeoutMs },
    );
    return { ok: true, data };
  } catch (error) {
    let msg = error instanceof Error ? error.message : String(error);
    let reason: any = undefined;
    let extra: Record<string, unknown> = {};
    if (error instanceof IpcFailure) {
      msg = error.error.message || msg;
      reason = (error.error as { reason?: any }).reason;
      if (typeof error.error === "object" && error.error !== null) {
        extra = error.error.details ?? {};
      }
    }
    return { ok: false, error: { error: msg, ...(reason ? { reason } : {}), ...extra } };
  }
}
