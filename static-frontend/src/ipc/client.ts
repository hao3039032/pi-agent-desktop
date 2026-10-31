/**
 * The typed IPC client. The ONLY low-level wiring entry lives here (the
 * migration plan: `lib/desktop-native.ts` 的新位置 — this module): everything
 * else in the frontend calls domain methods, never the raw transport.
 *
 * Transport is injectable:
 * - `TauriIpcTransport` — `window.__TAURI_INTERNALS__.invoke("pi_ipc", …)`
 *   from M2, when the Rust host registers the command;
 * - `MockTransport` — deterministic tests and the M1 boot page diagnostics.
 *
 * Semantics frozen by the protocol doc:
 * - timeouts never auto-resend (an operation may still have happened);
 * - ids are monotonic and single-use;
 * - an unknown operation fails as `unknown_op`; there is no generic
 *   execution escape hatch.
 */

import {
  IPC_PROTOCOL_VERSION,
  type IpcError,
  type IpcRequest,
  type IpcResponse,
  type IpcStreamMessage,
  parseIpcResponse,
} from "./protocol.ts";

export interface IpcTransport {
  /** Send one request envelope; resolves with the raw response value. */
  send(request: IpcRequest, timeoutMs: number): Promise<unknown>;
  /** Open one subscription stream; returns a disposer. */
  subscribe(
    op: string,
    args: Record<string, unknown> | undefined,
    onMessage: (message: IpcStreamMessage) => void,
    onError: (error: IpcError) => void,
  ): () => void;
}

export class IpcTimeoutError extends Error {
  public readonly op: string;
  public readonly requestId: string;

  constructor(op: string, requestId: string) {
    super(`ipc '${op}' timed out; the operation may still have happened — never resend blindly`);
    this.name = "IpcTimeoutError";
    this.op = op;
    this.requestId = requestId;
  }
}

export class IpcFailure extends Error {
  public readonly op: string;
  public readonly error: IpcError;

  constructor(op: string, error: IpcError) {
    super(`ipc '${op}' failed (${error.code}): ${error.message}`);
    this.name = "IpcFailure";
    this.op = op;
    this.error = error;
  }
}

export class IpcClient {
  private counter = 0;
  private readonly pending = new Set<string>();
  private readonly transport: IpcTransport;

  constructor(transport: IpcTransport) {
    this.transport = transport;
  }

  /** The closed operation surface (per domain, as the M2+ wiring lands). */
  request<T = unknown>(
    op: string,
    args?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    const requestId = `ipc-${++this.counter}-${Date.now().toString(36)}`;
    if (this.pending.has(requestId)) throw new Error("ipc ids are single-use");
    this.pending.add(requestId);
    const request: IpcRequest = {
      v: IPC_PROTOCOL_VERSION,
      id: requestId,
      op,
      ...(args === undefined ? {} : { args }),
    };
    const timeoutMs = options?.timeoutMs ?? 30_000;
    return this.transport
      .send(request, timeoutMs)
      .then((raw): T => {
        const parsed = parseIpcResponse(raw, requestId);
        if (parsed.ok) return parsed.response.data as T;
        throw new IpcFailure(op, parsed.error);
      })
      .finally(() => this.pending.delete(requestId));
  }

  subscribe<T = unknown>(
    op: string,
    args: Record<string, unknown> | undefined,
    onMessage: (message: IpcStreamMessage<T>) => void,
    onError: (error: IpcError) => void,
  ): () => void {
    return this.transport.subscribe(op, args, onMessage as (message: IpcStreamMessage) => void, onError);
  }
}

/** A deterministic in-memory transport for tests and the boot diagnostics. */
export class MockTransport implements IpcTransport {
  private handlers = new Map<string, (args?: Record<string, unknown>) => unknown>();
  private streams = new Map<string, (message: IpcStreamMessage) => void>();
  private nextId = 0;

  on(op: string, handler: (args?: Record<string, unknown>) => unknown): this {
    this.handlers.set(op, handler);
    return this;
  }

  /** Test seam: answer every request for an op with a protocol failure
   *  envelope (the host's error codes, not a thrown exception). `reason`
   *  models the envelope's preserved business reason (the HTTP routes'
   *  refusal bodies), e.g. the enabledModels write path's 409s. */
  fail(op: string, error: { code: string; message: string; reason?: string }): this {
    this.handlers.set(op, () => {
      throw new MockFailure(error);
    });
    return this;
  }

  send(request: IpcRequest, timeoutMs: number): Promise<unknown> {
    const handler = this.handlers.get(request.op);
    if (handler === undefined) {
      return Promise.resolve(failure(request.id, "unknown_op", `no handler for '${request.op}'`));
    }
    let result: unknown;
    try {
      result = handler(request.args);
    } catch (error) {
      if (error instanceof MockFailure) {
        return Promise.resolve(failure(request.id, error.error.code as IpcError["code"], error.error.message, error.error.reason));
      }
      return Promise.resolve(
        failure(request.id, "invalid_args", error instanceof Error ? error.message : String(error)),
      );
    }
    if (isPromise(result)) {
      return withTimeout(result, timeoutMs, request);
    }
    return Promise.resolve(success(request.id, result));
  }

  subscribe(
    op: string,
    _args: Record<string, unknown> | undefined,
    onMessage: (message: IpcStreamMessage) => void,
    onError: (error: IpcError) => void,
  ): () => void {
    if (!this.handlers.has(op)) {
      onError({ code: "unknown_op", message: `no stream handler for '${op}'`, retryable: false });
      return () => {};
    }
    const id = `sub-${++this.nextId}`;
    this.streams.set(id, onMessage);
    return () => this.streams.delete(id);
  }

  /** Test seam: deliver one stream message to the last subscription. */
  emit(message: IpcStreamMessage): void {
    const last = Array.from(this.streams.values()).pop();
    last?.(message);
  }
}

function success(id: string, data: unknown): IpcResponse {
  return { v: IPC_PROTOCOL_VERSION, id, ok: true, data };
}

function failure(id: string, code: IpcError["code"], message: string, reason?: string): IpcResponse {
  return {
    v: IPC_PROTOCOL_VERSION,
    id,
    ok: false,
    error: { code, message, retryable: false, ...(reason === undefined ? {} : { reason }) },
  };
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && typeof (value as Promise<unknown>).then === "function";
}

/** A handler's explicit protocol failure (MockTransport.fail). */
class MockFailure extends Error {
  public readonly error: { code: string; message: string; reason?: string };
  constructor(error: { code: string; message: string; reason?: string }) {
    super(error.message);
    this.error = error;
  }
}

function withTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
  request: IpcRequest,
): Promise<unknown> {
  return Promise.race([
    promise.then((result) => success(request.id, result)),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new IpcTimeoutError(request.op, request.id)), timeoutMs),
    ),
  ]);
}
