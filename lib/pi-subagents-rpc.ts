/**
 * Thin client for the pi-subagents package's in-process event-bus RPC
 * (`subagents:rpc:v1`, documented in the package's docs/extension-api.md as
 * the public seam for host integrations).
 *
 * Pi Web never imports the package's internals: it talks to the extension that
 * is already loaded in the parent AgentSession, over that session's extension
 * event bus (`pi.events`), which `startRpcSession()` creates and owns
 * (`lib/rpc-manager.ts`). Only read/control methods are modelled here;
 * `spawn`, `resume`, `manage` and `cost` are intentionally not exported —
 * `app/api/agent/[id]/subagents` must not become a launch surface.
 */

/** The subset of the SDK's `EventBus` the client needs (structural, for tests). */
export interface SubagentEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

/** Only the methods the restricted API may call. The package also offers spawn/resume/manage/cost. */
export type SubagentRpcMethod = "ping" | "status" | "steer" | "interrupt" | "stop";

export const SUBAGENT_RPC_METHODS: readonly SubagentRpcMethod[] = [
  "ping",
  "status",
  "steer",
  "interrupt",
  "stop",
];

/** The package's documented error codes (`SubagentRpcError` in its src/extension/rpc.js). */
export type SubagentRpcErrorCode =
  | "invalid_request"
  | "invalid_params"
  | "unsupported_version"
  | "unsupported_method"
  | "no_active_session"
  | "not_found"
  | "invalid_state"
  | "execution_failed"
  | (string & {});

export interface SubagentRpcReply<T = unknown> {
  requestId: string;
  method?: string;
  data?: T;
  error?: { code: SubagentRpcErrorCode; message: string };
}

/** The extension did not answer within the deadline (not installed in this session, hung, or an incompatible version). */
export class SubagentRpcTimeoutError extends Error {
  constructor(method: SubagentRpcMethod, timeoutMs: number) {
    super(`pi-subagents RPC '${method}' received no reply within ${timeoutMs} ms`);
    this.name = "SubagentRpcTimeoutError";
  }
}

/**
 * The session's engine cannot forward this RPC at all: an older shipped bridge
 * asset has no `subagents.*` op. That is NOT evidence the package is missing —
 * the caller must report `unknown`, never `not-loaded`.
 */
export class SubagentRpcUnsupportedError extends Error {
  constructor(detail: string) {
    super(`this session cannot forward pi-subagents RPC: ${detail}`);
    this.name = "SubagentRpcUnsupportedError";
  }
}

/**
 * Where a restricted call actually goes. On the CLI engine the package lives in
 * the pi child, so the bridge forwards to that child's event bus; the
 * in-process event-bus transport stays for engines that own the bus themselves
 * and for tests.
 */
export interface SubagentRpcTransport {
  readonly kind: "bridge" | "event-bus";
  call(
    method: SubagentRpcMethod,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<SubagentRpcReply>;
}

/** The transport over this process's own extension event bus. */
export function createEventBusSubagentTransport(bus: SubagentEventBus): SubagentRpcTransport {
  return {
    kind: "event-bus",
    call: (method, params, options) => callSubagentRpc(bus, method, params, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    }),
  };
}

