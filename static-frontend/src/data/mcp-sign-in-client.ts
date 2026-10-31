import { IpcClient, IpcFailure } from "../ipc/client.ts";
import type { McpSignInRequestResult } from "../../../components/mcp-sign-in-helpers";

let client: IpcClient | undefined;
export function bindMcpSignInClient(value: IpcClient): void { client = value; }

export async function requestMcpSignIn(url: string, init: RequestInit, signal: AbortSignal): Promise<McpSignInRequestResult> {
  if (signal.aborted) return { ok: false, error: { error: "The operation was aborted." } };
  if (!client) return { ok: false, error: { error: "MCP sign-in bridge is not configured" } };
  const method = init.method ?? "GET";
  const base = "/api/mcp/sign-in";
  let op: string;
  let args: Record<string, unknown>;
  if (url === base && method === "POST") {
    op = "mcp.signInStart";
    args = JSON.parse(String(init.body));
  } else {
    const flowId = decodeURIComponent(url.slice(base.length + 1));
    if (!url.startsWith(`${base}/`) || !flowId) return { ok: false, error: { error: "Invalid sign-in request" } };
    op = method === "GET" ? "mcp.signInStatus" : method === "DELETE" ? "mcp.signInCancel" : "mcp.signInSubmit";
    args = { flowId, ...(method === "POST" ? JSON.parse(String(init.body)) : {}) };
  }
  try {
    return { ok: true, data: await client.request<any>(op, args, { timeoutMs: 15_000 }) };
  } catch (error) {
    if (error instanceof IpcFailure) return { ok: false, error: { error: error.error.message, ...(error.error.reason ? { reason: error.error.reason as any } : {}), ...error.error.details } };
    return { ok: false, error: { error: error instanceof Error ? error.message : String(error) } };
  }
}
