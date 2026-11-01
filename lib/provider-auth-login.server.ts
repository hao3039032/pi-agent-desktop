import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { invalidateModelsCache } from "./models-cache";
import { createModelRuntimeWithExtensions } from "./model-runtime";
import { oauthLoginOptions } from "./oauth-login-options";

/**
 * The OAuth/device-code login flows for the management instance's
 * auth.login* ops (migration M3): the stateful half of the old
 * GET/POST /api/auth/login/[provider] pair, restructured for the
 * management protocol.
 *
 * The old SSE route ran ModelRuntime.login() with a prompt/notify shim and
 * streamed every prompt/notification to the WebView; the answers came back
 * through the POST route keyed by a random token. Over IPC the SAME
 * interaction runs inside the management child: the flow buffers its events
 * (auth.loginPoll drains them by sequence) and auth.loginSubmit answers a
 * pending prompt through the same token discipline (crypto.randomUUID,
 * "<provider>-<uuid>", one pending manual request reused until it
 * resolves — the GET route's exact semantics, select/text prompts each
 * minting their own).
 *
 * Everything user-visible is the old route's wire shape: the event objects
 * below are the SSE `data:` payloads verbatim, and the refusal messages are
 * the POST route's 404/400 bodies. The device-code and loopback-callback
 * flows themselves run inside the SDK (pi-ai's own callback server), inside
 * this child — no app HTTP server exists on any path.
 *
 * The host (src-tauri/src/provider_auth.rs) owns the flow id and drives
 * polling. Losing an observer does not prove the credential writer stopped.
 */

/** The SSE `data:` payloads of the old login stream, verbatim. */
export type OAuthLoginEvent =
  | { type: "auth"; url: string; instructions: string | null; token: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds: number | null;
      expiresInSeconds: number | null;
    }
  | { type: "prompt_request"; message: string; placeholder: string | null; token: string }
  | { type: "select_request"; message: string; options: { id: string; label: string }[]; token: string }
  | { type: "progress"; message: string }
  | { type: "success" }
  | { type: "error"; message: string }
  | { type: "cancelled" };

/** The old POST route's shaped answers for a submitted code. */
export type OAuthLoginSubmitResult =
  | { status: "accepted" }
  | { status: "no_pending"; message: string }
  | { status: "provider_mismatch"; message: string };

export interface QueuedLoginEvent {
  seq: number;
  event: OAuthLoginEvent;
}

/** At most this many concurrent flows; never evict an active writer. */
const MAX_FLOWS = 8;
/** A bounded buffer: a real login is a few dozen events at most. */
const MAX_EVENTS = 512;
/** Finished flows kept for late polls (bounded; the terminal event survives). */
const MAX_FINISHED = 16;