/** The reply body the bridge forwards: the package's answer without its ids. */
export interface SubagentBridgeReplyBody {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

/**
 * The transport over the child's bridge op (`subagents.<method>`). `request`
 * rejects only when the transport failed; a reply the package refused comes
 * back as `{ success: false, error }` and is forwarded verbatim.
 */
export function createBridgeSubagentTransport(
  request: (method: SubagentRpcMethod, params: Record<string, unknown> | undefined, options: { timeoutMs?: number; signal?: AbortSignal }) => Promise<SubagentBridgeReplyBody>,
): SubagentRpcTransport {
  return {
    kind: "bridge",
    async call(method, params, options) {
      let body: SubagentBridgeReplyBody;
      try {
        body = await request(method, params, {
          ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        });
      } catch (error) {
        // An older bridge asset knows no subagents ops; every other failure is
        // a transport fault with its own message.
        if (error instanceof Error && /unknown bridge op/.test(error.message)) {
          throw new SubagentRpcUnsupportedError(error.message);
        }
        throw error;
      }
      if (typeof body !== "object" || body === null) {
        throw new Error(`pi-subagents bridge reply for '${method}' was not an object`);
      }
      if (body.success === true) return { requestId: "", ...(body.data !== undefined ? { data: body.data } : {}) };
      if (body.success === false && body.error && typeof body.error.code === "string") {
        return { requestId: "", error: { code: body.error.code, message: String(body.error.message ?? "").slice(0, 2_000) } };
      }
      throw new Error(`pi-subagents bridge reply for '${method}' carried neither data nor an error`);
    },
  };
}

export const SUBAGENT_RPC_PING_TIMEOUT_MS = 3_000;
export const SUBAGENT_RPC_CALL_TIMEOUT_MS = 20_000;

export interface SubagentRpcCallOptions {
  timeoutMs?: number;
  /** Overrides the generated id; a non-empty string without newlines (the package rejects others). */
  requestId?: string;
  /** Cancels the exchange and removes its reply listener. */
  signal?: AbortSignal;
}

function randomRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `pi-web-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * One request/reply exchange on `bus`. The listener is scoped to this
 * request's reply channel, verified against the reply's `requestId`, and
 * removed again whether the call settles, fails, or times out, so a long-lived
 * session bus never accumulates listeners.
 */
export function callSubagentRpc(
  bus: SubagentEventBus,
  method: SubagentRpcMethod,
  params?: Record<string, unknown>,
  options: SubagentRpcCallOptions = {},
): Promise<SubagentRpcReply> {
  const requestId = options.requestId ?? randomRequestId();
  const timeoutMs = options.timeoutMs ?? SUBAGENT_RPC_CALL_TIMEOUT_MS;
  const replyChannel = `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;

  return new Promise<SubagentRpcReply>((resolve, reject) => {
    let settled = false;
    let off: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      off?.();
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => settle(() => reject(options.signal?.reason instanceof Error
      ? options.signal.reason
      : new DOMException("Subagent RPC request aborted", "AbortError")));

    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    try {
      off = bus.on(replyChannel, (raw) => {
        const reply = parseSubagentRpcReply(raw, requestId);
        // Ignore anything that is not a well-formed reply for this request and
        // keep waiting: a malformed or foreign payload must not end the call.
        if (!reply) return;
        settle(() => resolve(reply));
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        settle(() => reject(new SubagentRpcTimeoutError(method, timeoutMs)));
      }, timeoutMs);

      bus.emit(SUBAGENT_RPC_REQUEST_EVENT, {
        version: SUBAGENT_RPC_PROTOCOL_VERSION,
        requestId,
        method,
        ...(params !== undefined ? { params } : {}),
      });
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

/**
 * Validate a raw reply payload against the documented reply shape:
 * `{ version: 1, requestId, method?, success: true, data }` or
 * `{ version: 1, requestId, method?, success: false, error: { code, message } }`.
 * Returns null when the payload does not belong to `requestId` or is not a
 * well-formed reply, so the caller can keep waiting for the real one.
 */
export function parseSubagentRpcReply(raw: unknown, requestId: string): SubagentRpcReply | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const reply = raw as Record<string, unknown>;
  // The bridge stamps every reply with the protocol version; a payload without
  // it (or with another version) is not a v1 reply and must not settle the call.
  if (reply.version !== SUBAGENT_RPC_PROTOCOL_VERSION) return null;
  if (reply.requestId !== requestId) return null;
  if (typeof reply.success !== "boolean") return null;
  if (reply.method !== undefined && typeof reply.method !== "string") return null;
  if (reply.success) {
    return {
      requestId,
      ...(typeof reply.method === "string" ? { method: reply.method } : {}),
      ...(reply.data !== undefined ? { data: reply.data } : {}),
    };
  }
  const error = reply.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const errorRecord = error as Record<string, unknown>;
  if (typeof errorRecord.code !== "string" || typeof errorRecord.message !== "string") return null;
  return {
    requestId,
    ...(typeof reply.method === "string" ? { method: reply.method } : {}),
    error: {
      code: errorRecord.code,
      message: errorRecord.message.slice(0, 2_000),
    },
  };
}

/** The HTTP status the restricted API answers an RPC error with. */
export function subagentRpcErrorStatus(code: string): number {
  switch (code) {
    case "invalid_params":
    case "invalid_request":
    case "unsupported_method":
    case "unsupported_version":
      return 400;
    case "not_found":
      return 404;
    case "invalid_state":
    case "no_active_session":
      return 409;
    default:
      return 500;
  }
}
