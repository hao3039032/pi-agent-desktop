/**
 * The IPC protocol types (docs/migration/ipc-protocol.md), shared by the
 * static frontend and (from M2) the Rust host's TypeScript definitions.
 * Frozen at protocol version 1.
 */

/** Protocol version of the request/response envelope. */
export const IPC_PROTOCOL_VERSION = 1 as const;

/** One request (WebView → Rust). */
export interface IpcRequest {
  v: typeof IPC_PROTOCOL_VERSION;
  /** Client-generated, monotonically increasing, single-use. */
  id: string;
  /** A named operation from the closed enum (docs/migration/api-inventory.json). */
  op: string;
  args?: Record<string, unknown>;
}

/** Stable machine-readable error codes (see the protocol doc). */
export const IPC_ERROR_CODES = [
  "unknown_op",
  "version_mismatch",
  "invalid_args",
  "unauthorized_scope",
  "not_found",
  "busy",
  "timeout",
  "no_host",
  "not_supported",
  "agent_child_exited",
  "agent_child_timeout",
  "agent_child_error",
  "agent_spawn_failed",
  "agent_handshake_failed",
  "management_unavailable",
  "io",
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  /** Existing business reason / i18n key, preserved from the HTTP routes. */
  reason?: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface IpcOk {
  v: typeof IPC_PROTOCOL_VERSION;
  id: string;
  ok: true;
  data: unknown;
}

export interface IpcErr {
  v: typeof IPC_PROTOCOL_VERSION;
  id: string;
  ok: false;
  error: IpcError;
}

export type IpcResponse = IpcOk | IpcErr;

/** A stream message over a Tauri Channel (subscription frames). */
export interface IpcStreamMessage<T = unknown> {
  subscriptionId: string;
  /** Host epoch: increments when the host resets; consumers must re-snapshot. */
  epoch: number;
  /** Monotonic per subscription, starting at 1. */
  seq: number;
  kind: "snapshot" | "event" | "reset";
  payload: T;
}

/** Result of parsing a raw response into the envelope. */
export type IpcParseResult =
  | { ok: true; response: IpcOk }
  | { ok: false; error: IpcError };

/**
 * Parse and validate one response envelope. Unknown fields are tolerated;
 * a wrong version, a mismatched id or a malformed error is a protocol
 * failure the client surfaces as `version_mismatch`/`invalid_args`.
 */
export function parseIpcResponse(raw: unknown, expectedId: string): IpcParseResult {
  if (typeof raw !== "object" || raw === null) {
    return invalid("the response is not an object");
  }
  const candidate = raw as Partial<IpcResponse> & { error?: Partial<IpcError> };
  if (candidate.v !== IPC_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: {
        code: "version_mismatch",
        message: `the host speaks protocol ${String(candidate.v)}, the frontend ${IPC_PROTOCOL_VERSION}`,
        retryable: false,
        details: { hostVersion: candidate.v },
      },
    };
  }
  if (candidate.id !== expectedId) {
    return invalid(`the response id ${JSON.stringify(candidate.id)} does not match ${JSON.stringify(expectedId)}`);
  }
  if (candidate.ok === true) {
    return { ok: true, response: { v: IPC_PROTOCOL_VERSION, id: expectedId, ok: true, data: candidate.data } };
  }
  if (candidate.ok === false) {
    const error = candidate.error;
    if (typeof error !== "object" || error === null || typeof error.code !== "string") {
      return invalid("the error envelope has no code");
    }
    const code = (IPC_ERROR_CODES as readonly string[]).includes(error.code)
      ? (error.code as IpcErrorCode)
      : "io";
    return {
      ok: false,
      error: {
        code,
        message: typeof error.message === "string" ? error.message : String(code),
        ...(typeof error.reason === "string" ? { reason: error.reason } : {}),
        retryable: error.retryable === true,
        ...(isRecord(error.details) ? { details: error.details } : {}),
      },
    };
  }
  return invalid("the envelope has no ok flag");
}

function invalid(message: string): IpcParseResult {
  return { ok: false, error: { code: "invalid_args", message, retryable: false } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
