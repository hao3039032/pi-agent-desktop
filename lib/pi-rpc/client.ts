/**
 * JSONL RPC client for a `pi --mode rpc` child process (pi >= 1.4.0).
 *
 * Protocol: one complete JSON object per line on stdin/stdout (strict LF
 * framing; docs/rpc.md warns that Node's readline also splits on U+2028 and
 * U+2029, which are valid inside JSON strings, so framing is done by hand on
 * \n only). Three record families arrive on stdout:
 *
 *   - `response` records, correlated to our commands by `id`
 *   - session events (agent_start, message_*, agent_settled, ...) with no id
 *   - `extension_ui_request` records, answered via `respondUi()`
 *
 * Diagnostics go to stderr and are surfaced through the `onLog` hook; they
 * are never protocol data. Closing stdin asks pi for an orderly shutdown;
 * unexpected exit is reported through `onExit` and rejects pending commands.
 */

import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface PiRpcCommandResponse<T = unknown> {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export type PiRpcRecord = Record<string, unknown> & { type?: string };

export interface PiRpcClientOptions {
  /** Extra CLI arguments after `--mode rpc` (e.g. `--cwd`, `--no-session`). */
  args?: string[];
  /** Working directory for the child; defaults to the server's cwd. */
  cwd?: string;
  /** Environment for the child; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** stderr lines and lifecycle notes, for logging. */
  onLog?: (line: string) => void;
  /** Called once when the child exits (orderly or not). */
  onExit?: (code: number | null) => void;
}

interface Pending {
  resolve: (value: PiRpcCommandResponse) => void;
  reject: (error: Error) => void;
  command: string;
  timer: NodeJS.Timeout | undefined;
}

let commandCounter = 0;

export class PiRpcClient {
  private child: ChildProcessByStdio<Writable, Readable, Readable>;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(record: PiRpcRecord) => void>();
  private uiHandlers = new Map<string, (params: PiRpcRecord) => void>();
  private stdoutBuffer = "";
  private exiting = false;
  private exitCode: number | null | undefined;
  private exited = false;
  /** The first fatal transport error, rejected by every pending command. */
  private fatal: Error | undefined;

  constructor(
    executable: string,
    private readonly options: PiRpcClientOptions = {},
  ) {
    this.child = spawn(executable, ["--mode", "rpc", ...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // A GUI app has no console; pi must never flash one on Windows.
      windowsHide: true,
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const text = line.replace(/\r$/, "");
        if (text) this.options.onLog?.(text);
      }
    });
    this.child.on("error", (error: Error) => this.failAll(new Error(`pi process failed to start: ${error.message}`)));
    this.child.on("exit", (code: number | null) => {
      this.exited = true;
      this.exitCode = code ?? null;
      this.failAll(
        this.exiting
          ? new Error(`pi process exited during shutdown (code ${this.exitCode ?? "?"})`)
          : new Error(`pi process exited unexpectedly (code ${this.exitCode ?? "?"})`),
      );
      this.options.onExit?.(this.exitCode);
    });
    // The child keeps the server's event loop alive: a session must never
    // be silently dropped by an idle process, and shutdown is explicit
    // (close()/kill()) from the session manager.
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  /** Subscribe to session events (records without a `response` type). Returns an unsubscribe. */
  onEvent(listener: (record: PiRpcRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to one extension-UI method; the handler's return value is sent back. */
  onUi(method: string, handler: (params: PiRpcRecord) => unknown): () => void {
    this.uiHandlers.set(method, handler);
    return () => this.uiHandlers.delete(method);
  }

  /**
   * Send one command and await its response. `timeoutMs` (default 120s)
   * rejects the command but leaves the session running; a prompt that keeps
   * the agent busy for longer must pass a larger value or `undefined`.
   */
  command<T = unknown>(type: string, data: Record<string, unknown> = {}, timeoutMs: number | undefined = 120_000): Promise<T> {
    if (this.exited || this.fatal) {
      return Promise.reject(this.fatal ?? new Error("pi process has exited"));
    }
    const id = `pi-web-${++commandCounter}-${Date.now().toString(36)}`;
    const record: Record<string, unknown> = { id, type, ...data };
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        command: type,
        timer: timeoutMs === undefined ? undefined : setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`pi RPC '${type}' timed out after ${timeoutMs} ms`));
        }, timeoutMs),
        resolve: (response) => {
          if (response.success) resolve(response.data as T);
          else reject(new Error(response.error ?? `pi RPC '${type}' failed`));
        },
        reject,
      };
      if (pending.timer) pending.timer.unref?.();
      this.pending.set(id, pending);
      this.write(record);
    });
  }

  /** Answer an `extension_ui_request` (dialog methods block in pi until this arrives). */
  respondUi(id: string, payload: Record<string, unknown>): void {
    this.write({ type: "extension_ui_response", id, ...payload });
  }

  /**
   * Orderly shutdown: close stdin, wait for the child to exit. Resolves with
   * the exit code. Force-kills after `graceMs` (default 5s).
   */
  async close(graceMs = 5_000): Promise<number | null> {
    if (this.exited) return this.exitCode ?? null;
    this.exiting = true;
    const exited = new Promise<number | null>((resolve) => {
      this.child.once("exit", (code: number | null) => resolve(code ?? null));
    });
    this.child.stdin!.end();
    const force = setTimeout(() => {
      if (!this.exited) this.child.kill();
    }, graceMs);
    force.unref?.();
    return exited;
  }

  /** Immediate termination for shutdown deadlines. */
  kill(): void {
    this.exiting = true;
    this.child.kill();
  }

  private write(record: Record<string, unknown>): void {
    if (this.child.stdin!.destroyed) return;
    this.child.stdin!.write(JSON.stringify(record) + "\n");
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    // Hand framing on LF only; \r before it is tolerated, U+2028/2029 are data.
    for (;;) {
      const index = this.stdoutBuffer.indexOf("\n");
      if (index < 0) break;
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line.trim()) continue;
      let record: PiRpcRecord;
      try {
        record = JSON.parse(line) as PiRpcRecord;
      } catch {
        this.options.onLog?.(`unparseable rpc line: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(record);
    }
  }

  private dispatch(record: PiRpcRecord): void {
    const type = record.type;
    if (type === "response") {
      const id = typeof record.id === "string" ? record.id : undefined;
      const pending = id ? this.pending.get(id) : undefined;
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(id!);
        pending.resolve(record as unknown as PiRpcCommandResponse);
      }
      return;
    }
    if (type === "extension_ui_request") {
      const id = typeof record.id === "string" ? record.id : undefined;
      const method = typeof record.method === "string" ? record.method : undefined;
      if (id && method) {
        const handler = this.uiHandlers.get(method);
        if (handler) {
          const value = handler(record);
          if (value !== undefined) this.respondUi(id, { value });
        } else {
          // Dialogs must be answered or pi blocks (until its own timeout);
          // an unhandled method gets a cancel so it fails fast upstream.
          this.respondUi(id, { cancelled: true });
        }
      }
      return;
    }
    for (const listener of [...this.listeners]) listener(record);
  }

  private failAll(error: Error): void {
    if (!this.fatal) this.fatal = error;
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
