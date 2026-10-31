/**
 * The MCP service seam (migration M3), client half: the Settings › MCP
 * overview read and configuration actions (add, remove, switch, exposure, undo).
 * Client-safe by construction (types + the HTTP implementations only);
 * the composition itself runs on the server (or in the management instance).
 *
 * The static build swaps this module for the IPC implementation
 * (static-frontend/src/data/mcp-service.ts).
 */

import type {
  McpActionRequest,
  McpActionResult,
  McpLoadResult,
  McpTestRequestResult,
  FetchLike,
} from "@/components/mcp-config-helpers";

export async function postMcpTest(body: Record<string, unknown>, signal?: AbortSignal): Promise<McpTestRequestResult> {
  try {
    const response = await fetch("/api/mcp/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal });
    const data = await response.json();
    return response.ok ? { ok: true, data } : { ok: false, error: data };
  } catch (error) {
    return { ok: false, error: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export const MCP_GET_TIMEOUT_MS = 15_000;
export const MCP_ACTION_TIMEOUT_MS = 15_000;

export async function fetchMcpOverview(
  cwd?: string | null,
  signal?: AbortSignal,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  timeoutMs: number = MCP_GET_TIMEOUT_MS,
): Promise<McpLoadResult> {
  const url = cwd ? `/api/mcp?cwd=${encodeURIComponent(cwd)}` : "/api/mcp";
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url, {
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    return { ok: false, error: { error: error instanceof Error ? error.message : String(error) } };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: { error: `HTTP ${response.status}` } };
  }
  if (response.ok && data && typeof data === "object") {
    return { ok: true, data: data as any };
  }
  return {
    ok: false,
    error: {
      error: (data as { error?: string })?.error ?? `HTTP ${response.status}`,
      reason: (data as { reason?: any })?.reason,
    },
  };
}

export async function postMcpAction(
  request: McpActionRequest,
  cwd?: string | null,
  signal?: AbortSignal,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  timeoutMs: number = MCP_ACTION_TIMEOUT_MS,
): Promise<McpActionResult> {
  const body: Record<string, unknown> = { ...request, ...(cwd ? { cwd } : {}) };
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl("/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    return { ok: false, error: { error: error instanceof Error ? error.message : String(error) } };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: { error: `HTTP ${response.status}` } };
  }
  if (response.ok && data && typeof data === "object") {
    return { ok: true, data: data as any };
  }
  return {
    ok: false,
    error: {
      error: (data as { error?: string })?.error ?? `HTTP ${response.status}`,
      reason: (data as { reason?: any })?.reason,
      ...((data && typeof data === "object") ? data : {}),
    },
  };
}
