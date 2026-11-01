import { randomUUID } from "node:crypto";
import type { McpHostedCallbackFactory } from "./mcp-oauth-hosted.server";

type Pending = {
  id: string;
  kind: "bind" | "wait";
  request: Record<string, unknown>;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  cleanup(): void;
};

/** Internal task-bound request/response channel. Never expose `request` to the UI. */
export class McpOAuthBroker {
  private pending?: Pending;
  private stopped = false;

  get request(): Record<string, unknown> | undefined { return this.pending?.request; }

  private ask(kind: Pending["kind"], payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (this.stopped || signal.aborted) return Promise.reject(new Error("Sign-in cancelled"));
    if (this.pending) return Promise.reject(new Error("Callback request already pending"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        if (this.pending?.id === id) this.pending = undefined;
        reject(new Error("Sign-in cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending = { id, kind, request: { id, kind, ...payload }, resolve, reject, cleanup: () => signal.removeEventListener("abort", abort) };
      if (signal.aborted) abort();
    });
  }

  /** Only the current request can be resolved; stale and duplicate replies fail. */
  respond(input: unknown): boolean {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
    const value = input as Record<string, unknown>;
    const pending = this.pending;
    if (!pending || value.id !== pending.id || value.kind !== pending.kind) return false;
    this.pending = undefined;
    pending.cleanup();
    if (value.ok === false) pending.reject(new Error(typeof value.error === "string" ? value.error.slice(0, 500) : "Callback listener failed"));
    else if (value.ok === true) pending.resolve(value);
    else { pending.reject(new Error("Invalid callback response")); }
    return true;
  }

  close(): void {
    this.stopped = true;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { pending.cleanup(); pending.reject(new Error("Sign-in cancelled")); }
  }

  readonly start: McpHostedCallbackFactory = async (options, signal) => {
    const bound = await this.ask("bind", options, signal);
    if (typeof bound.redirectUrl !== "string") throw new Error("Invalid callback bind response");
    const redirectUrl = bound.redirectUrl;
    return {
      redirectUrl,
      wait: async (state, redirect, waitSignal) => {
        const answer = await this.ask("wait", { state, redirectUrl: redirect.href }, waitSignal);
        if (typeof answer.code !== "string" || !answer.code || (answer.iss !== undefined && typeof answer.iss !== "string")) {
          throw new Error("Invalid callback response");
        }
        return { code: answer.code, ...(typeof answer.iss === "string" ? { iss: answer.iss } : {}) };
      },
      close: () => this.close(),
    };
  };
}
