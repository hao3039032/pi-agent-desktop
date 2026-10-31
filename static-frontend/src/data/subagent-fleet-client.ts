import { IpcClient } from "../ipc/client.ts";
import { detectTransport } from "./transport.ts";
import { normalizePiSubagentsSnapshot, normalizePiSubagentsTranscript, boundActionResult, type PiSubagentsStatusView } from "../../../lib/pi-subagents-view";

let client = new IpcClient(detectTransport().transport);

export function bindSubagentFleetClient(bound: IpcClient): void { client = bound; }

export async function fetchSubagentFleet(sessionId: string, signal?: AbortSignal): Promise<PiSubagentsStatusView> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const data = await client.request<Record<string, unknown>>("agent.subagentsStatus", { session: sessionId }, { timeoutMs: 40_000 });
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (data.available !== true) return data as unknown as PiSubagentsStatusView;
  return normalizePiSubagentsSnapshot(data.status as Record<string, unknown> | undefined, data.ping as Record<string, unknown> | undefined, { fallbackGeneratedAt: Date.now() });
}

export async function sendSubagentFleetAction(sessionId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ error?: string; reason?: string; [key: string]: unknown }> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const data = await client.request<{ action: string; runId: string; result: unknown }>("agent.subagentsAction", { session: sessionId, body }, { timeoutMs: 40_000 });
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (data.action === "inspect") {
    return { ok: true, action: "inspect", view: normalizePiSubagentsTranscript(data.runId, data.result as Record<string, unknown> | undefined, {
      lines: typeof body.lines === "number" ? body.lines : 80,
      ...(typeof body.index === "number" ? { index: body.index } : {}),
    }) };
  }
  return { ok: true, action: data.action, result: boundActionResult(data.result) };
}
