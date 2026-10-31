/**
 * The IPC-backed replacement for lib/agent-client.ts (M2 UI migration):
 * same exported surface — sendAgentCommand, AgentCommandError,
 * isPromptRejectedError — but every command travels the typed IPC bridge
 * (agent.command over pi_ipc) instead of POST /api/agent/[id]. Wired in the
 * static build through a vite alias; the Next app keeps the HTTP client
 * until M5.
 *
 * Error semantics preserved EXACTLY (the constructor argument order is the
 * original's): failures surface as AgentCommandError with (message, status,
 * code, accepted, instanceId); a prompt the host could not admit carries
 * code "prompt_rejected" + accepted false (isPromptRejectedError matches).
 */

import { IpcClient, IpcFailure, type IpcTransport } from "../ipc/client.ts";

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
    public readonly instanceId?: string,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

// The transport is injected (the app entry owns the single wiring point).
let client: IpcClient | null = null;

export function bindAgentClient(transport: IpcTransport): void {
  client = new IpcClient(transport);
}

function ensureClient(): IpcClient {
  if (client === null) {
    throw new AgentCommandError("the agent IPC bridge is not configured (bindAgentClient)", 0);
  }
  return client;
}

/** Map an IPC failure envelope onto the HTTP-shaped error the UI knows. */
function toAgentCommandError(failure: IpcFailure): AgentCommandError {
  const details = failure.error.details ?? {};
  const code = typeof details.code === "string" ? details.code : failure.error.code;
  const accepted = typeof details.accepted === "boolean" ? details.accepted : undefined;
  const instanceId = typeof details.instanceId === "string" ? details.instanceId : undefined;
  // The HTTP surface used 404 for a missing session and 500 for the rest;
  // the protocol codes carry the same distinction without HTTP numbers.
  const status = failure.error.code === "not_found" ? 404 : 500;
  // A prompt that was not admitted is the rejection the composer checks.
  const promptRejected = failure.error.code === "agent_spawn_failed"
    || failure.error.code === "agent_handshake_failed";
  return new AgentCommandError(
    failure.error.message,
    status,
    promptRejected ? "prompt_rejected" : code,
    promptRejected ? false : accepted,
    instanceId,
  );
}

/**
 * HOST-LEVEL commands the UI sends as agent commands but the HOST answers
 * (the wrapper's semantics): routed to their dedicated IPC ops instead of a
 * blind forward into the child (which would answer a wrong shape or fail
 * opaquely). Grows as the Rust host implements more of the wrapper surface.
 */
const HOST_LEVEL_COMMAND_OPS: Record<string, string> = {
  get_tools: "agent.getTools",
  extension_ui_response: "agent.respondUi",
};

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  // An aborted caller stops WAITING; the command itself may already be in
  // flight at the host (the protocol's rule: never resend blindly — the
  // abort never triggers a retry).
  if (options?.signal?.aborted) {
    throw new AgentCommandError("the command was aborted before it was sent", 0);
  }
  // A host-level command takes its dedicated op (the wrapper answered
  // these host-side; the child never saw them).
  const commandType = typeof command.type === "string" ? command.type : null;
  const hostOp = commandType !== null ? HOST_LEVEL_COMMAND_OPS[commandType] : undefined;
  let onAbort: (() => void) | null = null;
  const abort = new Promise<never>((_, reject) => {
    const signal = options?.signal;
    if (!signal) return;
    onAbort = () => reject(new AgentCommandError("the command was aborted", 0));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      hostOp !== undefined
        ? ensureClient().request<T>(
            hostOp,
            { ...command, session: sessionId },
            { timeoutMs: 60_000 },
          )
        // agent.command takes the closed command enum; the session id rides in
        // args (the Rust side correlates both).
        : ensureClient().request<T>(
            "agent.command",
            { ...command, session: sessionId },
            // Prompt-class commands legitimately run long: the child's run may
            // outlive the admission; the admission itself answers fast.
            { timeoutMs: 130_000 },
          ),
      abort,
    ]);
  } catch (caught) {
    if (caught instanceof AgentCommandError) throw caught;
    if (caught instanceof IpcFailure) throw toAgentCommandError(caught);
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new AgentCommandError(message, 0);
  } finally {
    // The request settled: stop holding the abort listener.
    if (onAbort !== null && options?.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}