/** One minted handshake token and the prompt awaiting its answer. */
interface PendingPrompt {
  token: string;
  provider: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

interface LoginFlow {
  provider: string;
  /** Monotonic per-flow sequence; the host resumes polls with the last it saw. */
  seq: number;
  events: QueuedLoginEvent[];
  done: boolean;
  /** One manual-code handshake at a time, reused across auth_url events. */
  pendingManual: { pending: PendingPrompt; answer: Promise<string> } | undefined;
  /** Every token this flow minted (finish rejects what the flow still owes). */
  liveTokens: Set<PendingPrompt>;
  abort: AbortController;
  lastPolled: number;
  inputCleaner?: () => void;
}

const flows = new Map<string, LoginFlow>();
const finishedFlows = new Map<string, LoginFlow>();
/** Every live token across flows: the old route's global registry. */
const tokens = new Map<string, PendingPrompt>();

function enqueue(flow: LoginFlow, event: OAuthLoginEvent): void {
  if (flow.done) return;
  flow.seq += 1;
  flow.events.push({ seq: flow.seq, event });
  if (flow.events.length > MAX_EVENTS) {
    // Overflow ends the flow with the old stream's error shape; the buffer
    // keeps the newest MAX_EVENTS entries for the poller's post-mortem.
    flow.events.splice(0, flow.events.length - MAX_EVENTS);
    finishFlow(flow, { type: "error", message: "Login event buffer overflow" });
  }
}

/** Record the terminal event, abort the login, reject every token still owed. */
function finishFlow(flow: LoginFlow, terminal: OAuthLoginEvent): void {
  if (flow.done) return;
  flow.done = true;
  flow.seq += 1;
  flow.events.push({ seq: flow.seq, event: terminal });
  flow.abort.abort();
  if (flow.inputCleaner) {
    flow.inputCleaner();
    flow.inputCleaner = undefined;
  }
  for (const pending of flow.liveTokens) {
    if (!pending.settled) {
      pending.settled = true;
      tokens.delete(pending.token);
      pending.reject(new Error("Login cancelled"));
    }
  }
  flow.liveTokens.clear();
}

/** The old route's createClientInputRequest: mint a token + its promise. */
function mintPrompt(flow: LoginFlow): { pending: PendingPrompt; answer: Promise<string> } {
  // Manual-code handshake token; crypto randomness so a pending OAuth
  // manual flow cannot be hijacked by predicting Math.random().
  const token = `${flow.provider}-${randomUUID()}`;
  let settle: (value: string | PromiseLike<string>) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const answer = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const pending: PendingPrompt = {
    token,
    provider: flow.provider,
    resolve: (value) => {
      if (pending.settled) return;
      pending.settled = true;
      tokens.delete(token);
      settle(value);
    },
    reject: (error) => {
      if (pending.settled) return;
      pending.settled = true;
      tokens.delete(token);
      fail(error);
    },
    settled: false,
  };
  tokens.set(token, pending);
  flow.liveTokens.add(pending);
  return { pending, answer };
}

/** Retire a finished flow, keeping its terminal events for late polls. */
function retireFlow(flowId: string, flow: LoginFlow): void {
  flows.delete(flowId);
  finishedFlows.set(flowId, flow);
  while (finishedFlows.size > MAX_FINISHED) {
    const oldest = finishedFlows.keys().next().value;
    if (typeof oldest !== "string") break;
    finishedFlows.delete(oldest);
  }
}

export interface StartLoginFlowResultStarted {
  started: true;
  promise: Promise<{ success: true }>;
}

export interface StartLoginFlowResultRefused {
  started: false;
  message: string;
}

export type StartLoginFlowResult = StartLoginFlowResultStarted | StartLoginFlowResultRefused;

/** Desensitize events before reporting host-level task progress: strip tokens, URLs and query parameters. */
function desensitizeProgress(event: OAuthLoginEvent, provider: string): Record<string, unknown> {
  switch (event.type) {
    case "auth":
      return { type: "auth", provider, hasInstructions: Boolean(event.instructions) };
    case "device_code":
      return { type: "device_code", provider };
    case "prompt_request":
      return { type: "prompt_request", provider };
    case "select_request":
      return { type: "select_request", provider, optionCount: event.options.length };
    case "progress":
      return { type: "progress", provider };
    case "success":
      return { type: "success", provider };
    case "error":
      return { type: "error", provider };
    case "cancelled":
      return { type: "cancelled", provider };
  }
}

/**
 * auth.loginStart: validate the provider and begin the flow. The flowId is
 * the HOST's (never accepted from the WebView); a duplicate id refuses.
 *
 * When an operation context (opContext) is provided from the management host,
 * the task guard is held for the flow's real lifetime via flow.promise.
 * opContext.signal provides cooperative task cancellation, and opContext.progress
 * delivers desensitized progress without leaking credentials or tokens.
 */
export async function startLoginFlow(
  flowId: string,
  provider: string,
  opContext?: { signal?: AbortSignal; progress?: (value: unknown) => void; onInput?: (handler: ((data: unknown) => OAuthLoginSubmitResult) | null) => void },
): Promise<StartLoginFlowResult> {
  if (flows.has(flowId)) return { started: false, message: "A login flow is already running" };
  const modelRuntime = await createModelRuntimeWithExtensions();
  if (!modelRuntime.getProvider(provider)?.auth.oauth) {
    return { started: false, message: `Unknown provider: ${provider}` };
  }
  // Recheck after the asynchronous runtime load: another start may have
  // occupied this id or the last slot while it was in progress.
  if (flows.has(flowId)) return { started: false, message: "A login flow is already running" };
  if (flows.size >= MAX_FLOWS) return { started: false, message: "Login capacity exhausted" };
  const flow: LoginFlow = {
    provider,
    seq: 0,
    events: [],
    done: false,
    pendingManual: undefined,
    liveTokens: new Set(),
    abort: new AbortController(),
    lastPolled: Date.now(),
  };
  flows.set(flowId, flow);

  // Link cooperative task cancellation signal if provided
  if (opContext?.signal) {
    if (opContext.signal.aborted) {
      cancelLoginFlow(flowId);
    } else {
      opContext.signal.addEventListener("abort", () => {
        cancelLoginFlow(flowId);
      }, { once: true });
    }
  }

  // Register task-associated input handler for interactive code/selection control
  if (opContext?.onInput && !flow.done) {
    opContext.onInput((data: unknown) => {
      if (typeof data !== "object" || data === null) {
        throw new Error("input data must be an object");
      }
      const record = data as Record<string, unknown>;
      const { provider: prov, token, code } = record;
      if (typeof prov !== "string" || typeof token !== "string" || typeof code !== "string" || !prov || !token || !code) {
        throw new Error("provider, token, and code are required");
      }
      const pending = tokens.get(token);
      if (!pending || !flow.liveTokens.has(pending) || flow.done) {
        return { status: "no_pending", message: "No pending login for token" };
      }
      return submitLoginCode(prov, token, code);
    });
    flow.inputCleaner = () => opContext.onInput?.(null);
  }

  // Report initial desensitized progress to establish task liveness
  opContext?.progress?.(desensitizeProgress({ type: "progress", message: "Connecting" }, provider));

  const getManualInputRequest = (): { pending: PendingPrompt; answer: Promise<string> } => {
    // One manual-code handshake reused across auth_url + manual_code (the
    // GET route's dedup: the paste panel's token answers the SDK prompt).
    if (!flow.pendingManual || flow.pendingManual.pending.settled) {
      const minted = mintPrompt(flow);
      flow.pendingManual = minted;
      minted.answer
        .finally(() => {
          if (flow.pendingManual === minted) flow.pendingManual = undefined;
        })
        .catch(() => {});
    }
    return flow.pendingManual;
  };

  const promise = (async () => {
    try {
      await modelRuntime.login(provider, "oauth", {
        signal: flow.abort.signal,
        prompt: async (prompt: AuthPrompt) => {
          const manual = prompt.type === "manual_code";
          const minted = manual ? getManualInputRequest() : mintPrompt(flow);
          if (prompt.type === "select") {
            const selectEvent: OAuthLoginEvent = {
              type: "select_request",
              message: prompt.message,
              options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
              token: minted.pending.token,
            };
            enqueue(flow, selectEvent);
            opContext?.progress?.(desensitizeProgress(selectEvent, provider));
          } else {
            const promptEvent: OAuthLoginEvent = {
              type: "prompt_request",
              message: prompt.message,
              placeholder: prompt.placeholder ?? null,
              token: minted.pending.token,
            };
            enqueue(flow, promptEvent);
            opContext?.progress?.(desensitizeProgress(promptEvent, provider));
          }
          flow.lastPolled = Date.now();
          return minted.answer;
        },
        notify: (event: AuthEvent) => {
          if (event.type === "auth_url") {
            const authEvt: OAuthLoginEvent = {
              type: "auth",
              url: event.url,
              instructions: event.instructions ?? null,
              token: getManualInputRequest().pending.token,
            };
            enqueue(flow, authEvt);
            opContext?.progress?.(desensitizeProgress(authEvt, provider));
          } else if (event.type === "device_code") {
            const devEvt: OAuthLoginEvent = {
              type: "device_code",
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              intervalSeconds: event.intervalSeconds ?? null,
              expiresInSeconds: event.expiresInSeconds ?? null,
            };
            enqueue(flow, devEvt);
            opContext?.progress?.(desensitizeProgress(devEvt, provider));
          } else {
            const progEvt: OAuthLoginEvent = { type: "progress", message: event.message };
            enqueue(flow, progEvt);
            opContext?.progress?.(desensitizeProgress(progEvt, provider));
          }
          flow.lastPolled = Date.now();
        },
      }, oauthLoginOptions());

      invalidateModelsCache();
      finishFlow(flow, { type: "success" });
      opContext?.progress?.(desensitizeProgress({ type: "success" }, provider));
      return { success: true as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isCancelled = message === "Login cancelled" || flow.abort.signal.aborted || opContext?.signal?.aborted;
      finishFlow(flow, isCancelled ? { type: "cancelled" } : { type: "error", message });
      opContext?.progress?.(desensitizeProgress(isCancelled ? { type: "cancelled" } : { type: "error", message }, provider));
      if (isCancelled) {
        const err = new Error("Login cancelled");
        (err as any).code = "cancelled";
        throw err;
      }
      throw new Error("Login failed");
    } finally {
      retireFlow(flowId, flow);
    }
  })();

  // Attach a no-op rejection sink to prevent unhandledRejection in runtimes
  // that inspect flow.started without awaiting flow.promise.
  promise.catch(() => {});

  return { started: true, promise };
}

/**
 * auth.loginPoll: the events with seq > since, plus whether the flow has
 * ended. An unknown id answers done (the child recycled mid-flow; the host
 * turns that into the stream's "Connection lost").
 */
export function pollLoginFlow(
  flowId: string,
  since: number,
): { events: QueuedLoginEvent[]; lastSeq: number; done: boolean } {
  const flow = flows.get(flowId) ?? finishedFlows.get(flowId);
  if (!flow) return { events: [], lastSeq: since, done: true };
  flow.lastPolled = Date.now();
  const events = flow.events.filter((queued) => queued.seq > since);
  return { events, lastSeq: flow.seq, done: flow.done };
}

/**
 * auth.loginSubmit: the old POST route's body — answer a pending token.
 * Tokens are provider-prefixed; a token from another provider's flow
 * refuses (the route's 400), an unknown token its 404.
 */
export function submitLoginCode(
  provider: string,
  token: string,
  code: string,
): OAuthLoginSubmitResult {
  const pending = tokens.get(token);
  if (!pending) return { status: "no_pending", message: "No pending login for token" };
  if (!token.startsWith(`${provider}-`)) {
    return { status: "provider_mismatch", message: "Token does not match provider" };
  }
  pending.resolve(code);
  return { status: "accepted" };
}

/** auth.loginCancel: abort the flow (the user closed the panel). */
export function cancelLoginFlow(flowId: string): boolean {
  const flow = flows.get(flowId);
  if (!flow) return false;
  // Retire only in the login promise's finally: aborting interaction does
  // not prove the credential writer has unwound or released its slot.
  finishFlow(flow, { type: "cancelled" });
  return true;
}
