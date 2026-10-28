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
 *
 * Startup UI: a child raises extension UI while it boots (`session_start`
 * dialogs, startup notifies), i.e. BEFORE the host has a relay to hand them
 * to. Without a window an unregistered dialog is cancelled on the spot, which
 * would silently answer the user's own startup confirm. beginUiAttachWindow()
 * declares an explicit, bounded hold: requests keep their original id and are
 * replayed in arrival order once their handler registers (or cancelled — never
 * approved — when the window ends).
 *
 * One channel opts out of that queue: a handler registered with
 * `bypassQueueWhen` receives its matching records IMMEDIATELY, even while
 * older requests are still held. This exists for the bridge result envelope
 * (see core.ts): the host's own state requests (refreshTools) are answered
 * over notify, so holding those envelopes behind UI whose handler only
 * registers after the requests answered would deadlock the session start for
 * the bridge timeout. It is safe precisely because pi never blocks on a notify
 * — delivering one answers, cancels and reorders nothing user-visible — and
 * everything else (dialogs, plain notifies, status) keeps the ordered replay.
 */

import { type ChildProcessByStdio, spawn, type SpawnOptions } from "node:child_process";
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
  /**
   * Test seam: build the child instead of spawning `executable` directly. The
   * deterministic protocol tests run a fake pi script this way (node cannot be
   * spawned as `pi --mode rpc`: it rejects the leading option).
   */
  spawnChild?: (executable: string, args: string[], options: SpawnOptions) => ChildProcessByStdio<Writable, Readable, Readable>;
}

interface Pending {
  resolve: (value: PiRpcCommandResponse) => void;
  reject: (error: Error) => void;
  command: string;
  timer: NodeJS.Timeout | undefined;
}

/** Dialog methods pi blocks on; every other extension-UI method is fire-and-forget. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** One subscribed extension-UI method. */
interface UiRegistration {
  handler: (params: PiRpcRecord) => unknown;
  /**
   * Deliver a matching record immediately, bypassing the pre-attach window's
   * queue, even while older requests are still held. Only for host-internal,
   * non-blocking channels whose records pi never blocks on (the bridge result
   * envelope): everything user-visible must keep the arrival-order replay.
   */
  bypassQueueWhen?: (record: PiRpcRecord) => boolean;
}

/** Default bound on requests held by a pre-attach window. */
const UI_ATTACH_MAX_ENTRIES = 64;

export interface UiAttachWindowOptions {
  /** How long child UI may wait for a handler before it is cancelled. */
  timeoutMs: number;
  /** How many requests may wait at once; the oldest is cancelled beyond it. */
  maxEntries?: number;
}

/** One held `extension_ui_request`, with the id and deadline it was raised with. */
interface BufferedUiRequest {
  record: PiRpcRecord;
  id: string;
  method: string;
  /** The dialog's own `timeout` (ms from arrival), if the child sent one. */
  timeoutMs: number | undefined;
  /** Absolute time the window cancels this request if no handler takes it. */
  deadline: number;
}

let commandCounter = 0;

export class PiRpcClient {
  private child: ChildProcessByStdio<Writable, Readable, Readable>;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(record: PiRpcRecord) => void>();
  private uiHandlers = new Map<string, UiRegistration>();
  /** The open pre-attach window; absent means unregistered dialogs cancel at once. */
  private uiWindow: { deadline: number; maxEntries: number; timer: NodeJS.Timeout } | undefined;
  private uiBuffer: BufferedUiRequest[] = [];
  /** Set while replaying, so a handler that registers another cannot reorder. */
  private uiFlushing = false;
  private exitListeners = new Set<(code: number | null) => void>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private droppingStderrLine = false;
  private exiting = false;
  private exitCode: number | null | undefined;
  private exitSignal: NodeJS.Signals | null = null;

  get terminationSignal(): NodeJS.Signals | null { return this.exitSignal; }
  private exited = false;
  /** Set when the child never spawned (ENOENT/EACCES): no 'exit' will follow. */
  private spawnFailed = false;
  /** The first fatal transport error, rejected by every pending command. */
  private fatal: Error | undefined;

