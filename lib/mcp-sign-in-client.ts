import type { McpSignInRequestResult } from "@/components/mcp-sign-in-helpers";

export async function requestMcpSignIn(url: string, init: RequestInit, signal: AbortSignal): Promise<McpSignInRequestResult> {
  try {
    const response = await fetch(url, { ...init, cache: "no-store", signal });
    const data = await response.json();
    return response.ok ? { ok: true, data } : { ok: false, error: data };
  } catch (error) {
    return { ok: false, error: { error: error instanceof Error ? error.message : String(error) } };
  }
}
