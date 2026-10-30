/**
 * The IPC-backed replacement for lib/agent-client.ts (M2 UI migration):
 * same exported surface — sendAgentCommand, AgentCommandError,
 * isPromptRejectedError — but every command travels the typed IPC bridge
 * (agent.command over pi_ipc) instead of POST /api/agent/[id]. Wired in the
 * static build through a vite alias; the Next app keeps the HTTP client
 * until M5.
 *
 * Error semantics preserved: failures surface as AgentCommandError with a
 * code (the protocol envelope's code — same names the HTTP layer used for
 * the shared paths), and `accepted` stays undefined (the prompt admission
 * protocol arrives with the full prompt flow).
 */

import { IpcClient, IpcFailure, type IpcTransport } from "../ipc/client.ts";

export class AgentCommandError extends Error {
  public readonly code?: string;
  public readonly accepted?: boolean;
  public readonly status?: number;
  public readonly instanceId?: string;

  constructor(
    message: string,
    code?: string,
    accepted?: boolean,
    status?: number,
    instanceId?: string,
  ) {
    super(message);
    this.name = "AgentCommandError";
    this.code = code;
    this.accepted = accepted;
    this.status = status;
    this.instanceId = instanceId;
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return (
    error instanceof AgentCommandError &&
    error.code === "prompt_rejected" &&
    error.accepted === false
  );
}

// The transport is injected (the app entry owns the single wiring point).
let client: IpcClient | null = null;

export function bindAgentClient(transport: IpcTransport): void {
  client = new IpcClient(transport);
}

function ensureClient(): IpcClient {
  if (client === null) {
    throw new AgentCommandError("the agent IPC bridge is not configured (bindAgentClient)");
  }
  return client;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  _options?: { signal?: AbortSignal },
): Promise<T> {
  try {
    // agent.command takes the closed command enum; the session id rides in
    // args (the Rust side correlates both).
    return await ensureClient().request<T>(
      "agent.command",
      { ...command, session: sessionId },
      // Prompt-class commands legitimately run long: the child's run may
      // outlive the admission; the admission itself answers fast.
      { timeoutMs: 130_000 },
    );
  } catch (caught) {
    const failure = caught instanceof IpcFailure ? caught : null;
    if (failure) {
      const instanceId =
        typeof failure.error.details?.instanceId === "string"
          ? (failure.error.details.instanceId as string)
          : undefined;
      throw new AgentCommandError(
        failure.error.message,
        failure.error.code,
        undefined,
        undefined,
        instanceId,
      );
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new AgentCommandError(message);
  }
}