  constructor(
    executable: string,
    private readonly options: PiRpcClientOptions = {},
  ) {
    const args = ["--mode", "rpc", ...(options.args ?? [])];
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // A GUI app has no console; pi must never flash one on Windows.
      windowsHide: true,
    };
    this.child = options.spawnChild
      ? options.spawnChild(executable, args, spawnOptions)
      : spawn(executable, args, spawnOptions) as ChildProcessByStdio<Writable, Readable, Readable>;
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => this.onStderr(chunk));
    this.child.stderr!.on("end", () => {
      if (this.stderrBuffer && !this.droppingStderrLine) this.options.onLog?.(this.stderrBuffer);
      this.stderrBuffer = "";
    });
    this.child.on("error", (error: Error) => {
      // A failed spawn emits 'error' and never 'exit'. kill() on a child that
      // already exited can emit a second error; by then fatal/exited are set
      // and this must not relabel the diagnostics as a spawn failure.
      if (!this.fatal && !this.exited) {
        this.spawnFailed = true;
        this.failAll(new Error(`pi process failed to start: ${error.message}`));
      }
    });
    this.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.exitSignal = signal;
      this.exited = true;
      this.exitCode = code ?? null;
      // No one is left to answer: drop the held UI without a response (the
      // child is gone, and writing a cancel to its dead pipe only risks EPIPE).
      this.discardUiBuffer();
      this.failAll(
        this.exiting
          ? new Error(`pi process exited during shutdown (code ${this.exitCode ?? "?"})`)
          : new Error(`pi process exited unexpectedly (code ${this.exitCode ?? "?"})`),
      );
      this.options.onExit?.(this.exitCode);
      for (const listener of [...this.exitListeners]) listener(this.exitCode);
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

  /**
   * Subscribe to one extension-UI method; the handler's return value is sent
   * back. `bypassQueueWhen` (optional) claims immediate delivery for matching
   * records even while the pre-attach window still holds older ones — for the
   * host-internal bridge result channel only; user-visible UI must not use it.
   */
  onUi(
    method: string,
    handler: (params: PiRpcRecord) => unknown,
    options?: { bypassQueueWhen?: (record: PiRpcRecord) => boolean },
  ): () => void {
    this.uiHandlers.set(method, {
      handler,
      ...(options?.bypassQueueWhen ? { bypassQueueWhen: options.bypassQueueWhen } : {}),
    });
    this.flushBufferedUi();
    return () => this.uiHandlers.delete(method);
  }

  /** How many child-UI requests are waiting for a handler (diagnostics and tests). */
  get pendingUiRequests(): number {
    return this.uiBuffer.length;
  }

  /**
   * Hold child UI raised before the relay exists, for at most `timeoutMs`.
   * Requests keep their original id and are replayed in arrival order as their
   * handlers register; whatever the deadline leaves is cancelled, never
   * approved. Calling it while a window is open replaces that window.
   */
  beginUiAttachWindow(options: UiAttachWindowOptions): void {
    this.endUiAttachWindow();
    const timeoutMs = Math.max(1, options.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => this.endUiAttachWindow(), timeoutMs);
    timer.unref?.();
    this.uiWindow = {
      deadline,
      maxEntries: Math.max(1, options.maxEntries ?? UI_ATTACH_MAX_ENTRIES),
      timer,
    };
  }

  /**
   * Close the window: replay what has a handler (in arrival order), then cancel
   * the rest. Idempotent, so a deadline firing after the host ended the window
   * itself changes nothing.
   */
  endUiAttachWindow(): void {
    const window = this.uiWindow;
    if (!window) return;
    this.uiWindow = undefined;
    clearTimeout(window.timer);
    this.flushBufferedUi();
    // No handler ever arrived for these: a dialog is cancelled (pi resolves it
    // as undefined/false — never as the approval we would otherwise invent).
    const now = Date.now();
    for (const entry of this.uiBuffer.splice(0)) {
      if (entry.deadline > now) {
        this.options.onLog?.(`startup UI window closed before its deadline; cancelled ${entry.method} ${entry.id}`);
      }
      this.cancelBufferedUi(entry);
    }
  }

  /** Multi-listener child-exit subscription (`options.onExit` stays single-slot). */
  onProcessExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    if (this.exited) listener(this.exitCode ?? null);
    return () => this.exitListeners.delete(listener);
  }

  /**
   * Send one command and await its response. `timeoutMs` (default 120s)
   * rejects the command but leaves the session running; a prompt that keeps
   * the agent busy for longer must pass a larger value or `undefined`.
   */
  command<T = unknown>(type: string, data: Record<string, unknown> = {}, timeoutMs: number | undefined = 120_000): Promise<T> {
    if (this.exiting || this.exited || this.fatal) {
      return Promise.reject(this.fatal ?? new Error("pi process is closing or has exited"));
    }
    // A caller-supplied `data.id` (executeBash's bashId) IS the correlation id:
    // pi echoes it on the response and on bash_execution_update events, so it
    // must not be replaced by a generated one. A non-string id would be
    // spread back over ours and lose correlation — reject it here.
    if (data.id !== undefined && typeof data.id !== "string") {
      throw new Error(`command '${type}' id must be a string, got ${typeof data.id}`);
    }
    const id = typeof data.id === "string" && data.id ? data.id : `pi-web-${++commandCounter}-${Date.now().toString(36)}`;
    const record: Record<string, unknown> = { ...data, type, id };
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
    this.endUiAttachWindow();
    // A child that never spawned (ENOENT/EACCES) emits 'error' without any
    // 'exit'; resolving here keeps shutdown paths from hanging on it.
    if (this.spawnFailed) return null;
    const exited = new Promise<number | null>((resolve) => {
      const finish = (code: number | null | undefined) => resolve(code ?? null);
      this.child.once("exit", finish);
      this.child.once("error", () => finish(null));
    });
    if (!this.child.stdin!.writableEnded) this.child.stdin!.end();
    const force = setTimeout(() => {
      // kill() on a child without a pid is a no-op that emits 'error'; the
      // race above already resolved in that case.
      if (!this.exited && this.child.pid !== undefined) this.child.kill();
    }, graceMs);
    force.unref?.();
    return exited;
  }

  /** Immediate termination for shutdown deadlines. */
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.exiting = true;
    this.endUiAttachWindow();
    this.child.kill(signal);
  }

  private write(record: Record<string, unknown>): void {
    // After close() ended stdin (or during shutdown), a write would throw
    // ERR_STREAM_WRITE_AFTER_END; fire-and-forget commands and UI responses
    // may still arrive there, so drop them instead.
    const stdin = this.child.stdin!;
    if (stdin.destroyed || stdin.writableEnded || this.exiting) return;
    stdin.write(JSON.stringify(record) + "\n");
  }

  private onStderr(chunk: string): void {
    // Frame before redaction: credentials split across pipe chunks must never
    // be logged as two unrecognizable fragments. Drop oversized lines whole.
    const parts = chunk.split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (!this.droppingStderrLine) {
        if (this.stderrBuffer.length + parts[index].length > 16_384) {
          this.stderrBuffer = "";
          this.droppingStderrLine = true;
        } else this.stderrBuffer += parts[index];
      }
      if (index < parts.length - 1) {
        if (this.droppingStderrLine) this.options.onLog?.("[stderr line omitted: exceeds diagnostic limit]");
        else if (this.stderrBuffer) this.options.onLog?.(this.stderrBuffer.replace(/\r$/, ""));
        this.stderrBuffer = "";
        this.droppingStderrLine = false;
      }
    }
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
        const registration = this.uiHandlers.get(method);
        if (registration && this.bypassesQueue(registration, record)) {
          // A host-internal channel (the bridge result envelope): deliver at
          // once even while older UI is held, or the startup window would
          // stall host requests behind UI whose handler only registers after
          // those very requests answered. pi never blocks on a notify, so this
          // answers, cancels and reorders nothing the ordered replay protects.
          this.deliverUiRequest(record, id, registration.handler);
          return;
        }
        const handler = registration?.handler;
        // Arrival order is absolute: while anything is held, a new request
        // joins the queue even if its handler is already registered, or a
        // later dialog would jump ahead of an earlier one still waiting.
        if (this.uiBuffer.length > 0 || !handler) {
          if (this.uiWindow) {
            this.bufferUiRequest(record, id, method);
          } else {
            // Dialogs must be answered or pi blocks (until its own timeout);
            // an unhandled method gets a cancel so it fails fast upstream.
            this.respondUi(id, { cancelled: true });
          }
        } else {
          this.deliverUiRequest(record, id, handler);
        }
      }
      return;
    }
    for (const listener of [...this.listeners]) listener(record);
  }

  /** Run one extension-UI handler and answer with what it resolves to. */
  private deliverUiRequest(record: PiRpcRecord, id: string, handler: (params: PiRpcRecord) => unknown): void {
    try {
      const value = handler(record);
      if (value && typeof (value as Promise<unknown>).then === "function") {
        // A relayed dialog handler is async: it waits for the user. pi blocks
        // until the answer arrives, so await the promise instead of answering
        // with the promise object.
        (value as Promise<Record<string, unknown> | undefined>).then(
          (resolved) => {
            if (resolved !== undefined) this.respondUi(id, resolved);
          },
          () => this.respondUi(id, { cancelled: true }),
        );
      } else if (value !== undefined) {
        this.respondUi(id, value as Record<string, unknown>);
      }
    } catch {
      this.respondUi(id, { cancelled: true });
    }
  }

  private bufferUiRequest(record: PiRpcRecord, id: string, method: string): void {
    const window = this.uiWindow!;
    // The child's own dialog timeout (if any) is authoritative: the replay
    // must not deliver an entry pi already gave up on, and the relay must
    // see the remaining lifetime, not a reset one.
    const timeout = typeof record.timeout === "number" && record.timeout > 0 ? record.timeout : undefined;
    this.uiBuffer.push({ record, id, method, timeoutMs: timeout, deadline: window.deadline });
    while (this.uiBuffer.length > window.maxEntries) {
      // Oldest first: overflow must never invert the arrival order the rest of
      // the replay keeps.
      const evicted = this.uiBuffer.shift()!;
      this.options.onLog?.(`startup UI overflow: cancelled ${evicted.method} ${evicted.id}`);
      this.cancelBufferedUi(evicted);
    }
  }

  /**
   * Replay held requests in ARRIVAL order, stopping at the first method whose
   * handler is not registered yet: letting a later request through would
   * deliver startup UI out of order once handlers register one at a time.
   */
  private flushBufferedUi(): void {
    if (this.uiFlushing) return;
    this.uiFlushing = true;
    try {
      while (this.uiBuffer.length > 0) {
        const entry = this.uiBuffer[0];
        // pi already timed this dialog out (its own `timeout`, kept from
        // arrival): answering late would be a response it never asked for.
        if (this.bufferedEntryExpired(entry)) {
          this.uiBuffer.shift();
          this.options.onLog?.(`startup UI expired before replay; cancelled ${entry.method} ${entry.id}`);
          this.cancelBufferedUi(entry);
          continue;
        }
        const handler = this.uiHandlers.get(entry.method)?.handler;
        if (!handler) return;
        this.uiBuffer.shift();
        this.deliverUiRequest(entry.record, entry.id, handler);
      }
    } finally {
      this.uiFlushing = false;
    }
  }

  /** A held entry is dead once its own dialog timeout elapsed. */
  private bufferedEntryExpired(entry: BufferedUiRequest): boolean {
    return entry.timeoutMs !== undefined && Date.now() >= entry.timeoutMs;
  }

  /** Whether this registration claims immediate delivery for the record. */
  private bypassesQueue(registration: UiRegistration, record: PiRpcRecord): boolean {
    if (!registration.bypassQueueWhen) return false;
    try {
      return registration.bypassQueueWhen(record) === true;
    } catch {
      // A throwing predicate must never break the dispatch loop; the record
      // falls back to the ordinary ordered path.
      return false;
    }
  }

  private cancelBufferedUi(entry: BufferedUiRequest): void {
    // Fire-and-forget methods expect no answer; an unsolicited response would
    // be a record the child never asked for.
    if (DIALOG_METHODS.has(entry.method)) this.respondUi(entry.id, { cancelled: true });
  }

  /** Drop held UI without answering (the child is gone or shutting down). */
  private discardUiBuffer(): void {
    const window = this.uiWindow;
    this.uiWindow = undefined;
    if (window) clearTimeout(window.timer);
    this.uiBuffer.splice(0);
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
